import type { AnimatedProp, Frame, Keyframe, Vec3 } from "../core/schema";
import { easingFn } from "./easing";

// §6.4 補間。
// - scalar/vec は成分ごとに線形補間し、区間の easing で時間を再マップ。
// - 端の外挿: 最初の KF より前は最初の値、最後より後は最後の値で hold（clamp）。
// MVP では expression は未評価（M2）。expression があってもここでは keyframe/value のみ解決する。

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
}

/** frame における [k0, k1] 区間の正規化時間 t∈[0,1] を easing 再マップして返す。 */
function segmentT(k0: Keyframe<unknown>, k1: Keyframe<unknown>, frame: Frame): number {
  const span = k1.frame - k0.frame;
  const raw = span <= 0 ? 0 : (frame - k0.frame) / span;
  return easingFn(k0.easing)(raw);
}

/** keyframe 列の中で frame を挟む区間 [i, i+1] を返す。clamp 済みインデックス。 */
function findSegment<T>(
  kfs: Keyframe<T>[],
  frame: Frame,
): { before: Keyframe<T>; after: Keyframe<T>; t: number } | { hold: T } {
  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  if (frame <= first.frame) return { hold: first.value };
  if (frame >= last.frame) return { hold: last.value };
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (frame >= a.frame && frame <= b.frame) {
      return { before: a, after: b, t: segmentT(a, b, frame) };
    }
  }
  return { hold: last.value };
}

export function sampleScalar(prop: AnimatedProp<number>, frame: Frame): number {
  const kfs = prop.keyframes;
  if (kfs.length === 0) return prop.value;
  const seg = findSegment(kfs, frame);
  if ("hold" in seg) return seg.hold;
  return lerp(seg.before.value, seg.after.value, seg.t);
}

export function sampleVec3(prop: AnimatedProp<Vec3>, frame: Frame): Vec3 {
  const kfs = prop.keyframes;
  if (kfs.length === 0) return prop.value;
  const seg = findSegment(kfs, frame);
  if ("hold" in seg) return seg.hold;
  return lerpVec3(seg.before.value, seg.after.value, seg.t);
}

function isVec3(v: unknown): v is Vec3 {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Vec3).x === "number" &&
    typeof (v as Vec3).y === "number" &&
    typeof (v as Vec3).z === "number"
  );
}

function isAnimatedProp(v: unknown): v is AnimatedProp<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    "value" in v &&
    "keyframes" in v &&
    Array.isArray((v as AnimatedProp<unknown>).keyframes)
  );
}

/**
 * 任意の Component prop 値を frame で解決する。
 * - AnimatedProp<number> → 線形補間
 * - AnimatedProp<Vec3> → 成分補間
 * - その他の AnimatedProp（string/color/enum 等）→ ステップ（直近 KF or value）
 * - 非 AnimatedProp（生値）→ そのまま
 */
export function sampleAny(value: unknown, frame: Frame): unknown {
  if (!isAnimatedProp(value)) return value;
  const prop = value;
  if (prop.keyframes.length === 0) return prop.value;

  if (typeof prop.value === "number") {
    return sampleScalar(prop as AnimatedProp<number>, frame);
  }
  if (isVec3(prop.value)) {
    return sampleVec3(prop as AnimatedProp<Vec3>, frame);
  }
  // 補間不能な型はステップ補間（hold）。
  const seg = findSegment(prop.keyframes, frame);
  return "hold" in seg ? seg.hold : seg.before.value;
}
