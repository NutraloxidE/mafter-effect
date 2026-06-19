import type { CacheEntryMeta } from "./types";

interface MemoryEntry {
  data: Uint8Array;
  meta: CacheEntryMeta;
}

/** L1 メモリ LRU。明示バイト計上。 */
export class MemoryCacheTier {
  private entries = new Map<string, MemoryEntry>();
  private totalBytes = 0;

  constructor(private maxBytes: number) {}

  setMaxBytes(maxBytes: number): void {
    this.maxBytes = maxBytes;
  }

  get(key: string): Uint8Array | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.data;
  }

  put(key: string, data: Uint8Array, meta: CacheEntryMeta): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.totalBytes -= existing.meta.byteSize;
      this.entries.delete(key);
    }
    this.entries.set(key, { data, meta });
    this.totalBytes += meta.byteSize;
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.totalBytes -= entry.meta.byteSize;
    this.entries.delete(key);
    return true;
  }

  /** LRU 順（古い→新しい）でキーを返す。 */
  lruKeys(): string[] {
    return [...this.entries.keys()];
  }

  peek(key: string): { data: Uint8Array; meta: CacheEntryMeta } | null {
    return this.entries.get(key) ?? null;
  }

  evictKey(key: string): { data: Uint8Array; meta: CacheEntryMeta } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.totalBytes -= entry.meta.byteSize;
    this.entries.delete(key);
    return entry;
  }

  clear(prefix?: string): void {
    if (!prefix) {
      this.entries.clear();
      this.totalBytes = 0;
      return;
    }
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        const entry = this.entries.get(key)!;
        this.totalBytes -= entry.meta.byteSize;
        this.entries.delete(key);
      }
    }
  }

  listKeys(prefix?: string): string[] {
    const keys = [...this.entries.keys()];
    if (!prefix) return keys;
    return keys.filter((k) => k.startsWith(prefix));
  }

  stats(): { memoryBytes: number; entryCount: number } {
    return { memoryBytes: this.totalBytes, entryCount: this.entries.size };
  }

  isOverBudget(): boolean {
    return this.totalBytes > this.maxBytes;
  }
}
