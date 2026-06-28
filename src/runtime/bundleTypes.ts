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

/**
 * export 時に `public/player.js` の鮮度を sanity check するためのマーカー文字列。
 * player が必ず出力に含む安定トークンで、最新の機能配線を表す。`src/player`・`src/runtime`
 * を変えて player を再ビルドし忘れると、古い `public/player.js` がそのまま zip に埋め込まれ、
 * 「動画は出るが新機能（expression preset 等）だけ無音で効かない」事故になる。これを export
 * 直前に検出する。最終防御は実ビルド一致を見る test/playerBuildFreshness.test.ts。
 * player の expression/preset 配線を変えたら、このマーカーも最新機能を表す安定トークンに更新する。
 */
export const PLAYER_FRESHNESS_MARKER = "presetParams";
