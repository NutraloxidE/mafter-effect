import type { ResolvedObject } from "./resolved";

/** foreignObject結果を安全に1-frame跨ぎで再利用できる最小対象のsignature。 */
export function staticLayerCaptureSignature(obj: ResolvedObject): string | null {
  if (
    obj.isAdjustment
    || obj.threeD
    || obj.trackMatte
    || obj.isTrackMatteSource
    || obj.components.length === 0
    || obj.effects?.some((effect) => effect.enabled)
  ) return null;

  for (const component of obj.components) {
    if (component.type !== "solid" && component.type !== "text") return null;
    if (component.type === "text" && component.props["geomEnabled"] === true) return null;
  }

  return JSON.stringify({
    worldTransform: obj.worldTransform,
    opacity: obj.opacity,
    components: obj.components,
  });
}

/** A/B bench用。false明示時だけbrowser video exportのstatic capture cacheを止める。 */
export function isStaticLayerCaptureCacheEnabled(): boolean {
  const g = globalThis as { __mafterStaticLayerCaptureCache?: unknown };
  return g.__mafterStaticLayerCaptureCache !== false;
}
