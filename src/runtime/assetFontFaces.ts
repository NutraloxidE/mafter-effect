import type { Project } from "../core/schema";
import type { FileSystem } from "../fs/FileSystem";

const STYLE_ID = "mafter-asset-fonts";
const injected = new Set<string>();

/** project.assets の kind:"font" を @font-face として document に注入する（冪等・2D CSS 描画用）。 */
export async function registerAssetFonts(project: Project, fs: FileSystem): Promise<void> {
  if (typeof document === "undefined") return;
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  for (const asset of project.assets) {
    if (asset.kind !== "font") continue;
    const family = typeof asset.meta?.family === "string" ? asset.meta.family : null;
    if (!family || injected.has(family)) continue;
    try {
      const buf = await fs.read(asset.path);
      const url = URL.createObjectURL(new Blob([new Uint8Array(buf)]));
      style.textContent += `@font-face{font-family:'${family}';src:url('${url}');}\n`;
      injected.add(family);
    } catch {
      /* skip unreadable font */
    }
  }
}
