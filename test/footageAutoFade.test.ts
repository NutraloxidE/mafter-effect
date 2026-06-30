import { describe, expect, it } from "vitest";
import {
  autoFadeMultiplier,
  autoFadeMultiplierAtFrame,
  collectFadeClips,
  computeFadeSuppression,
  DEFAULT_AUTO_FADE_MS,
  fadeCurveSamples,
  fadeEase,
  fadeSec,
  isAutoFadeEnabled,
  scheduleDeclickRamps,
  type FadeClip,
  type RampableParam,
} from "../src/runtime/footageAutoFade";
import type { TimelineComposition } from "../src/core/schema";

// §11.5.2 カット端のポップ音防止 自動フェード（declick）— 純関数の固定。

describe("computeFadeSuppression — §11.4 シームレス境界の二重フェード抑制", () => {
  const A = (objectId: string, inPoint: number, outPoint: number, trimStart: number): FadeClip => ({
    objectId,
    assetId: "asset-A",
    inPoint,
    outPoint,
    trimStart,
  });

  it("同一アセットがソース時刻を連続継承する隣接境界は in/out を抑制する", () => {
    // C1: in0..out60 trim0（読み出し 0→60）, C2: in60..out150 trim60（読み出し 60→継続）。
    const sup = computeFadeSuppression([A("c1", 0, 60, 0), A("c2", 60, 150, 60)]);
    expect(sup.get("c1")).toEqual({ in: false, out: true }); // c1→c2 が連続 → c1 の out 抑制
    expect(sup.get("c2")).toEqual({ in: true, out: false }); // c2 の in 抑制
  });

  it("隣接でも読み出し位置が不連続（trim ジャンプ）なら抑制しない", () => {
    // c2 が trim0 から再開 = 内容が飛ぶ → 本当のカット端なのでフェードする。
    const sup = computeFadeSuppression([A("c1", 0, 60, 0), A("c2", 60, 150, 0)]);
    expect(sup.get("c1")).toEqual({ in: false, out: false });
    expect(sup.get("c2")).toEqual({ in: false, out: false });
  });

  it("隙間がある（非隣接）なら抑制しない", () => {
    const sup = computeFadeSuppression([A("c1", 0, 60, 0), A("c2", 70, 150, 60)]);
    expect(sup.get("c1")).toEqual({ in: false, out: false });
    expect(sup.get("c2")).toEqual({ in: false, out: false });
  });

  it("別アセットの隣接は抑制しない", () => {
    const clips: FadeClip[] = [
      { objectId: "c1", assetId: "A", inPoint: 0, outPoint: 60, trimStart: 0 },
      { objectId: "c2", assetId: "B", inPoint: 60, outPoint: 150, trimStart: 60 },
    ];
    const sup = computeFadeSuppression(clips);
    expect(sup.get("c1")).toEqual({ in: false, out: false });
    expect(sup.get("c2")).toEqual({ in: false, out: false });
  });
});

describe("collectFadeClips", () => {
  it("enabled な audio / video レイヤーのみ asset 付きで列挙する", () => {
    const comp = {
      objects: [
        { id: "v1", enabled: true, inPoint: 0, outPoint: 30, components: [{ type: "video", props: { asset: "A", trimStart: 5 } }] },
        { id: "a1", enabled: true, inPoint: 10, outPoint: 40, components: [{ type: "audio", props: { asset: "B" } }] },
        { id: "off", enabled: false, inPoint: 0, outPoint: 30, components: [{ type: "video", props: { asset: "C" } }] },
        { id: "noasset", enabled: true, inPoint: 0, outPoint: 30, components: [{ type: "video", props: { asset: "" } }] },
        { id: "txt", enabled: true, inPoint: 0, outPoint: 30, components: [{ type: "text", props: {} }] },
      ],
    } as unknown as TimelineComposition;
    const clips = collectFadeClips(comp);
    expect(clips).toEqual([
      { objectId: "v1", assetId: "A", inPoint: 0, outPoint: 30, trimStart: 5 },
      { objectId: "a1", assetId: "B", inPoint: 10, outPoint: 40, trimStart: 0 },
    ]);
  });
});

describe("autoFadeMultiplier — 時間ドメインのエンベロープ（cubic-bezier slow in / fast out）", () => {
  it("クリップ中央はフルゲイン（1）", () => {
    expect(autoFadeMultiplier({ elapsedSec: 1, durSec: 2, fadeSec: 0.03 })).toBe(1);
  });

  it("in 端は 0→1 に立ち上がる（端点は厳密、中間は線形より低い＝slow in）", () => {
    expect(autoFadeMultiplier({ elapsedSec: 0, durSec: 2, fadeSec: 0.04 })).toBe(0);
    expect(autoFadeMultiplier({ elapsedSec: 0.04, durSec: 2, fadeSec: 0.04 })).toBeCloseTo(1, 5);
    const mid = autoFadeMultiplier({ elapsedSec: 0.02, durSec: 2, fadeSec: 0.04 });
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(0.5); // 線形なら 0.5。slow in なのでそれより小さい。
  });

  it("立ち上がりは単調増加", () => {
    const a = autoFadeMultiplier({ elapsedSec: 0.01, durSec: 2, fadeSec: 0.04 });
    const b = autoFadeMultiplier({ elapsedSec: 0.02, durSec: 2, fadeSec: 0.04 });
    const c = autoFadeMultiplier({ elapsedSec: 0.03, durSec: 2, fadeSec: 0.04 });
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("out 端は 1→0 に落ちる（末尾近くは線形より高い＝最後に速く切れる）", () => {
    expect(autoFadeMultiplier({ elapsedSec: 2, durSec: 2, fadeSec: 0.04 })).toBe(0);
    expect(autoFadeMultiplier({ elapsedSec: 1.96, durSec: 2, fadeSec: 0.04 })).toBeCloseTo(1, 5);
    const mid = autoFadeMultiplier({ elapsedSec: 1.98, durSec: 2, fadeSec: 0.04 });
    expect(mid).toBeGreaterThan(0.5); // 線形なら 0.5。最初はゆっくり下がるのでそれより高い。
    expect(mid).toBeLessThan(1);
  });

  it("suppression 指定側はフェードしない", () => {
    expect(autoFadeMultiplier({ elapsedSec: 0, durSec: 2, fadeSec: 0.04, suppression: { in: true, out: false } })).toBe(1);
    expect(autoFadeMultiplier({ elapsedSec: 2, durSec: 2, fadeSec: 0.04, suppression: { in: false, out: true } })).toBe(1);
  });

  it("fadeSec=0 / durSec=0 はフェード無し（1）", () => {
    expect(autoFadeMultiplier({ elapsedSec: 0, durSec: 2, fadeSec: 0 })).toBe(1);
    expect(autoFadeMultiplier({ elapsedSec: 0, durSec: 0, fadeSec: 0.04 })).toBe(1);
  });
});

describe("fadeEase — cubic-bezier slow in / fast out", () => {
  it("端点は 0 と 1", () => {
    expect(fadeEase(0)).toBe(0);
    expect(fadeEase(1)).toBe(1);
    expect(fadeEase(-0.5)).toBe(0);
    expect(fadeEase(1.5)).toBe(1);
  });

  it("単調増加かつ slow in（中央は線形 t を下回る）", () => {
    let prev = -1;
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const v = fadeEase(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(fadeEase(0.5)).toBeLessThan(0.5);
    expect(fadeEase(0.25)).toBeLessThan(0.25);
  });
});

describe("fadeCurveSamples — setValueCurveAtTime 用配列", () => {
  it("昇順カーブは 0→1、降順カーブは 1→0、単調", () => {
    const up = Array.from(fadeCurveSamples(false));
    const down = Array.from(fadeCurveSamples(true));
    expect(up[0]!).toBeCloseTo(0, 6);
    expect(up[up.length - 1]!).toBeCloseTo(1, 6);
    expect(down[0]!).toBeCloseTo(1, 6);
    expect(down[down.length - 1]!).toBeCloseTo(0, 6);
    for (let i = 1; i < up.length; i++) {
      expect(up[i]!).toBeGreaterThanOrEqual(up[i - 1]!);
      expect(down[i]!).toBeLessThanOrEqual(down[i - 1]!);
    }
  });
});

describe("autoFadeMultiplierAtFrame — フレーム中央評価", () => {
  it("低 fps・短フェードでも in/out 端の最初/最後のフレームが減衰する", () => {
    const opts = { inPoint: 0, outPoint: 30, fps: 30 }; // 既定 30ms ≒ 0.9 フレーム
    const first = autoFadeMultiplierAtFrame(0, opts); // 中央 t=0.5/30=0.0166s, fadeSec=0.03 → 0.55
    const last = autoFadeMultiplierAtFrame(29, opts); // out までの残り 0.5/30s → 0.55
    expect(first).toBeLessThan(1);
    expect(last).toBeLessThan(1);
    expect(autoFadeMultiplierAtFrame(15, opts)).toBe(1); // 中央はフル
  });
});

describe("scheduleDeclickRamps — Web Audio 経路（preview/export）", () => {
  function recorder(): { param: RampableParam; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      param: {
        setValueAtTime: (v, t) => calls.push(`set ${v}@${t}`),
        linearRampToValueAtTime: (v, t) => calls.push(`ramp ${v}@${t}`),
      },
    };
  }

  it("in/out 両フェードを打つ（fadeInActive）", () => {
    const { param, calls } = recorder();
    scheduleDeclickRamps(param, { startSec: 1, durSec: 2, fadeSec: 0.04, fadeInActive: true });
    expect(calls).toEqual([
      "set 0@1",
      "ramp 1@1.04",
      "set 1@2.96",
      "ramp 0@3",
    ]);
  });

  it("fadeInActive=false（途中再生開始）は in フェードを打たない", () => {
    const { param, calls } = recorder();
    scheduleDeclickRamps(param, { startSec: 0, durSec: 2, fadeSec: 0.04, fadeInActive: false });
    expect(calls[0]).toBe("set 1@0");
    expect(calls).not.toContain("ramp 1@0.04");
  });

  it("suppression 指定側は打たない", () => {
    const { param, calls } = recorder();
    scheduleDeclickRamps(param, { startSec: 0, durSec: 2, fadeSec: 0.04, fadeInActive: true, suppression: { in: true, out: true } });
    expect(calls).toEqual(["set 1@0"]);
  });

  it("durSec<=0 は安全に 1 を据える", () => {
    const { param, calls } = recorder();
    scheduleDeclickRamps(param, { startSec: 0.5, durSec: 0, fadeSec: 0.04, fadeInActive: true });
    expect(calls).toEqual(["set 1@0.5"]);
  });

  it("setValueCurveAtTime があれば bezier カーブで打つ（in/out）", () => {
    const calls: string[] = [];
    const curves: { start: number; dur: number; first: number; last: number }[] = [];
    const param: RampableParam = {
      setValueAtTime: (v, t) => calls.push(`set ${v}@${t}`),
      linearRampToValueAtTime: (v, t) => calls.push(`ramp ${v}@${t}`),
      setValueCurveAtTime: (vals, start, dur) =>
        curves.push({ start, dur, first: vals[0]!, last: vals[vals.length - 1]! }),
    };
    scheduleDeclickRamps(param, { startSec: 1, durSec: 2, fadeSec: 0.04, fadeInActive: true });
    expect(calls).toEqual([]); // 線形ランプは打たない
    expect(curves).toHaveLength(2);
    const [cin, cout] = curves;
    // in カーブ 0→1
    expect(cin!.start).toBeCloseTo(1, 6);
    expect(cin!.dur).toBeCloseTo(0.04, 6);
    expect(cin!.first).toBeCloseTo(0, 6);
    expect(cin!.last).toBeCloseTo(1, 6);
    // out カーブ 1→0
    expect(cout!.start).toBeCloseTo(2.96, 6);
    expect(cout!.dur).toBeCloseTo(0.04, 6);
    expect(cout!.first).toBeCloseTo(1, 6);
    expect(cout!.last).toBeCloseTo(0, 6);
  });
});

describe("補助", () => {
  it("isAutoFadeEnabled は既定 true・false のみ無効", () => {
    expect(isAutoFadeEnabled({})).toBe(true);
    expect(isAutoFadeEnabled({ autoFade: true })).toBe(true);
    expect(isAutoFadeEnabled({ autoFade: false })).toBe(false);
  });

  it("fadeSec は ms→秒、負は 0", () => {
    expect(fadeSec(30)).toBeCloseTo(0.03, 5);
    expect(fadeSec()).toBeCloseTo(DEFAULT_AUTO_FADE_MS / 1000, 5);
    expect(fadeSec(-5)).toBe(0);
  });
});
