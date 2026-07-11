// §27.3 pixelSorter — buffer→buffer コア（純関数・INV-1）

import { seededRandom } from "./exprHelpers";
import type { RasterBuffer } from "./plugin";

export type PixelSortMode = "simple" | "highlights" | "shadows" | "random";

export interface PixelSortParams {
  sortingMode: PixelSortMode;
  thresholdLow: number;
  thresholdHigh: number;
  angle: number;
  length: number;
  offset: number;
  feather: number;
  sortBlocks: number;
}

export function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function cloneBuffer(buf: RasterBuffer): RasterBuffer {
  return {
    data: new Uint8ClampedArray(buf.data),
    width: buf.width,
    height: buf.height,
  };
}

function getPixel(data: Uint8ClampedArray, w: number, x: number, y: number): [number, number, number, number] {
  const i = (y * w + x) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
}

function setPixel(data: Uint8ClampedArray, w: number, x: number, y: number, rgba: [number, number, number, number]): void {
  const i = (y * w + x) * 4;
  data[i] = rgba[0];
  data[i + 1] = rgba[1];
  data[i + 2] = rgba[2];
  data[i + 3] = rgba[3];
}

function maskWeight(l: number, low: number, high: number, featherNorm: number): number {
  if (low > high) return 0;
  if (l >= low && l <= high) return 1;
  if (featherNorm <= 0) return 0;
  if (l < low) {
    const d = (low - l) / featherNorm;
    return d >= 1 ? 0 : 1 - d;
  }
  const d = (l - high) / featherNorm;
  return d >= 1 ? 0 : 1 - d;
}

function sampleBilinear(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  fx: number,
  fy: number,
): [number, number, number, number] {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const c00 = getPixel(data, w, Math.max(0, x0), Math.max(0, y0));
  const c10 = getPixel(data, w, x1, Math.max(0, y0));
  const c01 = getPixel(data, w, Math.max(0, x0), y1);
  const c11 = getPixel(data, w, x1, y1);
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const top = c00[c]! * (1 - tx) + c10[c]! * tx;
    const bot = c01[c]! * (1 - tx) + c11[c]! * tx;
    out[c] = Math.round(top * (1 - ty) + bot * ty);
  }
  return out;
}

function rotateBuffer(buf: RasterBuffer, degrees: number): RasterBuffer {
  if (degrees === 0 || buf.width === 0 || buf.height === 0) return cloneBuffer(buf);
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const w = buf.width;
  const h = buf.height;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const out = new Uint8ClampedArray(buf.data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const sx = cos * dx + sin * dy + cx;
      const sy = -sin * dx + cos * dy + cy;
      const rgba = sampleBilinear(buf.data, w, h, sx, sy);
      setPixel(out, w, x, y, rgba);
    }
  }
  return { data: out, width: w, height: h };
}

interface SpanPixel {
  x: number;
  rgba: [number, number, number, number];
  lum: number;
  weight: number;
}

function sortSpanPixels(
  pixels: SpanPixel[],
  mode: PixelSortMode,
  length: number,
  offset: number,
  seed: number,
): void {
  if (pixels.length < 2) return;
  const start = Math.min(offset, pixels.length - 1);
  const end = length > 0 ? Math.min(pixels.length, start + length) : pixels.length;
  const slice = pixels.slice(start, end);
  if (slice.length < 2) return;

  const sortedRgba: [number, number, number, number][] = [];

  if (mode === "random") {
    const rng = seededRandom(seed >>> 0);
    const indices = slice.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = indices[i]!;
      indices[i] = indices[j]!;
      indices[j] = tmp;
    }
    for (const idx of indices) sortedRgba.push(slice[idx]!.rgba);
  } else if (mode === "highlights") {
    const mid = (slice[0]!.lum + slice[slice.length - 1]!.lum) / 2;
    const bright = slice.filter((p) => p.lum >= mid);
    const dark = slice.filter((p) => p.lum < mid);
    bright.sort((a, b) => a.lum - b.lum);
    for (const p of dark) sortedRgba.push(p.rgba);
    for (const p of bright) sortedRgba.push(p.rgba);
  } else if (mode === "shadows") {
    const mid = (slice[0]!.lum + slice[slice.length - 1]!.lum) / 2;
    const dark = slice.filter((p) => p.lum < mid);
    const bright = slice.filter((p) => p.lum >= mid);
    dark.sort((a, b) => a.lum - b.lum);
    for (const p of dark) sortedRgba.push(p.rgba);
    for (const p of bright) sortedRgba.push(p.rgba);
  } else {
    slice.sort((a, b) => a.lum - b.lum);
    for (const p of slice) sortedRgba.push(p.rgba);
  }

  for (let i = 0; i < sortedRgba.length; i++) {
    const target = pixels[start + i]!;
    const src = sortedRgba[i]!;
    const w = target.weight;
    if (w >= 1) {
      target.rgba = src;
    } else if (w > 0) {
      target.rgba = [
        Math.round(target.rgba[0] * (1 - w) + src[0] * w),
        Math.round(target.rgba[1] * (1 - w) + src[1] * w),
        Math.round(target.rgba[2] * (1 - w) + src[2] * w),
        Math.round(target.rgba[3] * (1 - w) + src[3] * w),
      ];
    }
  }
}

function sortHorizontalScanlines(buf: RasterBuffer, params: PixelSortParams, seed: number): void {
  const { data, width: w, height: h } = buf;
  const low = Math.min(params.thresholdLow, params.thresholdHigh);
  const high = Math.max(params.thresholdLow, params.thresholdHigh);
  const featherNorm = params.feather > 0 ? params.feather / 255 : 0;

  for (let y = 0; y < h; y++) {
    let span: SpanPixel[] = [];

    const flushSpan = (): void => {
      if (span.length > 1) sortSpanPixels(span, params.sortingMode, params.length, params.offset, seed + y);
      for (const p of span) setPixel(data, w, p.x, y, p.rgba);
      span = [];
    };

    for (let x = 0; x < w; x++) {
      const rgba = getPixel(data, w, x, y);
      const lum = luminance(rgba[0], rgba[1], rgba[2]);
      const weight = maskWeight(lum, low, high, featherNorm);
      if (weight > 0.01) {
        span.push({ x, rgba, lum, weight });
      } else {
        flushSpan();
      }
    }
    flushSpan();
  }
}

export function blockAverage(buf: RasterBuffer, blockSize: number): RasterBuffer {
  const bs = Math.max(1, Math.round(blockSize));
  if (buf.width === 0 || buf.height === 0 || bs <= 1) return cloneBuffer(buf);
  const { data, width: w, height: h } = buf;
  const out = cloneBuffer(buf);
  for (let by = 0; by < h; by += bs) {
    for (let bx = 0; bx < w; bx += bs) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      let count = 0;
      for (let dy = 0; dy < bs && by + dy < h; dy++) {
        for (let dx = 0; dx < bs && bx + dx < w; dx++) {
          const rgba = getPixel(data, w, bx + dx, by + dy);
          sr += rgba[0];
          sg += rgba[1];
          sb += rgba[2];
          sa += rgba[3];
          count++;
        }
      }
      const avg: [number, number, number, number] = [
        Math.round(sr / count),
        Math.round(sg / count),
        Math.round(sb / count),
        Math.round(sa / count),
      ];
      for (let dy = 0; dy < bs && by + dy < h; dy++) {
        for (let dx = 0; dx < bs && bx + dx < w; dx++) {
          setPixel(out.data, w, bx + dx, by + dy, avg);
        }
      }
    }
  }
  return out;
}

export function isPixelSortIdentity(params: PixelSortParams): boolean {
  if (params.thresholdLow > params.thresholdHigh && params.feather === 0) return true;
  const low = Math.min(params.thresholdLow, params.thresholdHigh);
  const high = Math.max(params.thresholdLow, params.thresholdHigh);
  if (low >= high && params.feather === 0) return true;
  return false;
}

export function processPixelSort(input: RasterBuffer, params: PixelSortParams, seed: number): RasterBuffer {
  if (input.width === 0 || input.height === 0) return input;
  if (isPixelSortIdentity(params)) return cloneBuffer(input);

  let buf = cloneBuffer(input);
  if (params.sortBlocks > 1) {
    buf = blockAverage(buf, params.sortBlocks);
  }

  const rotated = rotateBuffer(buf, -params.angle);
  sortHorizontalScanlines(rotated, params, seed);
  const result = rotateBuffer(rotated, params.angle);
  return result;
}

export function canvasToRasterBuffer(canvas: HTMLCanvasElement): RasterBuffer {
  const ctx = canvas.getContext("2d");
  if (!ctx) return { data: new Uint8ClampedArray(0), width: 0, height: 0 };
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: imageData.data, width: canvas.width, height: canvas.height };
}

export function rasterBufferToCanvas(buf: RasterBuffer): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = buf.width;
  canvas.height = buf.height;
  const ctx = canvas.getContext("2d");
  if (ctx && buf.width > 0 && buf.height > 0) {
    const copy = new Uint8ClampedArray(buf.data);
    const imageData = new ImageData(copy, buf.width, buf.height);
    ctx.putImageData(imageData, 0, 0);
  }
  return canvas;
}
