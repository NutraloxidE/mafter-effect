import type { Vec3 } from "../../core/schema";

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

/**
 * null（無効）を前後の有効値で線形補間。端はホールド。全無効は fallback。
 * その後、連続フレーム間のジャンプを「有効区間の中央値ステップ × slopeLimitFactor」で制限。
 */
export function interpolateInvalidVec3Series(
  series: Array<Vec3 | null>,
  fallback: Vec3,
  slopeLimitFactor = 3,
): Vec3[] {
  const n = series.length;
  if (n === 0) return [];

  const out: Vec3[] = new Array(n);
  const validIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (series[i] !== null) validIdx.push(i);
  }

  if (validIdx.length === 0) {
    for (let i = 0; i < n; i++) out[i] = { x: fallback.x, y: fallback.y, z: fallback.z };
    return out;
  }

  for (let i = 0; i < n; i++) {
    const v = series[i];
    if (v !== null && v !== undefined) {
      out[i] = { x: v.x, y: v.y, z: v.z };
      continue;
    }
    let prev = -1;
    let next = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (series[j] !== null) {
        prev = j;
        break;
      }
    }
    for (let j = i + 1; j < n; j++) {
      if (series[j] !== null) {
        next = j;
        break;
      }
    }
    if (prev >= 0 && next >= 0) {
      const t = (i - prev) / (next - prev);
      out[i] = lerpVec3(series[prev] as Vec3, series[next] as Vec3, t);
    } else if (prev >= 0) {
      const p = series[prev] as Vec3;
      out[i] = { x: p.x, y: p.y, z: p.z };
    } else if (next >= 0) {
      const p = series[next] as Vec3;
      out[i] = { x: p.x, y: p.y, z: p.z };
    } else {
      out[i] = { x: fallback.x, y: fallback.y, z: fallback.z };
    }
  }

  // 有効連続ペアのステップ中央値
  const steps: number[] = [];
  for (let k = 1; k < validIdx.length; k++) {
    const a = validIdx[k - 1]!;
    const b = validIdx[k]!;
    if (b === a + 1) steps.push(dist(series[a]!, series[b]!));
    else {
      // 間に invalid がある場合は 1 フレーム換算
      steps.push(dist(series[a]!, series[b]!) / (b - a));
    }
  }
  const med = median(steps);
  const maxStep = med > 1e-9 ? med * slopeLimitFactor : Infinity;

  if (Number.isFinite(maxStep) && maxStep > 0) {
    for (let i = 1; i < n; i++) {
      const prev = out[i - 1]!;
      const cur = out[i]!;
      const d = dist(prev, cur);
      if (d > maxStep && d > 1e-12) {
        const s = maxStep / d;
        out[i] = {
          x: prev.x + (cur.x - prev.x) * s,
          y: prev.y + (cur.y - prev.y) * s,
          z: prev.z + (cur.z - prev.z) * s,
        };
      }
    }
  }

  return out;
}
