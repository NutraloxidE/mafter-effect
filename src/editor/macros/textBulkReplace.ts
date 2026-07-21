// §32.1 テキスト一括置換 — レンダラ非依存の純ロジック（INV-1）。
// 2 つの採番モードで対象テキストレイヤーへ入力トークンを割り当てる:
//   - "content": 中身が整数のレイヤーのみ対象。番号 = その整数。
//   - "reading": 全テキストレイヤーが対象。番号 = 配置の読み順（左上→行→右下）。
// いずれも「番号 N ← N 番目のトークン」で置換計画を立て、置換後 objects を作る。

import type { AnimatedProp, Component, SceneObject } from "../../core/schema";

/** 入力の分割単位。char=1 文字ずつ / word=空白区切り。 */
export type ReplaceMode = "char" | "word";

/** 採番の根拠。content=中身の整数 / reading=配置の読み順。 */
export type OrderMode = "content" | "reading";

/** 読み順の行判定の緩さ。lenient=多少の上下は同じ行 / strict=座標が近いものだけ同じ行。 */
export type RowGrouping = "lenient" | "strict";

/** 緩め: この y 差までは同じ行と見なす（既定・多少の上下を許容）。 */
export const LENIENT_ROW_TOLERANCE = 64;
/** 厳格: ほぼ同座標のみ同じ行（丸め・サブピクセルだけ許容）。 */
export const STRICT_ROW_TOLERANCE = 4;
/** 既定の行許容差（= 緩め）。これを超える y 差で行が変わる。 */
export const DEFAULT_ROW_TOLERANCE = LENIENT_ROW_TOLERANCE;

/** 行判定モードから y 許容差（comp px）へ変換する。 */
export function rowToleranceFor(grouping: RowGrouping): number {
  return grouping === "strict" ? STRICT_ROW_TOLERANCE : LENIENT_ROW_TOLERANCE;
}

/** 入力文字列をモードに応じてトークン列へ分解する。 */
export function tokenize(input: string, mode: ReplaceMode): string[] {
  const trimmed = input.trim();
  if (trimmed === "") return [];
  if (mode === "char") return Array.from(trimmed);
  return trimmed.split(/\s+/).filter((t) => t !== "");
}

/** props.text が AnimatedProp<string>（{value,keyframes}）か生 string かを吸収して読む。 */
function readTextProp(component: Component):
  | { text: string; isAnimated: boolean; hasExpression: boolean }
  | null {
  const raw = component.props["text"];
  if (typeof raw === "string") {
    return { text: raw, isAnimated: false, hasExpression: false };
  }
  if (typeof raw === "object" && raw !== null && "value" in raw) {
    const prop = raw as AnimatedProp<unknown>;
    if (typeof prop.value !== "string") return null;
    return {
      text: prop.value,
      isAnimated: Array.isArray(prop.keyframes) && prop.keyframes.length > 0,
      hasExpression: prop.expression != null,
    };
  }
  return null;
}

/** trim 済テキストが整数 `^\d+$` なら番号を返す。そうでなければ null。 */
function parseLayerNumber(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number.parseInt(t, 10);
  return Number.isSafeInteger(n) ? n : null;
}

export interface ReadingEntry {
  objectId: string;
  x: number;
  y: number;
}

/**
 * 読み順（左上→行ごとに左→右→次の行…→右下）で objectId を並べる純関数。
 * y が rowTolerance 以内なら同一行と見なし、行内を x 昇順で並べる。
 * 同座標は objectId で安定ソート。
 */
export function computeReadingOrder(
  entries: ReadingEntry[],
  rowTolerance: number = DEFAULT_ROW_TOLERANCE,
): string[] {
  const byY = [...entries].sort(
    (a, b) => a.y - b.y || a.x - b.x || (a.objectId < b.objectId ? -1 : 1),
  );
  const rows: ReadingEntry[][] = [];
  let current: ReadingEntry[] = [];
  let prevY: number | null = null;
  for (const e of byY) {
    if (prevY === null || e.y - prevY <= rowTolerance) {
      current.push(e);
    } else {
      rows.push(current);
      current = [e];
    }
    prevY = e.y;
  }
  if (current.length > 0) rows.push(current);

  const order: string[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x || (a.objectId < b.objectId ? -1 : 1));
    for (const e of row) order.push(e.objectId);
  }
  return order;
}

export type SkipReason = "animated" | "expression";

export interface ReplaceAssignment {
  objectId: string;
  componentIndex: number; // components[] 内の text コンポーネント位置
  number: number; // レイヤー番号（= 1-based トークン添字）
  oldText: string;
  newText: string;
}

export interface SkippedLayer {
  objectId: string;
  number: number; // content モードでは元の整数、reading モードでは 0（順序対象外）
  reason: SkipReason;
}

export interface BulkReplacePlan {
  assignments: ReplaceAssignment[];
  /** keyframe/expression 付きで除外した text レイヤー。 */
  skipped: SkippedLayer[];
  /** 対象だがトークンが足りず未置換の番号（昇順・重複排除）。 */
  unmatchedNumbers: number[];
  /** どの番号にも割り当たらなかったトークン。 */
  unusedTokens: string[];
  targetCount: number; // 採番できた対象レイヤー数（除外含まず）
  tokenCount: number;
}

interface TextInfo {
  objectId: string;
  componentIndex: number;
  text: string;
  isAnimated: boolean;
  hasExpression: boolean;
}

interface NumberedTarget {
  objectId: string;
  componentIndex: number;
  number: number;
  text: string;
}

/** 各 object の先頭 text コンポーネントを読み取り TextInfo 列にする。 */
function collectTextInfos(objects: SceneObject[]): TextInfo[] {
  const infos: TextInfo[] = [];
  for (const obj of objects) {
    const componentIndex = obj.components.findIndex((c) => c.type === "text");
    if (componentIndex < 0) continue;
    const r = readTextProp(obj.components[componentIndex]!);
    if (!r) continue;
    infos.push({ objectId: obj.id, componentIndex, ...r });
  }
  return infos;
}

/**
 * 番号付きテキストレイヤーへトークンを割り当てる計画を立てる。
 * 番号 N のレイヤーには tokens[N-1] を割り当てる（欠番・重複に頑健）。
 *
 * @param order   "content"=中身の整数で採番 / "reading"=配置の読み順で採番
 * @param positions reading モードで各 objectId の画面位置（未指定/未収録のレイヤーは対象外）
 */
export function planBulkReplace(
  objects: SceneObject[],
  input: string,
  mode: ReplaceMode,
  order: OrderMode = "content",
  positions?: ReadonlyMap<string, { x: number; y: number }>,
  rowTolerance: number = DEFAULT_ROW_TOLERANCE,
): BulkReplacePlan {
  const tokens = tokenize(input, mode);
  const infos = collectTextInfos(objects);
  const skipped: SkippedLayer[] = [];
  const numbered: NumberedTarget[] = [];

  if (order === "content") {
    for (const info of infos) {
      const number = parseLayerNumber(info.text);
      if (number === null) continue; // 数字でないレイヤーは対象外（静かに無視）
      if (info.hasExpression) {
        skipped.push({ objectId: info.objectId, number, reason: "expression" });
      } else if (info.isAnimated) {
        skipped.push({ objectId: info.objectId, number, reason: "animated" });
      } else {
        numbered.push({ ...info, number });
      }
    }
  } else {
    // reading: 静的な全 text レイヤーを位置の読み順で採番。位置が無い（現フレーム非表示）ものは対象外。
    const statics: TextInfo[] = [];
    for (const info of infos) {
      if (info.hasExpression) {
        skipped.push({ objectId: info.objectId, number: 0, reason: "expression" });
      } else if (info.isAnimated) {
        skipped.push({ objectId: info.objectId, number: 0, reason: "animated" });
      } else if (positions?.has(info.objectId)) {
        statics.push(info);
      }
    }
    const entries: ReadingEntry[] = statics.map((s) => {
      const p = positions!.get(s.objectId)!;
      return { objectId: s.objectId, x: p.x, y: p.y };
    });
    const orderedIds = computeReadingOrder(entries, rowTolerance);
    const indexOf = new Map(orderedIds.map((id, i) => [id, i + 1]));
    for (const s of statics) {
      numbered.push({
        objectId: s.objectId,
        componentIndex: s.componentIndex,
        text: s.text,
        number: indexOf.get(s.objectId) ?? 0,
      });
    }
  }

  const assignments: ReplaceAssignment[] = [];
  const unmatched = new Set<number>();
  const usedTokenIndices = new Set<number>();
  for (const n of numbered) {
    const tokenIndex = n.number - 1;
    const token = tokenIndex >= 0 ? tokens[tokenIndex] : undefined;
    if (token === undefined) {
      unmatched.add(n.number);
      continue;
    }
    usedTokenIndices.add(tokenIndex);
    assignments.push({
      objectId: n.objectId,
      componentIndex: n.componentIndex,
      number: n.number,
      oldText: n.text,
      newText: token,
    });
  }
  const unusedTokens = tokens.filter((_, i) => !usedTokenIndices.has(i));

  return {
    assignments,
    skipped,
    unmatchedNumbers: [...unmatched].sort((a, b) => a - b),
    unusedTokens,
    targetCount: numbered.length,
    tokenCount: tokens.length,
  };
}

/** props.text の base 値だけを差し替えた新 Component を返す（keyframes 等は不変）。 */
function withReplacedText(component: Component, newText: string): Component {
  const raw = component.props["text"];
  const nextText =
    typeof raw === "object" && raw !== null && "value" in raw
      ? { ...(raw as AnimatedProp<unknown>), value: newText }
      : newText;
  return { ...component, props: { ...component.props, text: nextText } };
}

/**
 * 割当に従って置換後 objects を返す。割当のある object のみ差し替え、
 * id 順・その他プロパティは維持する（INV-6：id は保持）。
 */
export function buildReplacedObjects(
  objects: SceneObject[],
  assignments: ReplaceAssignment[],
): SceneObject[] {
  if (assignments.length === 0) return objects;
  const byObject = new Map<string, ReplaceAssignment>();
  for (const a of assignments) byObject.set(a.objectId, a);

  return objects.map((obj) => {
    const a = byObject.get(obj.id);
    if (!a) return obj;
    const components = obj.components.map((c, i) =>
      i === a.componentIndex ? withReplacedText(c, a.newText) : c,
    );
    return { ...obj, components };
  });
}
