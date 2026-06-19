import type { TimelineComposition } from "../core/schema";
import { DISPLACEMENT_EFFECT_TYPES } from "../runtime/effectSvg";
import { effectsAreFastDisplacementOnly } from "../runtime/previewDisplacement";
import { globalPluginRegistry } from "../runtime/pluginRegistry";

/** §28 L2 — enabled effect/component の previewBakeRequired 集約。 */
export function compRequiresPreviewBake(comp: TimelineComposition): boolean {
  for (const obj of comp.objects) {
    for (const fx of obj.effects ?? []) {
      if (!fx.enabled) continue;
      const def = globalPluginRegistry.getEffectDef(fx.type);
      if (def?.previewBakeRequired) return true;
    }
  }
  return false;
}

/** enabled displacement 系 effect がある。 */
export function compHasDisplacementEffect(comp: TimelineComposition): boolean {
  for (const obj of comp.objects) {
    for (const fx of obj.effects ?? []) {
      if (!fx.enabled) continue;
      if (DISPLACEMENT_EFFECT_TYPES.has(fx.type)) return true;
    }
  }
  return false;
}

/** processPixels を持つ enabled effect がある。 */
export function compHasProcessPixelsEffect(comp: TimelineComposition): boolean {
  for (const obj of comp.objects) {
    for (const fx of obj.effects ?? []) {
      if (!fx.enabled) continue;
      const def = globalPluginRegistry.getEffectDef(fx.type);
      if (def?.processPixels) return true;
    }
  }
  return false;
}

/** §28.9 — 再生開始時に Auto Preview Cache を起動する comp。 */
export function compNeedsAutoPreviewCache(comp: TimelineComposition): boolean {
  return (
    compRequiresPreviewBake(comp)
    || compHasDisplacementEffect(comp)
    || compHasProcessPixelsEffect(comp)
  );
}

/** §27.12 — enabled displacement が fast* のみ（調整レイヤーは対象外）。 */
export function objectHasFastDisplacementOnly(
  effects: { type: string; enabled: boolean }[] | undefined,
  isAdjustment: boolean | undefined,
): boolean {
  return effectsAreFastDisplacementOnly(effects, isAdjustment);
}
