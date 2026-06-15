import type { Vec3 } from "../core/schema";

// §9 Expression ヘルパー — 決定論的（INV-1）。
// Math.random / Date.now 禁止。全て seeded または純粋計算。

// ─── Seeded PRNG (mulberry32) ───────────────────────────────────────────────
// seed が同じなら毎回同じ列を返す（INV-1）。
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// シード付き 1 回だけ乱数を返す（expression の random(seed?) 用）。
export function seededOnce(seed: number): number {
  return seededRandom(seed)();
}

// ─── Wiggle ─────────────────────────────────────────────────────────────────
// AE 互換の wiggle: freq Hz で揺らし、amp を振幅とするノイズ。
// time = frame / fps [seconds]。cycle ごとに seeded sample を生成し smoothstep 補間。
// 各 axis は独立した seed オフセットで生成（x=+0, y=+1, z=+2）。

function wiggleScalar(time: number, freq: number, amp: number, baseSeed: number): number {
  if (freq === 0 || amp === 0) return 0;
  const t = time * freq;
  const cycle = Math.floor(t);
  const phase = t - cycle;
  // smoothstep で補間
  const smooth = phase * phase * (3 - 2 * phase);
  const v0 = seededRandom(((baseSeed + cycle * 127) >>> 0))() * 2 - 1;
  const v1 = seededRandom(((baseSeed + (cycle + 1) * 127) >>> 0))() * 2 - 1;
  return (v0 + (v1 - v0) * smooth) * amp;
}

export function wiggleNumber(
  value: number,
  frame: number,
  fps: number,
  freq: number,
  amp: number,
  seed = 0,
): number {
  const time = frame / fps;
  return value + wiggleScalar(time, freq, amp, seed);
}

export function wiggleVec3(
  value: Vec3,
  frame: number,
  fps: number,
  freq: number,
  amp: number,
  seed = 0,
): Vec3 {
  const time = frame / fps;
  return {
    x: value.x + wiggleScalar(time, freq, amp, seed),
    y: value.y + wiggleScalar(time, freq, amp, seed + 1),
    z: value.z + wiggleScalar(time, freq, amp, seed + 2),
  };
}

// ─── 純粋数値ヘルパー ────────────────────────────────────────────────────────
export function linearRemap(
  t: number,
  tMin: number,
  tMax: number,
  vMin: number,
  vMax: number,
): number {
  if (tMax === tMin) return vMin;
  const f = (t - tMin) / (tMax - tMin);
  return vMin + f * (vMax - vMin);
}

export function easeRemap(
  t: number,
  tMin: number,
  tMax: number,
  vMin: number,
  vMax: number,
): number {
  if (tMax === tMin) return vMin;
  const f = Math.max(0, Math.min(1, (t - tMin) / (tMax - tMin)));
  const smooth = f * f * (3 - 2 * f);
  return vMin + smooth * (vMax - vMin);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
