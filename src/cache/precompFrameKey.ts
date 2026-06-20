/** §28.11 precomp comp 単位ラスターキャッシュキー（content hash 基準）。 */
export function buildPrecompFrameCacheKey(params: {
  compId: string;
  childFrame: number;
  contentHash: string;
}): string {
  return `precomp:${params.compId}:f${params.childFrame}:hash${params.contentHash}`;
}

export function precompFrameCachePrefix(compId: string): string {
  return `precomp:${compId}:`;
}

/** すべての precomp raster キーの共通 prefix（compId 横断列挙用）。 */
export const PRECOMP_FRAME_CACHE_PREFIX = "precomp:";

/** precomp キーから compId と childFrame を抽出（§28.11）。非該当キーは null。 */
export function parsePrecompFrameKey(key: string): { compId: string; childFrame: number } | null {
  const m = /^precomp:([^:]+):f(\d+):/.exec(key);
  return m ? { compId: m[1]!, childFrame: Number(m[2]) } : null;
}

/**
 * §28.11 緑線写像: comp(A) の childFrame を comp(B) タイムライン位置へ戻す。
 * childFrame = parentFrame − inPoint + trimStart（§23.2）の逆。
 */
export function precompChildToParentFrame(childFrame: number, trimStart: number, inPoint: number): number {
  return childFrame - trimStart + inPoint;
}
