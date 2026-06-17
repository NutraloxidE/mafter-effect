import type { Font } from "opentype.js";

export type TextAlign = "left" | "center" | "right";

export interface LayoutGlyph {
  char: string;
  x: number;
  y: number;
}

export interface LayoutLine {
  text: string;
  y: number;
  width: number;
  offsetX: number;
  glyphs: LayoutGlyph[];
}

/** 改行で分割し tracking/leading/align を反映した行レイアウト（決定論・INV-1）。 */
export function layoutTextLines(
  text: string,
  size: number,
  tracking: number,
  lineHeight: number,
  align: TextAlign,
  font: Font | null,
  measureChar?: (char: string) => number,
): LayoutLine[] {
  const measure = (char: string): number => {
    if (char === "\n" || char === "\r") return 0;
    if (font) return font.getAdvanceWidth(char, size) + tracking;
    if (measureChar) return measureChar(char) + tracking;
    return size * 0.6 + tracking;
  };

  const rawLines = text.split("\n");
  const lines: LayoutLine[] = [];
  let y = 0;

  for (const raw of rawLines) {
    const glyphs: LayoutGlyph[] = [];
    let x = 0;
    let lineText = "";
    for (const char of raw) {
      if (char === "\r") continue;
      lineText += char;
      glyphs.push({ char, x, y });
      x += measure(char);
    }
    const width = glyphs.length > 0 ? x - tracking : 0;
    let offsetX = 0;
    if (align === "center") offsetX = -width / 2;
    else if (align === "right") offsetX = -width;

    if (align !== "left") {
      for (const g of glyphs) g.x += offsetX;
    }

    lines.push({ text: lineText, y, width, offsetX, glyphs });
    y += lineHeight;
  }

  return lines;
}

/** §26.5 グリフ分解用: 空白文字を除く配置一覧。 */
export interface GlyphPlacement {
  char: string;
  x: number;
  y: number;
}

export function layoutGlyphsForDecompose(
  text: string,
  size: number,
  tracking: number,
  leading: number,
  align: TextAlign,
  measureChar: (char: string) => number,
): GlyphPlacement[] {
  const lh = leading > 0 ? leading : size * 1.2;
  const lines = layoutTextLines(text, size, tracking, lh, align, null, measureChar);
  const out: GlyphPlacement[] = [];
  for (const line of lines) {
    for (const g of line.glyphs) {
      if (!g.char.trim()) continue;
      out.push({ char: g.char, x: g.x, y: g.y });
    }
  }
  return out;
}
