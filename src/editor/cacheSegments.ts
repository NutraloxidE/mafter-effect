/**
 * §28.10: キャッシュ済みフレーム集合を、viewRange 内の連続 run ごとに % セグメントへ畳む。
 * タイムラインのルーラー緑バー（comp 全体）と、レイヤーバー直上の緑線（per-layer）で共有する。
 * 各 run の右端は `prev + 1` の位置（最後のフレームの右辺）まで。
 */
export function framesToSegments(
  frames: Iterable<number>,
  viewRange: { start: number; end: number },
  frameToPercent: (f: number) => number,
): { left: number; width: number }[] {
  const segments: { left: number; width: number }[] = [];
  const sorted = [...frames].filter((f) => f >= viewRange.start && f < viewRange.end).sort((a, b) => a - b);
  let runStart: number | null = null;
  let prev = -2;
  const flush = (): void => {
    if (runStart === null) return;
    const left = frameToPercent(runStart);
    const right = frameToPercent(prev + 1);
    segments.push({ left, width: Math.max(0.2, right - left) });
  };
  for (const f of sorted) {
    if (f === prev) continue; // 重複はスキップ（run を分断しない）
    if (runStart === null || f !== prev + 1) {
      flush();
      runStart = f;
    }
    prev = f;
  }
  flush();
  return segments;
}
