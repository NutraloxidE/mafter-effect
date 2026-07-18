import { describe, expect, it } from "vitest";
import { sampleAny, sampleRgba, sampleScalar, sampleVec3 } from "../src/runtime/interpolate";
import { easingFn } from "../src/runtime/easing";
import type { AnimatedProp, Easing, Frame, Keyframe, RGBA, Vec3 } from "../src/core/schema";

/**
 * Phase 1 回帰ゲート（master-nested-composite-performance-plan §6.3）。
 * findSegment の線形走査 → 二分探索置換が **完全同値** であることを、旧線形実装を
 * このテスト内に reference として保持し、seeded fuzz で多数ケース照合する。
 */

const EASINGS: Easing[] = [
  { type: "linear" },
  { type: "hold" },
  { type: "bezier", bezier: [0.42, 0, 0.58, 1] },
  { type: "bezier", bezier: [0.25, 0.1, 0.25, 1] },
];

// ---- 旧線形実装（reference・interpolate.ts の置換前ロジックを逐語コピー） ----
function segmentTRef(k0: Keyframe<unknown>, k1: Keyframe<unknown>, frame: Frame): number {
  const span = k1.frame - k0.frame;
  const raw = span <= 0 ? 0 : (frame - k0.frame) / span;
  return easingFn(k0.easing)(raw);
}

function findSegmentLinear<T>(
  kfs: Keyframe<T>[],
  frame: Frame,
): { before: Keyframe<T>; after: Keyframe<T>; t: number } | { hold: T } {
  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  if (frame <= first.frame) return { hold: first.value };
  if (frame >= last.frame) return { hold: last.value };
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (frame >= a.frame && frame <= b.frame) {
      return { before: a, after: b, t: segmentTRef(a, b, frame) };
    }
  }
  return { hold: last.value };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function sampleScalarLinear(prop: AnimatedProp<number>, frame: Frame): number {
  const kfs = prop.keyframes;
  if (kfs.length === 0) return prop.value;
  const seg = findSegmentLinear(kfs, frame);
  return "hold" in seg ? seg.hold : lerp(seg.before.value, seg.after.value, seg.t);
}
function sampleVec3Linear(prop: AnimatedProp<Vec3>, frame: Frame): Vec3 {
  const kfs = prop.keyframes;
  if (kfs.length === 0) return prop.value;
  const seg = findSegmentLinear(kfs, frame);
  if ("hold" in seg) return seg.hold;
  return {
    x: lerp(seg.before.value.x, seg.after.value.x, seg.t),
    y: lerp(seg.before.value.y, seg.after.value.y, seg.t),
    z: lerp(seg.before.value.z, seg.after.value.z, seg.t),
  };
}
function sampleRgbaLinear(prop: AnimatedProp<RGBA>, frame: Frame): RGBA {
  const kfs = prop.keyframes;
  if (kfs.length === 0) return prop.value;
  const seg = findSegmentLinear(kfs, frame);
  if ("hold" in seg) return seg.hold;
  return {
    r: lerp(seg.before.value.r, seg.after.value.r, seg.t),
    g: lerp(seg.before.value.g, seg.after.value.g, seg.t),
    b: lerp(seg.before.value.b, seg.after.value.b, seg.t),
    a: lerp(seg.before.value.a, seg.after.value.a, seg.t),
  };
}

// ---- seeded PRNG（INV-1: Math.random 禁止のため決定論） ----
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeScalarKfs(rng: () => number): AnimatedProp<number> {
  const n = 1 + Math.floor(rng() * 12);
  const frames: number[] = [];
  let f = Math.floor(rng() * 5);
  for (let i = 0; i < n; i++) {
    // 重複 frame をわざと混ぜる（rng<0.25 で前と同じ frame）。
    if (i > 0 && rng() < 0.25) frames.push(frames[frames.length - 1]!);
    else {
      f += Math.floor(rng() * 6); // 0 も出る＝重複
      frames.push(f);
    }
  }
  const keyframes: Keyframe<number>[] = frames.map((fr) => ({
    frame: fr,
    value: Math.round((rng() * 200 - 100) * 100) / 100,
    easing: EASINGS[Math.floor(rng() * EASINGS.length)]!,
  }));
  return { value: 0, keyframes };
}

describe("Phase 1 binary-search findSegment ⇔ linear reference parity (fuzz)", () => {
  it("sampleScalar matches linear over thousands of cases incl. duplicate frames", () => {
    const rng = mulberry32(0xc0ffee);
    let cases = 0;
    for (let iter = 0; iter < 4000; iter++) {
      const prop = makeScalarKfs(rng);
      const last = prop.keyframes[prop.keyframes.length - 1]!.frame;
      for (let frame = -3; frame <= last + 3; frame++) {
        const got = sampleScalar(prop, frame);
        const ref = sampleScalarLinear(prop, frame);
        expect(got).toBe(ref);
        cases++;
      }
    }
    expect(cases).toBeGreaterThan(10000);
  });

  it("sampleVec3 matches linear reference", () => {
    const rng = mulberry32(0x1234);
    for (let iter = 0; iter < 1500; iter++) {
      const base = makeScalarKfs(rng);
      const rngV = mulberry32(iter * 7 + 1);
      const prop: AnimatedProp<Vec3> = {
        value: { x: 0, y: 0, z: 0 },
        keyframes: base.keyframes.map((k) => ({
          frame: k.frame,
          easing: k.easing,
          value: { x: rngV() * 100, y: rngV() * 100, z: rngV() * 100 },
        })),
      };
      const last = prop.keyframes[prop.keyframes.length - 1]!.frame;
      for (let frame = -2; frame <= last + 2; frame++) {
        expect(sampleVec3(prop, frame)).toEqual(sampleVec3Linear(prop, frame));
      }
    }
  });

  it("sampleRgba matches linear reference", () => {
    const rng = mulberry32(0x99);
    for (let iter = 0; iter < 1500; iter++) {
      const base = makeScalarKfs(rng);
      const rngC = mulberry32(iter * 13 + 3);
      const prop: AnimatedProp<RGBA> = {
        value: { r: 0, g: 0, b: 0, a: 1 },
        keyframes: base.keyframes.map((k) => ({
          frame: k.frame,
          easing: k.easing,
          value: { r: rngC(), g: rngC(), b: rngC(), a: rngC() },
        })),
      };
      const last = prop.keyframes[prop.keyframes.length - 1]!.frame;
      for (let frame = -2; frame <= last + 2; frame++) {
        expect(sampleRgba(prop, frame)).toEqual(sampleRgbaLinear(prop, frame));
      }
    }
  });

  it("sampleAny (step/hold path) matches linear for non-interpolable values", () => {
    const rng = mulberry32(0x555);
    for (let iter = 0; iter < 1500; iter++) {
      const base = makeScalarKfs(rng);
      const prop: AnimatedProp<string> = {
        value: "x",
        keyframes: base.keyframes.map((k, i) => ({
          frame: k.frame,
          easing: k.easing,
          value: `v${i}`,
        })),
      };
      const last = prop.keyframes[prop.keyframes.length - 1]!.frame;
      for (let frame = -2; frame <= last + 2; frame++) {
        // reference: linear findSegment on the same string prop
        const kfs = prop.keyframes;
        const seg = findSegmentLinear(kfs, frame);
        const ref = "hold" in seg ? seg.hold : seg.before.value;
        expect(sampleAny(prop, frame)).toBe(ref);
      }
    }
  });

  it("handles 0/1/2 keyframes and extreme frames", () => {
    expect(sampleScalar({ value: 7, keyframes: [] }, 5)).toBe(7);
    const one: AnimatedProp<number> = { value: 0, keyframes: [{ frame: 10, value: 42, easing: { type: "linear" } }] };
    expect(sampleScalar(one, -1e6)).toBe(42);
    expect(sampleScalar(one, 10)).toBe(42);
    expect(sampleScalar(one, 1e6)).toBe(42);
    const two: AnimatedProp<number> = {
      value: 0,
      keyframes: [
        { frame: 0, value: 0, easing: { type: "linear" } },
        { frame: 100, value: 100, easing: { type: "linear" } },
      ],
    };
    for (const f of [-1e9, 0, 1, 50, 99, 100, 1e9]) {
      expect(sampleScalar(two, f)).toBe(sampleScalarLinear(two, f));
    }
  });
});
