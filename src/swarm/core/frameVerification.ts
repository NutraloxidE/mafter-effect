/**
 * Verification for pixels produced by another device. Exact equality is the wrong test: a
 * different GPU or font rasterizer moves individual channel values slightly while the frame is
 * still correct. A missing font or asset, the failure that actually matters, moves whole regions
 * and is far above this tolerance.
 */
export const SWARM_FRAME_TOLERANCE = 6;

export class SwarmFrameMismatchError extends Error {
  constructor(readonly frame: number, readonly difference: number) {
    super(`Worker frame ${frame} differs from the local render (mean |diff| ${difference.toFixed(2)})`);
    this.name = "SwarmFrameMismatchError";
  }
}

/**
 * Mean absolute per-channel difference over a strided sample of two RGBA buffers.
 * Returns Infinity for mismatched buffers: differing sizes are never an acceptable frame.
 */
export function meanAbsoluteDifference(
  a: Uint8ClampedArray | Uint8Array,
  b: Uint8ClampedArray | Uint8Array,
  pixelStride = 7,
): number {
  if (a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY;
  const step = Math.max(1, Math.floor(pixelStride)) * 4;
  let total = 0;
  let samples = 0;
  for (let i = 0; i < a.length; i += step) {
    for (let channel = 0; channel < 4; channel += 1) {
      total += Math.abs((a[i + channel] ?? 0) - (b[i + channel] ?? 0));
      samples += 1;
    }
  }
  return samples === 0 ? Number.POSITIVE_INFINITY : total / samples;
}

/**
 * Spread of pixel values, used as a cheap "is there anything in this frame" signal. A worker that
 * renders before its footage decodes returns a near-uniform frame, which sampled comparison only
 * catches if that exact frame happened to be sampled.
 */
export function pixelSpread(pixels: Uint8ClampedArray | Uint8Array, pixelStride = 11): number {
  const step = Math.max(1, Math.floor(pixelStride)) * 4;
  let min = 255;
  let max = 0;
  let total = 0;
  let samples = 0;
  for (let i = 0; i < pixels.length; i += step) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = pixels[i + channel] ?? 0;
      min = Math.min(min, value);
      max = Math.max(max, value);
      total += value;
      samples += 1;
    }
  }
  if (samples === 0) return 0;
  let deviation = 0;
  const mean = total / samples;
  for (let i = 0; i < pixels.length; i += step) {
    for (let channel = 0; channel < 3; channel += 1) deviation += Math.abs((pixels[i + channel] ?? 0) - mean);
  }
  return Math.max(max - min, deviation / samples);
}

/** A remote frame this flat, against a reference that is not, is missing content. */
export function looksEmptyAgainst(remote: HTMLCanvasElement, referenceSpread: number): boolean {
  if (referenceSpread <= 0) return false;
  return pixelSpread(readPixels(remote)) < referenceSpread * 0.2;
}

export function canvasSpread(canvas: HTMLCanvasElement): number {
  return pixelSpread(readPixels(canvas));
}

function readPixels(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2d context unavailable while verifying a worker frame");
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

/** Compares a remote frame against the same frame rendered here. */
export function compareFrames(remote: HTMLCanvasElement, local: HTMLCanvasElement): number {
  if (remote.width !== local.width || remote.height !== local.height) return Number.POSITIVE_INFINITY;
  return meanAbsoluteDifference(readPixels(remote), readPixels(local));
}
