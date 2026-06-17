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
  // CSS line-box の baseline 配置に一致させる:
  //   baseline = halfLeading + ascent,  halfLeading = (line-height - (ascent + descent)) / 2
  // ascent/descent はフォントメトリクス（CSS が行送り計算に使う値）であって
  // グリフのインク高さ（actualBoundingBox）ではない。ここを取り違えると Draft(DOM) と
  // Best(SVG) で baseline が縦にズレる（§26.4）。
  if (font && font.unitsPerEm > 0) {
    const ascent = (font.ascender / font.unitsPerEm) * size;
    const descent = (-font.descender / font.unitsPerEm) * size; // descender は負値
    return lineY + (lh - (ascent + descent)) / 2 + ascent;
  }
  if (measureCtx) {
    const m = measureCtx.measureText(sampleChar ?? "Mg");
    const fba = m.fontBoundingBoxAscent;
    const fbd = m.fontBoundingBoxDescent;
    if (fba > 0 && fbd >= 0) {
      return lineY + (lh - (fba + fbd)) / 2 + fba;
    }
    if (m.actualBoundingBoxAscent > 0) {
      // fontBoundingBox 非対応環境のフォールバック（近似）
      return lineY + Math.max(0, (lh - size) / 2) + m.actualBoundingBoxAscent;
    }
  }
  return lineY + Math.max(0, (lh - size) / 2) + textAscenderPx(size, null);
}

/** 描画・プレビューハンドル共用のコンテンツ境界（content-local, 原点左上）。 */
export function computeTextContentBounds(
  text: string,
  size: number,
  tracking: number,
  leading: number,
  align: TextAlign,
  font: Font | null,
  measureChar?: (char: string) => number,
): LocalBounds {
  if (size <= 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const lineHeight = textLineHeightPx(size, leading);
  const lines = layoutTextLines(text, size, tracking, lineHeight, align, font, measureChar);
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
        : measureChar
          ? measureChar(g.char)
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

/** 描画・グリフ分解・bounds 計算の共有レイアウト（§26.4 / §26.5 単一の正）。 */
export interface ResolvedTextLayout {
  lines: LayoutLine[];
  bounds: LocalBounds;
  lineHeight: number;
}

export function resolveTextLayout(
  text: string,
  size: number,
  tracking: number,
  leading: number,
  align: TextAlign,
  font: Font | null,
  measureChar?: (char: string) => number,
): ResolvedTextLayout {
  const lineHeight = textLineHeightPx(size, leading);
  const lines = layoutTextLines(text, size, tracking, lineHeight, align, font, measureChar);
  const bounds = computeTextContentBounds(text, size, tracking, leading, align, font, measureChar);
  return { lines, bounds, lineHeight };
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
  const { lines, bounds } = resolveTextLayout(text, size, tracking, leading, align, null, measureChar);
  const out: GlyphPlacement[] = [];
  for (const line of lines) {
    for (const g of line.glyphs) {
      if (!g.char.trim()) continue;
      // renderPreciseText / applyDraftText と同じ content-local 原点（bounds 左上）に揃える。
      out.push({
        char: g.char,
        x: g.x - bounds.minX,
        y: g.y - bounds.minY,
      });
    }
  }
  return out;
}
