import { FAST_DISPLACEMENT_EFFECT_TYPES } from "./effectSvg";

/** §27.12 — enabled displacement が fast* のみ（調整レイヤー除く）。 */
export function effectsAreFastDisplacementOnly(
  effects: { type: string; enabled: boolean }[] | undefined,
  isAdjustment?: boolean,
): boolean {
  if (isAdjustment) return false;
  const enabled = (effects ?? []).filter((e) => e.enabled);
  if (enabled.length === 0) return false;
  return enabled.every((e) => FAST_DISPLACEMENT_EFFECT_TYPES.has(e.type));
}
