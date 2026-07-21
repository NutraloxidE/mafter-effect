import { isCanvas2DAffineTransform, type VideoFit } from "./directVideoCapture";
import type { Mat4 } from "./mat4";
import type { ResolvedObject } from "./resolved";

export interface DirectImageCaptureDescriptor {
  worldTransform: Mat4;
  opacity: number;
  fit: VideoFit;
}

export interface DirectImageCaptureSource extends DirectImageCaptureDescriptor {
  image: HTMLImageElement;
}

export function directImageCaptureDescriptor(obj: ResolvedObject): DirectImageCaptureDescriptor | null {
  if (
    obj.isAdjustment
    || obj.threeD
    || obj.trackMatte
    || obj.isTrackMatteSource
    || obj.components.length !== 1
    || obj.components[0]?.type !== "image"
    || obj.effects?.some((effect) => effect.enabled)
    || !isCanvas2DAffineTransform(obj.worldTransform)
  ) return null;

  const fit = obj.components[0].props["fit"];
  return {
    worldTransform: [...obj.worldTransform] as Mat4,
    opacity: Math.max(0, Math.min(1, obj.opacity)),
    fit: fit === "cover" || fit === "fill" ? fit : "contain",
  };
}

export function isDirectImageCaptureEnabled(): boolean {
  const g = globalThis as { __mafterDirectImageCapture?: unknown };
  return g.__mafterDirectImageCapture !== false;
}
