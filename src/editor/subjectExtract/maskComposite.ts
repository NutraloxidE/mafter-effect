/** §16.2 — セグメンテーションマスクを RGBA alpha に適用（純関数）。 */

export function applySubjectMask(
  rgba: Uint8ClampedArray,
  mask: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const n = width * height * 4;
  if (rgba.length !== n || mask.length !== width * height) {
    throw new Error("applySubjectMask: dimension mismatch");
  }
  const out = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < n; i += 4, p++) {
    const m = mask[p]! / 255;
    out[i] = rgba[i]!;
    out[i + 1] = rgba[i + 1]!;
    out[i + 2] = rgba[i + 2]!;
    out[i + 3] = Math.round(rgba[i + 3]! * m);
  }
  return out;
}

/**
 * MediaPipe category mask → 0..255 alpha mask。
 * selfie_segmenter は 0/1 または 0/255 のバイナリ（person = 非ゼロ）。
 */
export function categoryMaskToAlpha(
  categoryMask: Uint8Array | Uint8ClampedArray,
  personCategory = 1,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(categoryMask.length);
  for (let i = 0; i < categoryMask.length; i++) {
    const v = categoryMask[i]!;
    out[i] =
      v === personCategory || v === 255 || (personCategory === 1 && v > 0 && v < 128)
        ? 255
        : 0;
  }
  return out;
}

/** confidence mask（0..1 float）→ 0..255 alpha。 */
export function confidenceFloatToAlpha(floats: Float32Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(floats.length);
  for (let i = 0; i < floats.length; i++) {
    const v = floats[i]!;
    out[i] = Math.round(Math.max(0, Math.min(1, v)) * 255);
  }
  return out;
}

/** 最近傍で alpha マスクをリサイズ（MediaPipe mask 解像度 ≠ フレーム時）。 */
export function scaleAlphaMaskNearest(
  mask: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8ClampedArray {
  if (srcW === dstW && srcH === dstH) return mask;
  const out = new Uint8ClampedArray(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
      out[y * dstW + x] = mask[sy * srcW + sx]!;
    }
  }
  return out;
}

/** マスクに人物領域 ink があるか（全ゼロ検出）。 */
export function alphaMaskHasInk(mask: Uint8ClampedArray, minPixels = 64): boolean {
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]! > 16) {
      count++;
      if (count >= minPixels) return true;
    }
  }
  return false;
}

/** 前景率が極端（反転マスク疑い）なら反転。 */
export function normalizeAlphaMaskForeground(
  mask: Uint8ClampedArray,
  maxForegroundRatio = 0.95,
  minForegroundRatio = 0.005,
): Uint8ClampedArray {
  const n = mask.length;
  let fg = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i]! > 127) fg++;
  }
  const ratio = fg / n;
  if (ratio > maxForegroundRatio || ratio < minForegroundRatio) {
    const inv = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) inv[i] = 255 - mask[i]!;
    return inv;
  }
  return mask;
}

/** 相対 ink 閾値（人物抽出 verify 用）。 */
export function alphaMaskInkPixels(mask: Uint8ClampedArray, threshold = 16): number {
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]! > threshold) count++;
  }
  return count;
}
