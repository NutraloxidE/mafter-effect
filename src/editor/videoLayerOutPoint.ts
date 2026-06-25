/** AE 風: ソース尺にレイヤー outPoint を合わせる（meta 欠落時は comp 尺）。 */
export function videoLayerOutPoint(
  meta: Record<string, unknown> | undefined,
  fps: number,
  compDuration: number,
): number {
  if (meta && typeof meta.duration === "number" && meta.duration > 0) {
    const sourceFrames = Math.max(1, Math.round(meta.duration * fps));
    return Math.min(compDuration, sourceFrames);
  }
  return compDuration;
}
