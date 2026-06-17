import type { AnimatedProp, Easing } from "../core/schema";

/** §24.2 適用方向。 */
export type EaseApplyMode = "in" | "out" | "both";

export const DEFAULT_BEZIER: [number, number, number, number] = [0, 0, 1, 1];

export type EaseCurveSelection =
  | { kind: "linear" }
  | { kind: "bezier"; bezier: [number, number, number, number] };

export function toBezierControlPoints(easing: Easing): [number, number, number, number] {
  if (easing.type === "bezier") return [...easing.bezier] as [number, number, number, number];
  return DEFAULT_BEZIER;
}

function applyOut<T>(
  prop: AnimatedProp<T>,
  frames: Set<number>,
  curve: EaseCurveSelection,
): AnimatedProp<T> {
  const kfs = prop.keyframes;
  if (kfs.length === 0) return prop;
  const lastIdx = kfs.length - 1;
  const outEasing: Easing =
    curve.kind === "linear" ? { type: "linear" } : { type: "bezier", bezier: curve.bezier };
  return {
    ...prop,
    keyframes: kfs.map((k, i) => {
      if (!frames.has(k.frame) || i === lastIdx) return k;
      return { ...k, easing: outEasing };
    }),
  };
}

function applyIn<T>(
  prop: AnimatedProp<T>,
  frames: Set<number>,
  curve: EaseCurveSelection,
): AnimatedProp<T> {
  const kfs = prop.keyframes;
  if (kfs.length === 0) return prop;
  const idxByFrame = new Map(kfs.map((k, i) => [k.frame, i]));
  const next = kfs.map((k) => ({ ...k }));
  let changed = false;

  for (const f of frames) {
    const i = idxByFrame.get(f);
    if (i === undefined || i === 0) continue;
    const prevIdx = i - 1;
    const prev = next[prevIdx]!;
    if (curve.kind === "linear") {
      next[prevIdx] = { ...prev, easing: { type: "linear" } };
    } else {
      const cur = toBezierControlPoints(prev.easing);
      const bezier: [number, number, number, number] = [cur[0], cur[1], curve.bezier[2], curve.bezier[3]];
      next[prevIdx] = { ...prev, easing: { type: "bezier", bezier } };
    }
    changed = true;
  }

  return changed ? { ...prop, keyframes: next } : prop;
}

/** §24.2: 選択 KF 群へ in / out / both でイージングを適用する（1 prop 単位）。 */
export function applyEaseModeToProp<T>(
  prop: AnimatedProp<T>,
  frames: Set<number>,
  mode: EaseApplyMode,
  curve: EaseCurveSelection,
): AnimatedProp<T> {
  if (frames.size === 0 || prop.keyframes.length === 0) return prop;
  if (mode === "out") return applyOut(prop, frames, curve);
  if (mode === "in") return applyIn(prop, frames, curve);
  return applyOut(applyIn(prop, frames, curve), frames, curve);
}
