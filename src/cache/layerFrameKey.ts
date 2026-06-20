import type { ObjectId } from "../core/schema";

/** §28.8 レイヤー raster キャッシュキー（§26.4.2）。 */
export function buildLayerFrameCacheKey(params: {
  objectId: ObjectId;
  frame: number;
  propsHash: string;
}): string {
  return `layer:${params.objectId}:f${params.frame}:hash${params.propsHash}`;
}

export function layerFrameCachePrefix(objectId: ObjectId): string {
  return `layer:${objectId}:`;
}

/** すべての per-layer raster キーの共通 prefix（objectId 横断列挙用）。 */
export const LAYER_FRAME_CACHE_PREFIX = "layer:";

/** レイヤーキーから objectId と local frame を抽出（§28.10）。非該当キーは null。 */
export function parseLayerFrameKey(key: string): { objectId: string; localFrame: number } | null {
  const m = /^layer:([^:]+):f(\d+):/.exec(key);
  return m ? { objectId: m[1]!, localFrame: Number(m[2]) } : null;
}
