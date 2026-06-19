import type { Frame, ObjectId } from "../core/schema";
import type { RasterBuffer } from "./plugin";

/** §26.4.2 / §28.8 レイヤー raster キャッシュ。 */
export interface CachedFrame {
  data: RasterBuffer;
}

export interface FrameRenderCacheKey {
  objectId: ObjectId;
  frame: Frame;
  propsHash: string;
}

export interface FrameRenderCache {
  get(key: FrameRenderCacheKey): Promise<CachedFrame | null>;
  put(key: FrameRenderCacheKey, value: CachedFrame): Promise<void>;
  invalidate(objectId: ObjectId): Promise<void>;
}

/** no-op 実装。常に miss。 */
export class NoOpFrameRenderCache implements FrameRenderCache {
  async get(_key: FrameRenderCacheKey): Promise<CachedFrame | null> {
    return null;
  }
  async put(_key: FrameRenderCacheKey, _value: CachedFrame): Promise<void> {
    /* no-op */
  }
  async invalidate(_objectId: ObjectId): Promise<void> {
    /* no-op */
  }
}

export const globalFrameRenderCache: FrameRenderCache = new NoOpFrameRenderCache();
