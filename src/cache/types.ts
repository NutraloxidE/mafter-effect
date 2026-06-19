/** §28 Preview Cache — ティアードストレージ型。 */

export interface CacheEntryMeta {
  byteSize: number;
  width: number;
  height: number;
  format: "png" | "rgba";
}

export interface CacheStats {
  memoryBytes: number;
  diskBytes: number;
  entryCount: number;
}

export interface DiskCacheTier {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array, meta: CacheEntryMeta): Promise<void>;
  delete(key: string): Promise<void>;
  clear(prefix?: string): Promise<void>;
  listKeys(prefix?: string): Promise<string[]>;
  stats(): Promise<{ diskBytes: number; entryCount: number }>;
}

export interface TieredCacheStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array, meta: CacheEntryMeta): Promise<void>;
  delete(key: string): Promise<void>;
  clear(prefix?: string): Promise<void>;
  listKeys(prefix?: string): Promise<string[]>;
  stats(): Promise<CacheStats>;
}
