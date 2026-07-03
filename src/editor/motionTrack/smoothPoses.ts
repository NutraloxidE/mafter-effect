import type { RawTranslation } from "./types";

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
