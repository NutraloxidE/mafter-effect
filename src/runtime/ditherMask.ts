import { BLUE_NOISE_64, BLUE_NOISE_SIZE } from "./blueNoise64";
import { quantizeDitherReveal } from "./ditherReveal";

export type DitherPattern = "ordered" | "blueNoise";

// §27.3 ディザ合成（Dither Dissolve）用の Bayer 秩序ディザマスク。
// レイヤー opacity を閾値に、ピクセル単位で α 0/1 を決める（混色しない）。
// Bayer は固定行列なので完全決定論（Math.random 不要・INV-1）。CSS mask-image に
// 敷くタイル画像を生成する。α しきい値処理のため foreignObject キャプチャでもそのまま出る。

const TILE = 8; // 8×8 Bayer（64 階調）

/**
 * 再帰生成した N×N Bayer 行列（値 0..N*N-1）を返す。N は 2 の冪。
 * 純関数・決定論。テスト可能なように export する。
 */
export function bayerMatrix(n: number): number[][] {
  if (n === 1) return [[0]];
  const half = bayerMatrix(n / 2);
  const h = n / 2;
  const out: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let y = 0; y < h; y++) {
    const srcRow = half[y]!;
    const topRow = out[y]!;
    const botRow = out[y + h]!;
    for (let x = 0; x < h; x++) {
      const v = srcRow[x]!;
      topRow[x] = 4 * v + 0;
      topRow[x + h] = 4 * v + 2;
      botRow[x] = 4 * v + 3;
      botRow[x + h] = 4 * v + 1;
    }
  }
  return out;
}

const BAYER = bayerMatrix(TILE);

/**
 * opacity（0..1）で各テクセルの可視/不可視を返す（true = 可視 = α255）。
 * 純関数・決定論。閾値 = (bayer + 0.5) / (TILE*TILE)。
 */
export function ditherVisible(x: number, y: number, opacity: number): boolean {
  const threshold = (BAYER[y % TILE]![x % TILE]! + 0.5) / (TILE * TILE);
  return threshold < opacity;
}

/** blue noise タイル（64×64 rank LUT）での可視判定。 */
export function ditherVisibleBlueNoise(x: number, y: number, opacity: number): boolean {
  const idx = (y % BLUE_NOISE_SIZE) * BLUE_NOISE_SIZE + (x % BLUE_NOISE_SIZE);
  const threshold = (BLUE_NOISE_64[idx]! + 0.5) / 256;
  return threshold < opacity;
}

export function ditherVisibleAt(
  pattern: DitherPattern,
  x: number,
  y: number,
  opacity: number,
): boolean {
  return pattern === "blueNoise"
    ? ditherVisibleBlueNoise(x, y, opacity)
    : ditherVisible(x, y, opacity);
}

export function normalizeDitherPattern(value: unknown): DitherPattern {
  return value === "blueNoise" ? "blueNoise" : "ordered";
}

// opacity を 64 段に量子化したタイル dataURL のキャッシュ（renderer 内・描画専用）。
const tileCache = new Map<number, string>();

/**
 * 指定 opacity の Bayer ディザタイル（8×8）を data URL で返す。CSS
 * `mask-image: url(...)` + `mask-repeat: repeat` で敷く。opacity は 64 段に量子化してキャッシュ。
 * opacity<=0 は完全不可視、>=1 は完全可視（マスク不要）を呼び出し側が判断できるよう、
 * その両端でも正しいタイルを返す。DOM 非対応環境（テスト）では空文字を返す。
 */
export function ditherTileDataUrl(opacity: number): string {
  const t = quantizeDitherReveal(opacity);
  const q = Math.round(t * 64);
  const cached = tileCache.get(q);
  if (cached !== undefined) return cached;
  if (typeof document === "undefined") return "";
  const canvas = document.createElement("canvas");
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(TILE, TILE);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const i = (y * TILE + x) * 4;
      const on = ditherVisible(x, y, t);
      img.data[i] = 0;
      img.data[i + 1] = 0;
      img.data[i + 2] = 0;
      img.data[i + 3] = on ? 255 : 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL("image/png");
  tileCache.set(q, url);
  return url;
}
