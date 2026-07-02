// §27.1 / §27.12 — effect 経路判定 SSOT（DomRenderer / pipelineAnalysis 共用・INV-1 純関数）。

import { DISPLACEMENT_EFFECT_TYPES, LIVE_DISPLACEMENT_EFFECT_TYPES } from "./effectSvg";

export interface EffectRoutingInput {
  isAdjustment?: boolean;
  adjustmentMode?: "live" | "raster";
  /** export 時 Live調整の auto_raster_mp4 */
  forceAdjustmentRaster?: boolean;
  effects: { type: string; enabled: boolean }[] | undefined;
  /** apply() が返した live トークン（css/svg）が1つ以上ある */
  hasLiveFilterTokens?: boolean;
}

/** enabled な displacement 系（full + Fast* distortion）があるか */
export function hasEnabledDisplacement(
  effects: { type: string; enabled: boolean }[] | undefined,
): boolean {
  return (effects ?? []).some((e) => e.enabled && DISPLACEMENT_EFFECT_TYPES.has(e.type));
}

/**
 * enabled な **full** displacement（`wave` / `ripple` / `turbulentDisplace`）があるか。
 * Fast* / opticsCompensation は live CSS filter（region クランプ）で raster 不要なので除外する（§27.12 改定3）。
 */
export function hasEnabledFullDisplacement(
  effects: { type: string; enabled: boolean }[] | undefined,
): boolean {
  return (effects ?? []).some(
    (e) =>
      e.enabled &&
      DISPLACEMENT_EFFECT_TYPES.has(e.type) &&
      !LIVE_DISPLACEMENT_EFFECT_TYPES.has(e.type),
  );
}

/**
 * SVG displacement を self/adj capture 経路で焼く必要があるか。
 * **full** displacement のみ capture 対象。Fast* は filter region を layer bounds に
 * クランプした live CSS filter で raster 無しに完結する（§27.12 改定3）。
 */
export function needsSvgDisplaceCapture(input: EffectRoutingInput): boolean {
  const { isAdjustment, adjustmentMode, forceAdjustmentRaster, effects, hasLiveFilterTokens } = input;
  if (hasEnabledFullDisplacement(effects)) return true;
  if (isAdjustment === true) {
    const isRasterAdj = adjustmentMode === "raster" || forceAdjustmentRaster === true;
    if (isRasterAdj && hasLiveFilterTokens === true) return true;
  }
  return false;
}
