import { parse as parseFont, type Font } from "opentype.js";
import type { Project } from "../core/schema";
import type { FileSystem } from "../fs/FileSystem";
import { primaryFontFamily } from "./builtinFonts";

/** meta.weight を持たない旧 project の font asset に与える既定 weight。 */
const DEFAULT_FONT_WEIGHT = 400;

function keyOf(family: string, weight: number): string {
  return `${primaryFontFamily(family)}|${weight}`;
}

/** §26.4.1 asset フォントの opentype パース結果キャッシュ。family×weight で引く。 */
export class FontOutlineCache {
  private readonly byKey = new Map<string, Font>();
  /** family → 登録済み weight 群（最近傍フォールバック用）。 */
  private readonly weightsByFamily = new Map<string, number[]>();
  private readonly byPath = new Map<string, Font>();

  /**
   * family×weight のアウトラインを返す。完全一致が無ければ同 family の最近傍 weight を使う
   * （3D 押し出しが 2D CSS と同じ face を見るため。§26.4.1）。
   */
  getFont(family: string, weight: number = DEFAULT_FONT_WEIGHT): Font | null {
    const fam = primaryFontFamily(family);
    const exact = this.byKey.get(keyOf(fam, weight));
    if (exact) return exact;
    const available = this.weightsByFamily.get(fam);
    if (!available || available.length === 0) return null;
    let best = available[0]!;
    for (const w of available) {
      if (Math.abs(w - weight) < Math.abs(best - weight)) best = w;
    }
    return this.byKey.get(keyOf(fam, best)) ?? null;
  }

  parseBuffer(family: string, buffer: ArrayBuffer, weight: number = DEFAULT_FONT_WEIGHT): Font {
    const font = parseFont(buffer);
    this.register(family, weight, font);
    return font;
  }

  private register(family: string, weight: number, font: Font): void {
    const fam = primaryFontFamily(family);
    this.byKey.set(keyOf(fam, weight), font);
    const list = this.weightsByFamily.get(fam);
    if (!list) this.weightsByFamily.set(fam, [weight]);
    else if (!list.includes(weight)) list.push(weight);
  }

  /** project.assets の font を FS から読み込む。family は meta.family またはファイル名 stem。 */
  async loadFromProject(project: Project, fs: FileSystem): Promise<void> {
    for (const asset of project.assets) {
      if (asset.kind !== "font") continue;
      if (this.byPath.has(asset.path)) continue;
      try {
        const buf = await fs.read(asset.path);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const family = primaryFontFamily(
          typeof asset.meta?.family === "string"
            ? asset.meta.family
            : asset.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? asset.id,
        );
        const font = parseFont(ab);
        const weight = typeof asset.meta?.weight === "number" ? asset.meta.weight : DEFAULT_FONT_WEIGHT;
        this.byPath.set(asset.path, font);
        this.register(family, weight, font);
      } catch {
        /* skip unreadable font */
      }
    }
  }
}
