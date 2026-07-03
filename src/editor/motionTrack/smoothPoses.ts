import type { RawQuaternion, RawTranslation } from "./types";
import { slamRotationToMafterEuler } from "./coordConvert";
import { quaternionNormalize } from "./rotationEstimator";

const ZERO: RawTranslation = [0, 0, 0];

function median3(a: number, b: number, c: number): number {
  if (a <= b) {
    if (b <= c) return b;
    return a <= c ? c : a;
  }
  if (a <= c) return a;
  return b <= c ? c : b;
}

function medianComponent(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * 3 タップ median（端は 2 点 median）+ 隣接フレームとの大ジャンプ除去。
 */
export function smoothTranslations(
  input: Array<RawTranslation | null>,
  options?: { window?: number; outlierThreshold?: number },
): RawTranslation[] {
  const window = options?.window ?? 3;
  const outlierThreshold = options?.outlierThreshold ?? 0.5;
  const n = input.length;
  if (n === 0) return [];

  const filled: RawTranslation[] = input.map((t, i) => {
    if (t) return t;
    for (let j = i - 1; j >= 0; j--) {
      if (input[j]) return input[j]!;
    }
    return ZERO;
  });

  const half = Math.max(1, Math.floor(window / 2));
  const medFiltered: RawTranslation[] = filled.map((_, i) => {
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      xs.push(filled[j]![0]);
      ys.push(filled[j]![1]);
      zs.push(filled[j]![2]);
    }
    if (xs.length === 2) {
      return [
        (xs[0]! + xs[1]!) / 2,
        (ys[0]! + ys[1]!) / 2,
        (zs[0]! + zs[1]!) / 2,
      ];
    }
    if (xs.length === 3) {
      return [median3(xs[0]!, xs[1]!, xs[2]!), median3(ys[0]!, ys[1]!, ys[2]!), median3(zs[0]!, zs[1]!, zs[2]!)];
    }
    return [medianComponent(xs), medianComponent(ys), medianComponent(zs)];
  });

  const out: RawTranslation[] = [medFiltered[0] ?? ZERO];
  for (let i = 1; i < medFiltered.length; i++) {
    const prev = out[i - 1]!;
    const cur = medFiltered[i]!;
    const dx = cur[0] - prev[0];
    const dy = cur[1] - prev[1];
    const dz = cur[2] - prev[2];
    const jump = Math.hypot(dx, dy, dz);
    if (jump > outlierThreshold) {
      out.push([...prev]);
    } else {
      out.push(cur);
    }
  }
  return out;
}

const IDENTITY_QUAT: RawQuaternion = [0, 0, 0, 1];

/**
 * 四元数列の median + 外れ値ホールド。符号は直前フレームと dot>0 に揃える。
 */
export function smoothRotations(
  input: Array<RawQuaternion | null>,
  options?: { window?: number; outlierThresholdDeg?: number },
): RawQuaternion[] {
  const window = options?.window ?? 3;
  const outlierThresholdDeg = options?.outlierThresholdDeg ?? 25;
  const n = input.length;
  if (n === 0) return [];

  const filled: RawQuaternion[] = input.map((q, i) => {
    if (q) return quaternionNormalize(q);
    for (let j = i - 1; j >= 0; j--) {
      if (input[j]) return quaternionNormalize(input[j]!);
    }
    return [...IDENTITY_QUAT];
  });

  const half = Math.max(1, Math.floor(window / 2));
  const medFiltered: RawQuaternion[] = filled.map((_, i) => {
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    const ws: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      const q = filled[j]!;
      xs.push(q[0]);
      ys.push(q[1]);
      zs.push(q[2]);
      ws.push(q[3]);
    }
    const pick = (vals: number[]) =>
      vals.length === 2
        ? (vals[0]! + vals[1]!) / 2
        : vals.length === 3
          ? median3(vals[0]!, vals[1]!, vals[2]!)
          : medianComponent(vals);
    const qMed: RawQuaternion = [pick(xs), pick(ys), pick(zs), pick(ws)];
    return quaternionNormalize(qMed);
  });

  const out: RawQuaternion[] = [medFiltered[0] ?? [...IDENTITY_QUAT]];
  for (let i = 1; i < medFiltered.length; i++) {
    const prev = out[i - 1]!;
    let cur = medFiltered[i]!;
    const dot = prev[0] * cur[0] + prev[1] * cur[1] + prev[2] * cur[2] + prev[3] * cur[3];
    if (dot < 0) cur = [-cur[0], -cur[1], -cur[2], -cur[3]];
    const prevEuler = slamRotationToMafterEuler(prev);
    const curEuler = slamRotationToMafterEuler(cur);
    const jump = Math.hypot(
      curEuler.x - prevEuler.x,
      curEuler.y - prevEuler.y,
      curEuler.z - prevEuler.z,
    );
    if (jump > outlierThresholdDeg) {
      out.push([...prev]);
    } else {
      out.push(cur);
    }
  }
  return out;
}
