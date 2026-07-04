import type { TrackMatteMode } from "../core/schema";
import { isInvertedTrackMatte, isLumaTrackMatte } from "../core/trackMatte";

/** RGBA バッファ（length = width * height * 4）。§5.4f 正準合成の入出力。 */
export interface RgbaBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * §5.4f 正準: fill / matte は同寸法の straight alpha RGBA。
 * preview / export が同一純関数を共有（INV-2）。
 */
export function applyTrackMatte(fill: RgbaBuffer, matte: RgbaBuffer, mode: TrackMatteMode): RgbaBuffer {
  const n = fill.data.length;
  if (matte.data.length !== n || fill.width !== matte.width || fill.height !== matte.height) {
    throw new Error("applyTrackMatte: fill and matte dimensions must match");
  }
  const data = new Uint8ClampedArray(n);
  const fd = fill.data;
  const md = matte.data;
  const luma = isLumaTrackMatte(mode);
  const inv = isInvertedTrackMatte(mode);

  for (let i = 0; i < n; i += 4) {
    const fr = fd[i]!;
    const fg = fd[i + 1]!;
    const fb = fd[i + 2]!;
    const fa = fd[i + 3]!;
    const mr = md[i]!;
    const mg = md[i + 1]!;
    const mb = md[i + 2]!;
    const ma = md[i + 3]!;

    let mask: number;
    if (luma) {
      mask = (0.2126 * mr + 0.7152 * mg + 0.0722 * mb) * (ma / 255);
    } else {
      mask = ma;
    }
    if (inv) mask = 255 - mask;

    const m = mask / 255;
    data[i] = fr;
    data[i + 1] = fg;
    data[i + 2] = fb;
    data[i + 3] = Math.round(fa * m);
  }
  return { width: fill.width, height: fill.height, data };
}

/** 空マット: alpha/luma は全透明、inverted は fill をそのまま。 */
export function applyEmptyTrackMatte(fill: RgbaBuffer, mode: TrackMatteMode): RgbaBuffer {
  if (isInvertedTrackMatte(mode)) {
    return {
      width: fill.width,
      height: fill.height,
      data: new Uint8ClampedArray(fill.data),
    };
  }
  return {
    width: fill.width,
    height: fill.height,
    data: new Uint8ClampedArray(fill.width * fill.height * 4),
  };
}
