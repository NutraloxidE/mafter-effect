import type { Font } from "opentype.js";

export type TextAlign = "left" | "center" | "right";

export interface LocalBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** CSS `line-height: normal` 相当（leading=0 時）。 */
export function textLineHeightPx(size: number, leading: number): number {
  return leading > 0 ? leading : size * 1.2;
}

/** 行 y=0 の上端を 0 に揃えるための baseline オフセット（AE テキストボックス上端基準）。 */
export function textAscenderPx(size: number, font: Font | null): number {
  if (font && font.unitsPerEm > 0) {
    return (font.ascender / font.unitsPerEm) * size;
  }
  return size * 0.76;
}

/**
 * SVG / opentype 用 baseline Y。
 * GG 分解前の Draft DOM（line-height + half-leading）に Best を揃える。
 */
export function textBaselineY(
  lineY: number,
  size: number,
  leading: number,
  font: Font | null,
  measureCtx?: CanvasRenderingContext2D | null,
  sampleChar?: string,
): number {
  const lh = textLineHeightPx(size, leading);
  const halfLeading = Math.max(0, (lh - size) / 2);
  if (font && font.unitsPerEm > 0) {
    return lineY + halfLeading + (font.ascender / font.unitsPerEm) * size;
  }
  if (measureCtx) {
    const m = measureCtx.measureText(sampleChar ?? "M");
    if (m.actualBoundingBoxAscent > 0) {
      return lineY + halfLeading + m.actualBoundingBoxAscent;
    }
  }
  return lineY + halfLeading + textAscenderPx(size, null);
}

/** 描画・プレビューハンドル共用のコンテンツ境界（content-local, 原点左上）。 */
export function computeTextContentBounds(
  text: string,
  size: number,
  tracking: number,
  leading: number,
  align: TextAlign,
  font: Font | null,
): LocalBounds {
  if (size <= 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const lineHeight = textLineHeightPx(size, leading);
  const lines = layoutTextLines(text, size, tracking, lineHeight, align, font);
  if (lines.length === 0) {
    return { minX: 0, minY: 0, maxX: Math.max(1, size * 0.5), maxY: lineHeight };
  }

  let minX = 0;
  let maxX = 0;
  let maxY = 0;
  for (const line of lines) {
    maxY = Math.max(maxY, line.y + lineHeight);
    if (line.glyphs.length === 0) {
      maxX = Math.max(maxX, 0);
      continue;
    }
    let lineMin = Infinity;
    let lineMax = -Infinity;
    for (const g of line.glyphs) {
      lineMin = Math.min(lineMin, g.x);
      const adv = font
        ? font.getAdvanceWidth(g.char, size)
        : size * 0.6;
      lineMax = Math.max(lineMax, g.x + adv);
    }
    minX = Math.min(minX, lineMin);
    maxX = Math.max(maxX, lineMax);
  }

  if (!Number.isFinite(minX)) minX = 0;
  if (!Number.isFinite(maxX) || maxX <= minX) maxX = minX + Math.max(1, size * 0.5);

  return { minX, minY: 0, maxX, maxY: Math.max(lineHeight, maxY) };
}

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
