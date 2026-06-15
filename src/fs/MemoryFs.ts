import {
  bytesToText,
  isUnder,
  normalizePath,
  toBytes,
  type FileSystem,
} from "./FileSystem";

// インメモリ FileSystem。テスト・一時プロジェクト用。
// IndexedDbFs と同一のパスセマンティクスを持つ（INV-4 の差分検証に使う）。
export class MemoryFs implements FileSystem {
  private files = new Map<string, Uint8Array>();

  async read(path: string): Promise<Uint8Array> {
    const key = normalizePath(path);
    const data = this.files.get(key);
    if (data === undefined) {
      throw new Error(`MemoryFs: file not found: ${key}`);
    }
    return data;
  }

  async readText(path: string): Promise<string> {
    return bytesToText(await this.read(path));
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    this.files.set(normalizePath(path), toBytes(data));
  }

  async list(dir: string): Promise<string[]> {
    const prefix = normalizePath(dir);
    const out: string[] = [];
    for (const key of this.files.keys()) {
      if (isUnder(prefix, key)) out.push(key);
    }
    return out.sort();
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(normalizePath(path));
  }

  async delete(path: string): Promise<void> {
    this.files.delete(normalizePath(path));
  }

  async mkdir(_path: string): Promise<void> {
    // フラットな key-value ストアにディレクトリ実体は無い（INV-4: パスは prefix で表現）。
    // ディレクトリは中身のファイルの存在によって暗黙に表現される。
  }
}
