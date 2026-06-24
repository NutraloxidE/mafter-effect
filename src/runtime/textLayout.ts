import type { Font } from "opentype.js";

export type TextAlign = "left" | "center" | "right" | "justify";

function isSpaceChar(c: string): boolean {
  return c === " " || c === "\t";
}

/**
 * 1 行ぶんの文字列幅（advance 合計 + inter-char tracking）。決定論（INV-1）。
 */
function seqWidth(chars: string[], advance: (c: string) => number, tracking: number): number {
  if (chars.length === 0) return 0;
  let w = 0;
  for (const c of chars) w += advance(c);
  return w + tracking * (chars.length - 1);
}

/** boxWidth を超える単一トークンを文字境界で分割（最低 1 文字/行を保証）。 */
function breakLongWord(
  word: string[],
  boxWidth: number,
  advance: (c: string) => number,
  tracking: number,
): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const c of word) {
    if (cur.length > 0 && seqWidth([...cur, c], advance, tracking) > boxWidth) {
      out.push(cur);
      cur = [c];
    } else {
      cur.push(c);
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * 1 段落（明示改行で区切られた raw line）を boxWidth でグリーディにワードラップする。
 * 空白境界で折返し、折返し時の空白は捨てる（CSS/AE 準拠）。決定論（INV-1）。
 */
function wrapParagraph(
  chars: string[],
  boxWidth: number,
  advance: (c: string) => number,
  tracking: number,
): string[][] {
  const out: string[][] = [];
  let line: string[] = [];
  let i = 0;

  const placeWord = (word: string[]): void => {
    if (seqWidth(word, advance, tracking) <= boxWidth) {
      line = [...word];
      return;
    }
    const broken = breakLongWord(word, boxWidth, advance, tracking);
    for (let k = 0; k < broken.length - 1; k++) out.push(broken[k]!);
    line = broken[broken.length - 1]!;
  };

  while (i < chars.length) {
    const spaces: string[] = [];
    while (i < chars.length && isSpaceChar(chars[i]!)) spaces.push(chars[i++]!);
    const word: string[] = [];
    while (i < chars.length && !isSpaceChar(chars[i]!)) word.push(chars[i++]!);

    if (word.length === 0) {
      // 末尾の空白だけ残った: 現在行に付けて終わる（折返し判定はしない）。
      for (const s of spaces) line.push(s);
      continue;
    }
    if (line.length === 0) {
      placeWord(word);
    } else {
      const candidate = [...line, ...spaces, ...word];
      if (seqWidth(candidate, advance, tracking) <= boxWidth) {
        line = candidate;
      } else {
        out.push(line);
        line = [];
        placeWord(word);
      }
    }
  }
  out.push(line);
  return out;
}

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
  boxWidth = 0,
): LocalBounds {
  if (size <= 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const lineHeight = textLineHeightPx(size, leading);
  const lines = layoutTextLines(text, size, tracking, lineHeight, align, font, measureChar, boxWidth);
  if (lines.length === 0) {
    return { minX: 0, minY: 0, maxX: Math.max(1, size * 0.5), maxY: lineHeight };
  }

  // box text: ギズモ/anchor は箱 [0, boxWidth] が基準（内容ではなく枠）。
  if (boxWidth > 0) {
    let maxY = 0;
    for (const line of lines) maxY = Math.max(maxY, line.y + lineHeight);
    return { minX: 0, minY: 0, maxX: Math.max(1, boxWidth), maxY: Math.max(lineHeight, maxY) };
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

/**
 * 改行で分割し tracking/leading/align/boxWidth を反映した行レイアウト（決定論・INV-1）。
 * boxWidth>0 のとき各段落を boxWidth でワードラップし、align は箱 [0,boxWidth] 基準。
 * boxWidth<=0（point text）のとき折返さず、center/right は内容相対（anchor 相対・§26.4）。
 */
export function layoutTextLines(
  text: string,
  size: number,
  tracking: number,
  lineHeight: number,
  align: TextAlign,
  font: Font | null,
  measureChar?: (char: string) => number,
  boxWidth = 0,
): LayoutLine[] {
  const advance = (char: string): number => {
    if (char === "\n" || char === "\r") return 0;
    if (font) return font.getAdvanceWidth(char, size);
    if (measureChar) return measureChar(char);
    return size * 0.6;
  };
  const box = boxWidth > 0 ? boxWidth : 0;

  const rawLines = text.split("\n");
  // 各 raw line（段落）を視覚行に展開。lastInParagraph は justify の最終行除外に使う。
  const visual: { chars: string[]; lastInParagraph: boolean }[] = [];
  for (const raw of rawLines) {
    const chars = [...raw].filter((c) => c !== "\r");
    if (box <= 0) {
      visual.push({ chars, lastInParagraph: true });
      continue;
    }
    const wrapped = wrapParagraph(chars, box, advance, tracking);
    wrapped.forEach((vl, idx) => {
      visual.push({ chars: vl, lastInParagraph: idx === wrapped.length - 1 });
    });
  }

  const lines: LayoutLine[] = [];
  let y = 0;
  for (const { chars, lastInParagraph } of visual) {
    const glyphs: LayoutGlyph[] = [];
    const spaceGlyphIdx: number[] = [];
    let x = 0;
    let lineText = "";
    for (const char of chars) {
      lineText += char;
      glyphs.push({ char, x, y });
      if (isSpaceChar(char)) spaceGlyphIdx.push(glyphs.length - 1);
      x += advance(char) + tracking;
    }
    const width = glyphs.length > 0 ? x - tracking : 0;

    let offsetX = 0;
    const justify = align === "justify" && box > 0 && !lastInParagraph && spaceGlyphIdx.length > 0;
    if (justify) {
      // 語間スペースに余白を均等配分して箱幅まで広げる。
      const extra = (box - width) / spaceGlyphIdx.length;
      if (extra > 0) {
        let added = 0;
        let si = 0;
        for (let gi = 0; gi < glyphs.length; gi++) {
          glyphs[gi]!.x += added;
          if (si < spaceGlyphIdx.length && gi === spaceGlyphIdx[si]) {
            added += extra;
            si++;
          }
        }
      }
    } else if (box > 0) {
      // 箱基準 [0, boxWidth]
      if (align === "center") offsetX = (box - width) / 2;
      else if (align === "right") offsetX = box - width;
      // left / justify-最終行 = 0
      if (offsetX !== 0) for (const g of glyphs) g.x += offsetX;
    } else {
      // point text: 内容相対（anchor 相対）
      if (align === "center") offsetX = -width / 2;
      else if (align === "right") offsetX = -width;
      // left / justify(箱なし) = 0
      if (offsetX !== 0) for (const g of glyphs) g.x += offsetX;
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
  boxWidth = 0,
): ResolvedTextLayout {
  const lineHeight = textLineHeightPx(size, leading);
  const lines = layoutTextLines(text, size, tracking, lineHeight, align, font, measureChar, boxWidth);
  const bounds = computeTextContentBounds(text, size, tracking, leading, align, font, measureChar, boxWidth);
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
  boxWidth = 0,
): GlyphPlacement[] {
  const { lines, bounds } = resolveTextLayout(text, size, tracking, leading, align, null, measureChar, boxWidth);
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
