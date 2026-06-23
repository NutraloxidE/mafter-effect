// §26.3.1 Font ドロップダウン候補。一般的なブラウザで追加インストール無しに開ける family。
// value は font-family にそのまま渡す文字列（フォールバック付きスタック）。stored `font` 文字列と
// 完全一致したとき選択状態になる。既存挙動どおり描画経路はこの文字列をそのまま使う。

import { BUILTIN_FONTS } from "../runtime/builtinFonts";

export interface FontOption {
  label: string;
  value: string;
}

// §26.3.2 同梱フォント。value はスタック先頭が built-in family（CSS は @font-face を選ぶ）。
export const BUNDLED_FONTS: FontOption[] = BUILTIN_FONTS.map((f) => ({
  label: f.label,
  value: `'${f.family}', sans-serif`,
}));

export const WEB_SAFE_FONTS: FontOption[] = [
  { label: "System Sans", value: "sans-serif" },
  { label: "System Serif", value: "serif" },
  { label: "System Mono", value: "monospace" },
  { label: "System UI", value: "system-ui" },
  { label: "Cursive", value: "cursive" },
  { label: "Arial", value: "Arial, sans-serif" },
  { label: "Helvetica", value: "Helvetica, Arial, sans-serif" },
  { label: "Times New Roman", value: "'Times New Roman', Times, serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Courier New", value: "'Courier New', Courier, monospace" },
  { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { label: "Trebuchet MS", value: "'Trebuchet MS', Helvetica, sans-serif" },
  { label: "Tahoma", value: "Tahoma, Geneva, sans-serif" },
  { label: "Impact", value: "Impact, Charcoal, sans-serif" },
  { label: "Comic Sans MS", value: "'Comic Sans MS', cursive" },
];

/** stored font 文字列が候補リストに存在するか。Custom 判定に使う。 */
export function isKnownFont(font: string): boolean {
  return (
    BUNDLED_FONTS.some((f) => f.value === font) ||
    WEB_SAFE_FONTS.some((f) => f.value === font)
  );
}
