import type { Font, PathCommand } from "opentype.js";
import { resolveTextLayout, textBaselineY, type TextAlign } from "../textLayout";
import { normalizeRingsNonzero } from "./normalizeRings";
import type { OutlineGlyph, Vec2 } from "./geom3dTypes";

/**
 * §5.1 OutlineProvider — text/shape の押し出し入力を「閉じたリング列」へ正規化する共通境界。
 * 本ファイルは text 経路のみ（shape 経路は §9.14 P4 で追加）。
 */

function flattenCubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, segments: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const mt = 1 - t;
    const x = mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x;
    const y = mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y;
    out.push({ x, y });
  }
  return out;
}

function flattenQuadratic(p0: Vec2, p1: Vec2, p2: Vec2, segments: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const mt = 1 - t;
    const x = mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x;
    const y = mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y;
    out.push({ x, y });
  }
  return out;
}

/**
 * opentype.js の Path.commands（M/L/C/Q/Z）を閉じたポリゴンリング列へ分割する（決定論・純関数）。
 * 複数の M（サブパス）はグリフの穴（例: "O"/"A"/"8"）に対応し、それぞれ独立したリングになる。
 */
export function flattenPathCommandsToRings(commands: PathCommand[], segmentsPerCurve: number): Vec2[][] {
  const rings: Vec2[][] = [];
  let current: Vec2[] = [];
  let cursor: Vec2 = { x: 0, y: 0 };
  let start: Vec2 = { x: 0, y: 0 };

  const pushCurrent = (): void => {
    if (current.length >= 3) rings.push(current);
    current = [];
  };

  for (const cmd of commands) {
    switch (cmd.type) {
      case "M": {
        pushCurrent();
        cursor = { x: cmd.x, y: cmd.y };
        start = cursor;
        current.push(cursor);
        break;
      }
      case "L": {
        cursor = { x: cmd.x, y: cmd.y };
        current.push(cursor);
        break;
      }
      case "C": {
        const p1 = { x: cmd.x1, y: cmd.y1 };
        const p2 = { x: cmd.x2, y: cmd.y2 };
        const p3 = { x: cmd.x, y: cmd.y };
        current.push(...flattenCubic(cursor, p1, p2, p3, segmentsPerCurve));
        cursor = p3;
        break;
      }
      case "Q": {
        const p1 = { x: cmd.x1, y: cmd.y1 };
        const p2 = { x: cmd.x, y: cmd.y };
        current.push(...flattenQuadratic(cursor, p1, p2, segmentsPerCurve));
        cursor = p2;
        break;
      }
      case "Z": {
        cursor = start;
        // 閉路自体は pushCurrent が担う（次の M または終端で確定）。
        break;
      }
      default:
        break;
    }
  }
  pushCurrent();
  return rings;
}

export interface TextOutlineResult {
  glyphs: OutlineGlyph[];
  /** applyDraftText/renderPreciseText と同じ content bounds（canvas サイズ・位置決めに使う）。 */
  width: number;
  height: number;
  minX: number;
  minY: number;
}

export interface TextOutlineInput {
  text: string;
  size: number;
  tracking: number;
  leading: number;
  align: TextAlign;
  boxWidth: number;
  boxHeight: number;
}

/**
 * text component の resolved props からグリフごとの押し出し用リングを得る。
 * font が渡せない（system フォントでアウトライン抽出不可）場合は null を返し、
 * 呼び出し側は既存 2D 描画へフォールバックする（§26.4.1 と同じ制約・§5.4 参照）。
 */
export function textToOutlineGlyphs(p: TextOutlineInput, font: Font, curveSegments: number): TextOutlineResult | null {
  if (!font || font.unitsPerEm <= 0) return null;
  const { lines, bounds } = resolveTextLayout(
    p.text, p.size, p.tracking, p.leading, p.align, font, undefined, p.boxWidth, p.boxHeight,
  );
  const glyphs: OutlineGlyph[] = [];
  const sampleChar = p.text.match(/\S/)?.[0];
  for (const line of lines) {
    const baseline = textBaselineY(line.y, p.size, p.leading, font, null, sampleChar);
    for (const g of line.glyphs) {
      if (!g.char || g.char === "\n" || !g.char.trim()) continue;
      const path = font.getPath(g.char, g.x - bounds.minX, baseline, p.size);
      const raw = flattenPathCommandsToRings(path.commands, curveSegments);
      // グリフ単位で正規化する（文字どうしは tracking が詰まって重なっても融合させない）。
      const rings = normalizeRingsNonzero(raw);
      if (rings.length > 0) glyphs.push({ rings });
    }
  }
  return {
    glyphs,
    width: Math.max(1, bounds.maxX - bounds.minX),
    height: Math.max(1, bounds.maxY - bounds.minY),
    minX: bounds.minX,
    minY: bounds.minY,
  };
}
