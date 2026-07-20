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
    if (component.type !== "solid" && component.type !== "text" && component.type !== "image") return null;
    if (component.type === "text" && component.props["geomEnabled"] === true) return null;
    if (component.type === "image" && !isStaticImageCaptureCacheEnabled()) return null;
  }

  return JSON.stringify({
    worldTransform: obj.worldTransform,
    opacity: obj.opacity,
    components: obj.components,
  });
}

/** Phase 3b A/B bench用。false明示時だけimageをcache対象から外す。 */
export function isStaticImageCaptureCacheEnabled(): boolean {
  const g = globalThis as { __mafterStaticImageCaptureCache?: unknown };
  return g.__mafterStaticImageCaptureCache !== false;
}

/** A/B bench用。false明示時だけbrowser video exportのstatic capture cacheを止める。 */
export function isStaticLayerCaptureCacheEnabled(): boolean {
  const g = globalThis as { __mafterStaticLayerCaptureCache?: unknown };
  return g.__mafterStaticLayerCaptureCache !== false;
}
