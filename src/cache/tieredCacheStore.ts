import { MemoryCacheTier } from "./memoryCacheTier";
import type { CacheEntryMeta, CacheStats, DiskCacheTier, TieredCacheStore } from "./types";

export interface TieredCacheStoreOptions {
  maxRamBytes: number;
  diskEnabled: boolean;
  disk: DiskCacheTier;
}

/** §28 L1 メモリ + L2 ディスクのティアードキャッシュ。 */
export class DefaultTieredCacheStore implements TieredCacheStore {
  private memory: MemoryCacheTier;

  constructor(
    private options: TieredCacheStoreOptions,
  ) {
    this.memory = new MemoryCacheTier(options.maxRamBytes);
  }

  setMaxRamBytes(maxRamBytes: number): void {
    this.options.maxRamBytes = maxRamBytes;
    this.memory.setMaxBytes(maxRamBytes);
  }

  setDiskEnabled(enabled: boolean): void {
    this.options.diskEnabled = enabled;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const mem = this.memory.get(key);
    if (mem) return mem;
    if (!this.options.diskEnabled) return null;
    const disk = await this.options.disk.get(key);
    if (!disk) return null;
    const meta: CacheEntryMeta = {
      byteSize: disk.byteLength,
      width: 0,
      height: 0,
      format: "png",
    };
    this.memory.put(key, disk, meta);
    await this.evictMemoryIfNeeded();
    return disk;
  }

  async put(key: string, data: Uint8Array, meta: CacheEntryMeta): Promise<void> {
    this.memory.put(key, data, meta);
    await this.evictMemoryIfNeeded();
  }

  async delete(key: string): Promise<void> {
    this.memory.delete(key);
    if (this.options.diskEnabled) await this.options.disk.delete(key);
  }

  async clear(prefix?: string): Promise<void> {
    this.memory.clear(prefix);
    if (this.options.diskEnabled) await this.options.disk.clear(prefix);
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const memKeys = this.memory.listKeys(prefix);
    if (!this.options.diskEnabled) return memKeys.sort();
    const diskKeys = await this.options.disk.listKeys(prefix);
    return [...new Set([...memKeys, ...diskKeys])].sort();
  }

  async stats(): Promise<CacheStats> {
    const mem = this.memory.stats();
    const disk = this.options.diskEnabled
      ? await this.options.disk.stats()
      : { diskBytes: 0, entryCount: 0 };
    return {
      memoryBytes: mem.memoryBytes,
      diskBytes: disk.diskBytes,
      entryCount: mem.entryCount + disk.entryCount,
    };
  }

  private async evictMemoryIfNeeded(): Promise<void> {
    if (!this.options.diskEnabled) {
      while (this.memory.isOverBudget()) {
        const keys = this.memory.lruKeys();
        if (keys.length === 0) break;
        this.memory.evictKey(keys[0]!);
      }
      return;
    }
    while (this.memory.isOverBudget()) {
      const keys = this.memory.lruKeys();
      if (keys.length === 0) break;
      const evicted = this.memory.evictKey(keys[0]!);
      if (!evicted) break;
      await this.options.disk.put(keys[0]!, evicted.data, evicted.meta);
    }
  }
}
