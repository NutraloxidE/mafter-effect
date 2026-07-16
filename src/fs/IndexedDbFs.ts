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
    req.onsuccess = () => {
      // 他タブの upgrade をブロックしない。閉じた接続は tx() が再オープンする。
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
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
  private readonly dbName: string;

  constructor(dbName: string = DEFAULT_DB) {
    this.dbName = dbName;
    this.dbPromise = openDb(dbName);
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.dbPromise;
    try {
      return db.transaction(STORE, mode).objectStore(STORE);
    } catch {
      // "Failed to execute 'transaction' on 'IDBDatabase'" — 接続が閉じている
      // （versionchange / 大きい blob でのブラウザ強制クローズ / abort 後）。
      // 再オープンせずに握ると以後の write が全部落ち、自動保存が黙って死ぬ。
      this.dbPromise = openDb(this.dbName);
      const db2 = await this.dbPromise;
      return db2.transaction(STORE, mode).objectStore(STORE);
    }
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

  /**
   * §Phase3（preview-rendering-pipeline-optimization-plan）: 複数パスを単一 readonly
   * トランザクションで一括取得する（見つからないキーは Map に含めない）。
   * IndexedDbFs 固有メソッド — `FileSystem` インターフェースは拡張しない（他 FS は逐次 read
   * にフォールバック、呼び出し側で optional method 判定する）。
   */
  async readBatch(paths: string[]): Promise<Map<string, Uint8Array>> {
    const store = await this.tx("readonly");
    const out = new Map<string, Uint8Array>();
    // 同一 microtask 内で全 get を発行 → 1 トランザクションにまとまる（間に await を挟まない）。
    const jobs = paths.map((p) => {
      const key = normalizePath(p);
      return promisifyRequest<unknown>(store.get(key)).then((r) => {
        if (r !== undefined) out.set(key, r as Uint8Array);
      });
    });
    await Promise.all(jobs);
    return out;
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
