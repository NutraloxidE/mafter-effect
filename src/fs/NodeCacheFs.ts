import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CacheEntryMeta, DiskCacheTier } from "../cache/types";

function keyToPath(root: string, key: string): string {
  const safe = key.replace(/:/g, "_").replace(/[/\\?%*:|"<>]/g, "_");
  return join(root, `${safe}.bin`);
}

function metaPath(binPath: string): string {
  return `${binPath}.meta.json`;
}

/** §28.8 将来デスクトップ用 L2。Node 環境専用（ブラウザ bundle から import しない）。 */
export class NodeCacheFs implements DiskCacheTier {
  constructor(private root: string) {}

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const path = keyToPath(this.root, key);
    try {
      const buf = await readFile(path);
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  async put(key: string, data: Uint8Array, meta: CacheEntryMeta): Promise<void> {
    await this.ensureRoot();
    const path = keyToPath(this.root, key);
    await writeFile(path, data);
    await writeFile(metaPath(path), JSON.stringify(meta));
  }

  async delete(key: string): Promise<void> {
    const path = keyToPath(this.root, key);
    await rm(path, { force: true });
    await rm(metaPath(path), { force: true });
  }

  async clear(prefix?: string): Promise<void> {
    await this.ensureRoot();
    const files = await readdir(this.root);
    for (const file of files) {
      if (!file.endsWith(".bin")) continue;
      const stem = file.slice(0, -4);
      const keyLike = stem.replace(/_/g, ":");
      if (!prefix || keyLike.startsWith(prefix)) {
        await rm(join(this.root, file), { force: true });
        await rm(join(this.root, `${file}.meta.json`), { force: true });
      }
    }
  }

  async listKeys(prefix?: string): Promise<string[]> {
    await this.ensureRoot();
    const files = await readdir(this.root);
    const keys: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".bin")) continue;
      const keyLike = file.slice(0, -4).replace(/_/g, ":");
      if (!prefix || keyLike.startsWith(prefix)) keys.push(keyLike);
    }
    return keys.sort();
  }

  async stats(): Promise<{ diskBytes: number; entryCount: number }> {
    await this.ensureRoot();
    const files = await readdir(this.root);
    let diskBytes = 0;
    let entryCount = 0;
    for (const file of files) {
      if (!file.endsWith(".bin")) continue;
      entryCount += 1;
      const st = await stat(join(this.root, file));
      diskBytes += st.size;
    }
    return { diskBytes, entryCount };
  }
}
