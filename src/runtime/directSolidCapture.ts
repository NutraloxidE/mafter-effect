import type { RGBA, Vec3 } from "../core/schema";
import { isCanvas2DAffineTransform } from "./directVideoCapture";
import type { Mat4 } from "./mat4";
import type { ResolvedObject } from "./resolved";

export interface DirectSolidCaptureDescriptor {
  worldTransform: Mat4;
  opacity: number;
  color: RGBA;
  size: Vec3;
}

function finiteColor(value: unknown): value is RGBA {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<RGBA>;
  return [c.r, c.g, c.b, c.a].every((n) => typeof n === "number" && Number.isFinite(n));
}

function finiteSize(value: unknown): value is Vec3 {
  if (typeof value !== "object" || value === null) return false;
  const size = value as Partial<Vec3>;
  return typeof size.x === "number" && Number.isFinite(size.x) && size.x > 0
    && typeof size.y === "number" && Number.isFinite(size.y) && size.y > 0
    && typeof size.z === "number" && Number.isFinite(size.z);
}

export function directSolidCaptureDescriptor(obj: ResolvedObject): DirectSolidCaptureDescriptor | null {
  if (
    obj.isAdjustment
    || obj.threeD
    || obj.trackMatte
    || obj.isTrackMatteSource
    || obj.components.length !== 1
    || obj.components[0]?.type !== "solid"
    || obj.effects?.some((effect) => effect.enabled)
    || !isCanvas2DAffineTransform(obj.worldTransform)
  ) return null;

  const color = obj.components[0].props["color"];
  const size = obj.components[0].props["size"];
  if (!finiteColor(color) || !finiteSize(size)) return null;
  return {
    worldTransform: [...obj.worldTransform] as Mat4,
    opacity: Math.max(0, Math.min(1, obj.opacity)),
    color: { ...color },
    size: { ...size },
  };
}

export function isDirectSolidCaptureEnabled(): boolean {
  const g = globalThis as { __mafterDirectSolidCapture?: unknown };
  return g.__mafterDirectSolidCapture !== false;
}
