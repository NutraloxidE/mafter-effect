import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "../src/runtime/resolve";
import { compChildFrame } from "../src/runtime/compLayer";
import {
  countKeyframes,
  MAIN1_DURATION,
  MAIN1_FPS,
  MAIN1_USE_SPAN,
  MASTER_FPS,
  makeMasterNestedFixture,
} from "./fixtures/masterNestedFixture";

/**
 * master-nested-composite-performance-plan Phase 0 baseline（§5.3 / §5.4 DoD）。
 *
 * synthetic fixture で「Master 30fps → main 1 15fps」の重複 child frame 構造を固定し、
 * distinct child frame だけを resolve する場合と 531 parent frame を全て resolve する場合の
 * resolve コストを計測する（Phase 5 same-child-frame reuse の上限効果を数値化）。
 *
 * 構造アサーションは常に走る（CI ゲート）。wall-clock は環境依存のため合否条件にせず、
 * BENCH_WRITE=1 のときだけ doc/cloudplan/master-nested-baseline.json に保存する。
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function childFrameSequence(): number[] {
  const seq: number[] = [];
  for (let pf = 0; pf < MAIN1_USE_SPAN; pf++) {
    seq.push(compChildFrame(pf, 0, 0, MAIN1_DURATION, MASTER_FPS, MAIN1_FPS));
  }
  return seq;
}

describe("master-nested baseline — duplicate child-frame structure", () => {
  it("Master [0,531) maps to 266 unique main 1 child frames (265 duplicates, 49.9%)", () => {
    const seq = childFrameSequence();
    const unique = new Set(seq);
    expect(seq.length).toBe(531);
    expect(unique.size).toBe(266);
    const dup = seq.length - unique.size;
    expect(dup).toBe(265);
    expect(dup / seq.length).toBeCloseTo(0.499, 2);
  });

  it("fixture reproduces dense-keyframe scale comparable to the real project (thousands of KFs)", () => {
    const { main1 } = makeMasterNestedFixture();
    const kf = countKeyframes(main1);
    // 実プロジェクト main 1 系 lyric = 23,146。synthetic は同オーダー（数千〜数万）。
    expect(kf).toBeGreaterThan(5000);
    expect(main1.objects.length).toBe(45);
  });
});

describe("master-nested baseline — resolve cost (distinct vs duplicated)", () => {
  it("resolves all distinct + all duplicated child frames and records a baseline", () => {
    const { main1 } = makeMasterNestedFixture();
    const seq = childFrameSequence();
    const distinct = [...new Set(seq)].sort((a, b) => a - b);

    // warm up（JIT・cache 温め）。
    for (const f of distinct) resolve(main1, f);

    const t0 = performance.now();
    for (const f of distinct) resolve(main1, f);
    const distinctMs = performance.now() - t0;

    const t1 = performance.now();
    for (const f of seq) resolve(main1, f);
    const allMs = performance.now() - t1;

    // 健全性: 全 frame を resolve すると distinct のみより必ず多くの仕事をする。
    expect(seq.length).toBeGreaterThan(distinct.length);
    // resolve は決定論（INV-2）: 同一 child frame は同一 object 数を返す。
    const a = resolve(main1, distinct[10]!);
    const b = resolve(main1, distinct[10]!);
    expect(a.objects.length).toBe(b.objects.length);

    const baseline = {
      generatedAt: new Date().toISOString(),
      note: "Phase 0 synthetic baseline. Real 590MB ZIP unreachable from cloud egress; run at your machine for the local-real fixture + final max-ZIP benchmark.",
      structure: {
        masterFps: MASTER_FPS,
        main1Fps: MAIN1_FPS,
        parentUseSpan: MAIN1_USE_SPAN,
        uniqueChildFrames: distinct.length,
        totalChildCalls: seq.length,
        duplicateRatio: (seq.length - distinct.length) / seq.length,
        main1Keyframes: countKeyframes(main1),
        main1Objects: main1.objects.length,
      },
      resolveBaselineMs: {
        distinctChildFrames: Number(distinctMs.toFixed(2)),
        allParentDerivedFrames: Number(allMs.toFixed(2)),
        // Phase 5 same-child-frame reuse が理想的に効いた場合の削減率の上限。
        reuseUpperBoundSaving: Number((1 - distinctMs / allMs).toFixed(3)),
      },
    };

    // eslint-disable-next-line no-console
    console.log("[master-nested baseline]", JSON.stringify(baseline.resolveBaselineMs), "structure:", JSON.stringify(baseline.structure));

    if (process.env.BENCH_WRITE === "1") {
      const out = join(HERE, "..", "doc", "cloudplan", "master-nested-baseline.json");
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(baseline, null, 2) + "\n");
      // eslint-disable-next-line no-console
      console.log("[master-nested baseline] wrote", out);
    }
  });
});
