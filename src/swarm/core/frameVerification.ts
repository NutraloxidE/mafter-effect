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
