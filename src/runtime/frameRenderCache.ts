import type { Frame, ObjectId } from "../core/schema";

/** §26.4.2 将来拡張用。MVP は get() が常に miss を返す no-op 実装。 */
export interface CachedFrame {
  /** キャッシュされた描画結果（将来: canvas / bitmap）。 */
  data: unknown;
}

export interface FrameRenderCacheKey {
  objectId: ObjectId;
  frame: Frame;
  propsHash: string;
}

export interface FrameRenderCache {
  get(key: FrameRenderCacheKey): CachedFrame | null;
  put(key: FrameRenderCacheKey, value: CachedFrame): void;
  invalidate(objectId: ObjectId): void;
}

/** no-op 実装。常に miss。 */
export class NoOpFrameRenderCache implements FrameRenderCache {
  get(_key: FrameRenderCacheKey): CachedFrame | null {
    return null;
  }
  put(_key: FrameRenderCacheKey, _value: CachedFrame): void {
    /* no-op */
  }
  invalidate(_objectId: ObjectId): void {
    /* no-op */
  }
}

export const globalFrameRenderCache: FrameRenderCache = new NoOpFrameRenderCache();
