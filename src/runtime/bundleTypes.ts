import type { Project } from "../core/schema";

/** §11.7 Folder bundle — file:// 互換のため project + テキスト資産を埋め込む。 */
export interface BundleManifest {
  compId: string;
  fps: number;
  range: [number, number];
  loop: boolean;
  textRenderMode: "precise" | "draft";
  assetBase: string;
  project: Project;
  /** UTF-8 テキストファイル path → content（scripts / html comp JS / live plugin 等）。 */
  textFiles: Record<string, string>;
  /** 小さいバイナリ（font 等）path → base64。画像は ZIP 相対パスを使用。 */
  blobs: Record<string, string>;
  /** §26.3.2 使用された built-in フォント。zip 同梱ファイルを family×weight で登録する。 */
  builtinFonts?: BundleBuiltinFont[];
}

export interface BundleBuiltinFont {
  family: string;
  weight: number;
  /** zip 内の相対パス（例: "fonts/NotoSansJP-Regular.ttf"）。 */
  path: string;
}

export interface BundleBootConfig {
  stage: HTMLElement;
  manifest: BundleManifest;
}
