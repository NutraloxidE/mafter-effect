import type { RasterBuffer } from "./plugin";
import { buildLayerFrameCacheKey, layerFrameCachePrefix } from "../cache/layerFrameKey";
import type { TieredCacheStore } from "../cache/types";
import type { CachedFrame, FrameRenderCache, FrameRenderCacheKey } from "./frameRenderCache";

const HEADER_BYTES = 12;

function encodeRaster(buffer: RasterBuffer): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + buffer.data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, buffer.width, true);
  view.setUint32(4, buffer.height, true);
  view.setUint32(8, buffer.data.byteLength, true);
  out.set(buffer.data, HEADER_BYTES);
  return out;
}

function decodeRaster(bytes: Uint8Array): RasterBuffer | null {
  if (bytes.byteLength < HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const dataLen = view.getUint32(8, true);
  if (HEADER_BYTES + dataLen !== bytes.byteLength) return null;
  return {
    width,
    height,
    data: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + HEADER_BYTES, dataLen),
  };
}

function keyToString(key: FrameRenderCacheKey): string {
  return buildLayerFrameCacheKey(key);
}

/** §28.8 §26.4.2 — TieredCacheStore バックエンド付き FrameRenderCache。 */
export class TieredFrameRenderCache implements FrameRenderCache {
  private memory = new Map<string, RasterBuffer>();

  constructor(private store: TieredCacheStore) {}

  async get(key: FrameRenderCacheKey): Promise<CachedFrame | null> {
    const k = keyToString(key);
    const mem = this.memory.get(k);
    if (mem) return { data: mem };
    const bytes = await this.store.get(k);
    if (!bytes) return null;
    const buffer = decodeRaster(bytes);
    if (!buffer) return null;
    this.memory.set(k, buffer);
    return { data: buffer };
  }

  async put(key: FrameRenderCacheKey, value: CachedFrame): Promise<void> {
    const buffer = value.data as RasterBuffer;
    const k = keyToString(key);
    this.memory.set(k, buffer);
    const bytes = encodeRaster(buffer);
    await this.store.put(k, bytes, {
      byteSize: bytes.byteLength,
      width: buffer.width,
      height: buffer.height,
      format: "rgba",
    });
  }

  async invalidate(objectId: string): Promise<void> {
    const prefix = layerFrameCachePrefix(objectId);
    for (const k of [...this.memory.keys()]) {
      if (k.startsWith(prefix)) this.memory.delete(k);
    }
    await this.store.clear(prefix);
  }
}
