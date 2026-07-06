// Electron のポータブル版は file:///C:/.../dist/index.html として起動するため、
// public/ 配下アセットへのルート絶対パス（"/foo"）は file:// のルートに解決され
// dist/ ディレクトリごと消える（"Failed to fetch" の原因）。vite.config.ts の
// base（web "/" / Electron file build "./"）を document.baseURI から相対解決することで
// 両ビルドとも正しい絶対 URL にする。

/** 純関数部分。env/DOM に依存せずテストできる。 */
export function resolvePublicAssetUrl(
  path: string,
  basePrefix: string,
  documentBaseURI: string,
): string {
  const clean = path.replace(/^\/+/, "");
  return new URL(basePrefix + clean, documentBaseURI).href;
}

/** public/ 配下のファイルパス（例: "fonts", "motion-track/pkg/quar_engine.js"）を
 * 実行環境（web / Electron file build）に応じた絶対 URL に解決する。 */
export function publicAssetUrl(path: string): string {
  const basePrefix = import.meta.env?.BASE_URL ?? "/";
  const documentBaseURI = typeof document !== "undefined" ? document.baseURI : "http://localhost/";
  return resolvePublicAssetUrl(path, basePrefix, documentBaseURI);
}
