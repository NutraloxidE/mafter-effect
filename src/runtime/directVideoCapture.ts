import type { ResolvedObject } from "./resolved";
import type { Mat4 } from "./mat4";

export type VideoFit = "contain" | "cover" | "fill";

export interface DirectVideoCaptureDescriptor {
  worldTransform: Mat4;
  opacity: number;
  fit: VideoFit;
}

export interface DirectVideoCaptureSource extends DirectVideoCaptureDescriptor {
  video: HTMLVideoElement;
}

export interface VideoDrawRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

const EPSILON = 1e-9;

function near(actual: number, expected: number): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= EPSILON;
}

/** Canvas2D setTransform(a,b,c,d,e,f) で忠実に表せる CSS matrix3d か。 */
export function isCanvas2DAffineTransform(m: readonly number[]): m is Mat4 {
  return m.length === 16
    && m.every(Number.isFinite)
    && near(m[2]!, 0)
    && near(m[3]!, 0)
    && near(m[6]!, 0)
    && near(m[7]!, 0)
    && near(m[8]!, 0)
    && near(m[9]!, 0)
    && near(m[10]!, 1)
    && near(m[11]!, 0)
    && near(m[14]!, 0)
    && near(m[15]!, 1);
}

/** foreignObject を介さず capture できる最小の resolved video layer。 */
export function directVideoCaptureDescriptor(obj: ResolvedObject): DirectVideoCaptureDescriptor | null {
  if (
    obj.isAdjustment
    || obj.threeD
    || obj.trackMatte
    || obj.isTrackMatteSource
    || obj.components.length !== 1
    || obj.components[0]?.type !== "video"
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

/** CSS object-fit と同じ source/destination 矩形を返す。 */
export function videoDrawRect(
  sourceWidth: number,
  sourceHeight: number,
  boxWidth: number,
  boxHeight: number,
  fit: VideoFit,
): VideoDrawRect | null {
  if (![sourceWidth, sourceHeight, boxWidth, boxHeight].every((n) => Number.isFinite(n) && n > 0)) return null;
  if (fit === "fill") {
    return { sx: 0, sy: 0, sw: sourceWidth, sh: sourceHeight, dx: 0, dy: 0, dw: boxWidth, dh: boxHeight };
  }

  const scale = fit === "cover"
    ? Math.max(boxWidth / sourceWidth, boxHeight / sourceHeight)
    : Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight);
  if (fit === "contain") {
    const dw = sourceWidth * scale;
    const dh = sourceHeight * scale;
    return {
      sx: 0,
      sy: 0,
      sw: sourceWidth,
      sh: sourceHeight,
      dx: (boxWidth - dw) / 2,
      dy: (boxHeight - dh) / 2,
      dw,
      dh,
    };
  }

  const sw = boxWidth / scale;
  const sh = boxHeight / scale;
  return {
    sx: (sourceWidth - sw) / 2,
    sy: (sourceHeight - sh) / 2,
    sw,
    sh,
    dx: 0,
    dy: 0,
    dw: boxWidth,
    dh: boxHeight,
  };
}

/** A/B benchmark seam。false 明示時だけ browser video の直接 capture を止める。 */
export function isDirectVideoCaptureEnabled(): boolean {
  const g = globalThis as { __mafterDirectVideoCapture?: unknown };
  return g.__mafterDirectVideoCapture !== false;
}
