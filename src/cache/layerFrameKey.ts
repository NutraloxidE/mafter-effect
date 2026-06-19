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
