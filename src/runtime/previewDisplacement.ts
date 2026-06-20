import { DISPLACEMENT_EFFECT_TYPES, FAST_DISPLACEMENT_EFFECT_TYPES } from "./effectSvg";

/** §27.12 — enabled displacement が fast* のみ（調整レイヤー除く）。非 displacement effect の併用は許可。 */
export function effectsAreFastDisplacementOnly(
  effects: { type: string; enabled: boolean }[] | undefined,
  isAdjustment?: boolean,
): boolean {
  if (isAdjustment) return false;
  const enabled = (effects ?? []).filter((e) => e.enabled);
  const enabledDisp = enabled.filter((e) => DISPLACEMENT_EFFECT_TYPES.has(e.type));
  if (enabledDisp.length === 0) return false;
  return enabledDisp.every((e) => FAST_DISPLACEMENT_EFFECT_TYPES.has(e.type));
}
