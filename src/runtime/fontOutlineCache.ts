import { parse as parseFont, type Font } from "opentype.js";
import type { Project } from "../core/schema";
import type { FileSystem } from "../fs/FileSystem";

/** §26.4.1 asset フォントの opentype パース結果キャッシュ。 */
export class FontOutlineCache {
  private readonly byFamily = new Map<string, Font>();
  private readonly byPath = new Map<string, Font>();

  getFont(family: string): Font | null {
    return this.byFamily.get(family) ?? null;
  }

  parseBuffer(family: string, buffer: ArrayBuffer): Font {
    const font = parseFont(buffer);
    this.byFamily.set(family, font);
    return font;
  }

  /** project.assets の font を FS から読み込む。family は meta.family またはファイル名 stem。 */
  async loadFromProject(project: Project, fs: FileSystem): Promise<void> {
    for (const asset of project.assets) {
      if (asset.kind !== "font") continue;
      if (this.byPath.has(asset.path)) continue;
      try {
        const buf = await fs.read(asset.path);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const family =
          typeof asset.meta?.family === "string"
            ? asset.meta.family
            : asset.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? asset.id;
        const font = parseFont(ab);
        this.byPath.set(asset.path, font);
        this.byFamily.set(family, font);
      } catch {
        /* skip unreadable font */
      }
    }
  }
}
