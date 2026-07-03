/**
 * warmup を除いた valid 率を返す。
 * rotation 全滅（identity を黙ってベイク）を UI で検知するために使う。
 */
export function summarizeTrackValidity(
  validMask: readonly boolean[],
  warmupFrames = 0,
): { validCount: number; total: number; validRatio: number } {
  const start = Math.max(0, Math.min(warmupFrames, validMask.length));
  let validCount = 0;
  let total = 0;
  for (let i = start; i < validMask.length; i++) {
    total++;
    if (validMask[i]) validCount++;
  }
  return {
    validCount,
    total,
    validRatio: total === 0 ? 0 : validCount / total,
  };
}

/** この比率未満なら「推定がほぼ全滅」とみなす。 */
export const TRACK_VALIDITY_WARN_RATIO = 0.3;
