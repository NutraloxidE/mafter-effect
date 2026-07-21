import type { SceneObject } from "../core/schema";
import { staticProp } from "../core/props";
import { sampleAny } from "../runtime/interpolate";
import { isAnimatedProp as isAnimated } from "./keyframeEdit";
import { setKeyframe } from "./store";

/**
 * 複数選択レイヤーへの「インスペクター共通プロパティ一斉編集」。
 *
 * ある 1 レイヤー（base）への components / effects / expressionPresets パッチを、
 * 選択中の他レイヤーの「同じ項目」に横展開する。マッチングは:
 *   - components / effects: `type` が一致する最初の要素
 *   - expressionPresets:    `presetId` が一致する最初の要素
 * 数値（number / AnimatedProp<number>）は **差分（delta）** で適用（現状維持のまま同じだけ上下）、
 * それ以外（enum / bool / color / vec3 等）は **同値** で適用する。
 * 対象要素を持たないレイヤーはそのキーをスキップする。
 */
export function buildSelectionCollectionPatches(
  base: SceneObject,
  patch: Partial<SceneObject>,
  collectionKey: "components" | "effects" | "expressionPresets",
  targets: SceneObject[],
  frame: number,
): { id: string; patch: Partial<SceneObject> }[] {
  const discKey = collectionKey === "expressionPresets" ? "presetId" : "type";
  const baseArr = (base[collectionKey] ?? []) as unknown as CollItem[];
  const patchArr = (patch[collectionKey] ?? []) as unknown as CollItem[];

  const changed = diffChangedItem(baseArr, patchArr);
  const patches: { id: string; patch: Partial<SceneObject> }[] = [];

  for (const t of targets) {
    if (t.id === base.id) {
      patches.push({ id: t.id, patch });
      continue;
    }
    if (!changed) continue;
    const disc = (patchArr[changed.index] as Record<string, unknown>)[discKey];
    const tArr = ((t[collectionKey] ?? []) as unknown as CollItem[]);
    const tIdx = tArr.findIndex((it) => (it as Record<string, unknown>)[discKey] === disc);
    if (tIdx < 0) continue;

    const nextProps = { ...tArr[tIdx]!.props };
    for (const key of changed.changedKeys) {
      nextProps[key] = applyLeaf(
        baseArr[changed.index]?.props[key],
        patchArr[changed.index]!.props[key],
        tArr[tIdx]!.props[key],
        frame,
      );
    }
    const nextArr = tArr.map((it, i) => (i === tIdx ? { ...it, props: nextProps } : it));
    patches.push({ id: t.id, patch: { [collectionKey]: nextArr } as Partial<SceneObject> });
  }
  return patches;
}

interface CollItem {
  props: Record<string, unknown>;
  [k: string]: unknown;
}

function diffChangedItem(
  baseArr: CollItem[],
  patchArr: CollItem[],
): { index: number; changedKeys: string[] } | null {
  for (let i = 0; i < patchArr.length; i++) {
    if (baseArr[i] !== patchArr[i]) {
      const baseProps = baseArr[i]?.props ?? {};
      const patchProps = patchArr[i]!.props;
      const keys = Object.keys(patchProps).filter((k) => baseProps[k] !== patchProps[k]);
      // base に無く patch にも無い削除キーは無視（一斉編集は追加/変更のみ扱う）。
      return { index: i, changedKeys: keys };
    }
  }
  return null;
}

/** base の old→new 差分を target のリーフへ適用した結果を返す。 */
function applyLeaf(oldLeaf: unknown, newLeaf: unknown, targetLeaf: unknown, frame: number): unknown {
  const oldNum = asNum(oldLeaf, frame);
  const newNum = asNum(newLeaf, frame);
  if (oldNum !== null && newNum !== null) {
    const delta = newNum - oldNum;
    const targetNum = asNum(targetLeaf, frame);
    if (targetNum === null) return newLeaf; // target 側の形が不明 → 同値
    return writeNumShape(targetLeaf, frame, targetNum + delta);
  }
  return newLeaf; // 非数値 → 同値
}

function asNum(leaf: unknown, frame: number): number | null {
  if (typeof leaf === "number") return leaf;
  if (isAnimated(leaf)) {
    const v = sampleAny(leaf, frame);
    return typeof v === "number" ? v : null;
  }
  return null;
}

/** target のリーフ形（plain number / AnimatedProp）を保ったまま数値を書き戻す。 */
function writeNumShape(targetLeaf: unknown, frame: number, value: number): unknown {
  if (isAnimated(targetLeaf)) {
    const prop = targetLeaf as { keyframes: unknown[]; value: unknown };
    return prop.keyframes.length > 0
      ? setKeyframe(targetLeaf as never, frame, value as never)
      : { ...(targetLeaf as object), value };
  }
  if (typeof targetLeaf === "number") return value;
  // 未定義（param 未保存）なら staticProp 化。
  return staticProp(value);
}
