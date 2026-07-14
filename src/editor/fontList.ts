// §26.3.1 Font ドロップダウン候補。一般的なブラウザで追加インストール無しに開ける family。
// value は font-family にそのまま渡す文字列（フォールバック付きスタック）。stored `font` 文字列と
// 完全一致したとき選択状態になる。既存挙動どおり描画経路はこの文字列をそのまま使う。

import { BUILTIN_FONTS, isBuiltinFontFamily, primaryFontFamily } from "../runtime/builtinFonts";
import type { Project } from "../core/schema";

export interface FontOption {
  label: string;
  value: string;
}

// §26.3.2 同梱フォント。value はスタック先頭が built-in family（CSS は @font-face を選ぶ）。
export const BUNDLED_FONTS: FontOption[] = BUILTIN_FONTS.map((f) => ({
  label: f.label,
  value: `'${f.family}', sans-serif`,
}));

// Web safe（OS システムフォント）は実ファイルを取得できず 3D Extrude 不可（原理的な制約）。
// label に (no-3D) を明示し、Inspector の 3D セクションでも警告する。
export const WEB_SAFE_FONTS: FontOption[] = [
  { label: "System Sans (no-3D)", value: "sans-serif" },
  { label: "System Serif (no-3D)", value: "serif" },
  { label: "System Mono (no-3D)", value: "monospace" },
  { label: "System UI (no-3D)", value: "system-ui" },
  { label: "Cursive (no-3D)", value: "cursive" },
  { label: "Arial (no-3D)", value: "Arial, sans-serif" },
  { label: "Helvetica (no-3D)", value: "Helvetica, Arial, sans-serif" },
  { label: "Times New Roman (no-3D)", value: "'Times New Roman', Times, serif" },
  { label: "Georgia (no-3D)", value: "Georgia, serif" },
  { label: "Courier New (no-3D)", value: "'Courier New', Courier, monospace" },
  { label: "Verdana (no-3D)", value: "Verdana, Geneva, sans-serif" },
  { label: "Trebuchet MS (no-3D)", value: "'Trebuchet MS', Helvetica, sans-serif" },
  { label: "Tahoma (no-3D)", value: "Tahoma, Geneva, sans-serif" },
  { label: "Impact (no-3D)", value: "Impact, Charcoal, sans-serif" },
  { label: "Comic Sans MS (no-3D)", value: "'Comic Sans MS', cursive" },
];

/** 3D Extrude 可能なフォントか（Bundled または font asset として取り込み済み）。 */
export function is3DCapableFont(font: string, project: Project | null): boolean {
  if (isBuiltinFontFamily(font)) return true;
  const fam = primaryFontFamily(font);
  return !!project?.assets.some((a) => a.kind === "font" && a.meta?.family === fam);
}

/** stored font 文字列が候補リストに存在するか。Custom 判定に使う。 */
export function isKnownFont(font: string): boolean {
  return (
    BUNDLED_FONTS.some((f) => f.value === font) ||
    WEB_SAFE_FONTS.some((f) => f.value === font)
  );
}
