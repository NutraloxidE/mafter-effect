// §32.1 テキスト一括置換 — レンダラ非依存の純ロジック（INV-1）。
// 現在コンプ内で「中身が整数の静的テキストレイヤー」を対象に、入力トークンを
// 番号順（番号 N ← N 番目のトークン）で割り当てる計画を立て、置換後 objects を作る。

import type { AnimatedProp, Component, SceneObject } from "../../core/schema";

export type ReplaceMode = "char" | "word";

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
  number: number;
  reason: SkipReason;
}

export interface BulkReplacePlan {
  assignments: ReplaceAssignment[];
  /** 番号レイヤーだが keyframe/expression 付きで除外したもの。 */
  skipped: SkippedLayer[];
  /** 番号レイヤーだがトークンが足りず未置換の番号（昇順・重複排除）。 */
  unmatchedNumbers: number[];
  /** どの番号にも割り当たらなかったトークン（末尾の余り）。 */
  unusedTokens: string[];
  targetCount: number; // 対象になった番号レイヤー数（除外含まず）
  tokenCount: number;
}

/**
 * 番号付きテキストレイヤーへトークンを割り当てる計画を立てる。
 * 番号 N のレイヤーには tokens[N-1] を割り当てる（欠番・重複に頑健）。
 */
export function planBulkReplace(
  objects: SceneObject[],
  input: string,
  mode: ReplaceMode,
): BulkReplacePlan {
  const tokens = tokenize(input, mode);
  const assignments: ReplaceAssignment[] = [];
  const skipped: SkippedLayer[] = [];
  const unmatched = new Set<number>();
  const usedTokenIndices = new Set<number>();
  let targetCount = 0;

  for (const obj of objects) {
    const componentIndex = obj.components.findIndex((c) => c.type === "text");
    if (componentIndex < 0) continue;
    const info = readTextProp(obj.components[componentIndex]!);
    if (!info) continue;
    const number = parseLayerNumber(info.text);
    if (number === null) continue;

    if (info.hasExpression) {
      skipped.push({ objectId: obj.id, number, reason: "expression" });
      continue;
    }
    if (info.isAnimated) {
      skipped.push({ objectId: obj.id, number, reason: "animated" });
      continue;
    }

    targetCount += 1;
    const tokenIndex = number - 1;
    const token = tokenIndex >= 0 ? tokens[tokenIndex] : undefined;
    if (token === undefined) {
      unmatched.add(number);
      continue;
    }
    usedTokenIndices.add(tokenIndex);
    assignments.push({
      objectId: obj.id,
      componentIndex,
      number,
      oldText: info.text,
      newText: token,
    });
  }

  const unusedTokens = tokens.filter((_, i) => !usedTokenIndices.has(i));

  return {
    assignments,
    skipped,
    unmatchedNumbers: [...unmatched].sort((a, b) => a - b),
    unusedTokens,
    targetCount,
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
