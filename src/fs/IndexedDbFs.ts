import {
  bytesToText,
  isUnder,
  normalizePath,
  toBytes,
  type FileSystem,
} from "./FileSystem";

// §11.1 IndexedDbFs — path 文字列 → blob(Uint8Array) を 1 つの object store に格納。
// list は全 key を prefix フィルタ（MVP の素直な実装。アセット数が増えたら IDBKeyRange 範囲クエリへ）。
// MemoryFs / NodeFs と同一パスセマンティクスを保つ (INV-4)。

const DEFAULT_DB = "mafter-effect-fs";
const STORE = "files";

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

export class IndexedDbFs implements FileSystem {
  private dbPromise: Promise<IDBDatabase>;

  constructor(dbName: string = DEFAULT_DB) {
    this.dbPromise = openDb(dbName);
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.dbPromise;
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async read(path: string): Promise<Uint8Array> {
    const key = normalizePath(path);
    const store = await this.tx("readonly");
    const result = await promisifyRequest<unknown>(store.get(key));
    if (result === undefined) {
      throw new Error(`IndexedDbFs: file not found: ${key}`);
    }
    // 格納は常に Uint8Array。
    return result as Uint8Array;
  }

  async readText(path: string): Promise<string> {
    return bytesToText(await this.read(path));
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    const store = await this.tx("readwrite");
    await promisifyRequest(store.put(toBytes(data), normalizePath(path)));
  }

  async list(dir: string): Promise<string[]> {
    const prefix = normalizePath(dir);
    const store = await this.tx("readonly");
    const keys = (await promisifyRequest(store.getAllKeys())) as IDBValidKey[];
    const out: string[] = [];
    for (const k of keys) {
      const key = String(k);
      if (isUnder(prefix, key)) out.push(key);
    }
    return out.sort();
  }

  async exists(path: string): Promise<boolean> {
    const store = await this.tx("readonly");
    const key = await promisifyRequest(store.getKey(normalizePath(path)));
    return key !== undefined;
  }

  async delete(path: string): Promise<void> {
    const store = await this.tx("readwrite");
    await promisifyRequest(store.delete(normalizePath(path)));
  }

  async mkdir(_path: string): Promise<void> {
    // フラット key-value ストア。ディレクトリは中身の存在で暗黙表現（INV-4）。
  }
}
