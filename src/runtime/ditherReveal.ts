// §27.3 Dither Dissolve — effectiveReveal 純関数（INV-1・DOM 非依存）。

/** 0..1 を 64 段に量子化（ditherMask キャッシュと整合）。 */
export function quantizeDitherReveal(reveal: number): number {
  const clamped = Math.max(0, Math.min(1, reveal));
  return Math.max(0, Math.min(64, Math.round(clamped * 64))) / 64;
}

/** layerOpacity × (1 − completion) を量子化した有効表示率。 */
export function ditherEffectiveReveal(layerOpacity: number, completion: number): number {
  const lo = Math.max(0, Math.min(1, layerOpacity));
  const c = Math.max(0, Math.min(1, completion));
  return quantizeDitherReveal(lo * (1 - c));
}

export interface DitherOpacityInput {
  type: string;
  enabled: boolean;
  props: Record<string, unknown>;
}

/** div opacity を 1 に強制すべきか（Bayer マスクが透明度を担う）。 */
export function shouldForceOpaqueForDither(
  effects: DitherOpacityInput[] | undefined,
  layerOpacity: number,
): boolean {
  const e = effects?.find((x) => x.enabled && x.type === "ditherDissolve");
  if (!e) return false;
  const completion = typeof e.props["completion"] === "number" ? e.props["completion"] : 0;
  return ditherEffectiveReveal(layerOpacity, completion) < 1;
}
