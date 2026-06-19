import type { CacheEntryMeta, DiskCacheTier } from "../cache/types";

const DEFAULT_DB = "mafter-effect-preview-cache";
const STORE = "entries";

interface StoredEntry {
  data: Uint8Array;
  meta: CacheEntryMeta;
}

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** §28 L2 — プロジェクト FS とは別 IndexedDB。 */
export class PreviewCacheDb implements DiskCacheTier {
  private dbPromise: Promise<IDBDatabase>;
  private diskBytes = 0;
  private entryCount = 0;
  private statsLoaded = false;

  constructor(dbName: string = DEFAULT_DB) {
    this.dbPromise = openDb(dbName);
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.dbPromise;
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  private async ensureStats(): Promise<void> {
    if (this.statsLoaded) return;
    const store = await this.store("readonly");
    const keys = (await promisifyRequest(store.getAllKeys())) as IDBValidKey[];
    let bytes = 0;
    for (const k of keys) {
      const row = (await promisifyRequest(store.get(k))) as StoredEntry | undefined;
      if (row) bytes += row.meta.byteSize;
    }
    this.diskBytes = bytes;
    this.entryCount = keys.length;
    this.statsLoaded = true;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const store = await this.store("readonly");
    const row = (await promisifyRequest(store.get(key))) as StoredEntry | undefined;
    return row?.data ?? null;
  }

  async put(key: string, data: Uint8Array, meta: CacheEntryMeta): Promise<void> {
    const store = await this.store("readwrite");
    const prev = (await promisifyRequest(store.get(key))) as StoredEntry | undefined;
    await promisifyRequest(store.put({ data, meta }, key));
    await this.ensureStats();
    if (prev) this.diskBytes += meta.byteSize - prev.meta.byteSize;
    else {
      this.diskBytes += meta.byteSize;
      this.entryCount += 1;
    }
  }

  async delete(key: string): Promise<void> {
    const store = await this.store("readwrite");
    const prev = (await promisifyRequest(store.get(key))) as StoredEntry | undefined;
    await promisifyRequest(store.delete(key));
    if (prev) {
      this.diskBytes -= prev.meta.byteSize;
      this.entryCount -= 1;
    }
  }

  async clear(prefix?: string): Promise<void> {
    const store = await this.store("readwrite");
    const keys = (await promisifyRequest(store.getAllKeys())) as IDBValidKey[];
    for (const k of keys) {
      const key = String(k);
      if (!prefix || key.startsWith(prefix)) {
        await promisifyRequest(store.delete(k));
      }
    }
    this.statsLoaded = false;
    await this.ensureStats();
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const store = await this.store("readonly");
    const keys = (await promisifyRequest(store.getAllKeys())) as IDBValidKey[];
    const out = keys.map(String);
    if (!prefix) return out.sort();
    return out.filter((k) => k.startsWith(prefix)).sort();
  }

  async stats(): Promise<{ diskBytes: number; entryCount: number }> {
    await this.ensureStats();
    return { diskBytes: this.diskBytes, entryCount: this.entryCount };
  }
}

/** テスト用インメモリ L2。 */
export class InMemoryDiskCacheTier implements DiskCacheTier {
  private entries = new Map<string, StoredEntry>();

  async get(key: string): Promise<Uint8Array | null> {
    return this.entries.get(key)?.data ?? null;
  }

  async put(key: string, data: Uint8Array, meta: CacheEntryMeta): Promise<void> {
    this.entries.set(key, { data, meta });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async clear(prefix?: string): Promise<void> {
    if (!prefix) {
      this.entries.clear();
      return;
    }
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const keys = [...this.entries.keys()];
    if (!prefix) return keys.sort();
    return keys.filter((k) => k.startsWith(prefix)).sort();
  }

  async stats(): Promise<{ diskBytes: number; entryCount: number }> {
    let diskBytes = 0;
    for (const e of this.entries.values()) diskBytes += e.meta.byteSize;
    return { diskBytes, entryCount: this.entries.size };
  }
}
