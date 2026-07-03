import {
  mat3ToQuaternion,
  quaternionMultiply,
  quaternionNormalize,
  type Mat3,
} from "./rotationEstimator";
import type { RawQuaternion, RawTranslation } from "./types";
import type { WalkRelative } from "./walkAccumulate";

export const POSE_GATE_MAX_ANGLE_DEG = 5;
export const POSE_GATE_MIN_MOTION_COS = 0.85;
export const POSE_GATE_EMA_ALPHA = 0.3;

/** 内部ポーズ（world = cam0）。X_cam = R X_w + t。 */
export interface InternalPose {
  R: number[][];
  t: number[];
  q: RawQuaternion;
  center: RawTranslation;
}

export function identityInternalPose(): InternalPose {
  return {
    R: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    t: [0, 0, 0],
    q: [0, 0, 0, 1],
    center: [0, 0, 0],
  };
}

function quatToMat3(q: RawQuaternion): Mat3 {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

function centerFromRt(R: number[][], t: number[]): RawTranslation {
  return [
    -(R[0]![0]! * t[0]! + R[1]![0]! * t[1]! + R[2]![0]! * t[2]!),
    -(R[0]![1]! * t[0]! + R[1]![1]! * t[1]! + R[2]![1]! * t[2]!),
    -(R[0]![2]! * t[0]! + R[1]![2]! * t[1]! + R[2]![2]! * t[2]!),
  ];
}

/** 相対角（度）。q = q1^{-1} * q2 の角度。 */
export function quaternionAngleDeg(q1: RawQuaternion, q2: RawQuaternion): number {
  const [x1, y1, z1, w1] = q1;
  const inv: RawQuaternion = [-x1, -y1, -z1, w1];
  const d = quaternionNormalize(quaternionMultiply(inv, q2));
  const w = Math.min(1, Math.max(-1, Math.abs(d[3]!)));
  return (2 * Math.acos(w) * 180) / Math.PI;
}

export function motionCosine(a: RawTranslation, b: RawTranslation): number {
  const na = Math.hypot(a[0], a[1], a[2]) || 1;
  const nb = Math.hypot(b[0], b[1], b[2]) || 1;
  return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb);
}

/**
 * PnP 相対を採用するか。scale は比較しない（単眼不定）。
 * 採用時も scale は pred.scale を使う。
 */
export function acceptPnpRelative(
  pred: WalkRelative,
  pnpRel: WalkRelative,
  opts?: { maxAngleDeg?: number; minMotionCos?: number },
): WalkRelative {
  const maxAngle = opts?.maxAngleDeg ?? POSE_GATE_MAX_ANGLE_DEG;
  const minCos = opts?.minMotionCos ?? POSE_GATE_MIN_MOTION_COS;
  const ang = quaternionAngleDeg(pred.rotation, pnpRel.rotation);
  const cos = motionCosine(pred.motion, pnpRel.motion);
  if (ang <= maxAngle && cos >= minCos) {
    return {
      rotation: pnpRel.rotation,
      motion: pnpRel.motion,
      scale: pred.scale,
    };
  }
  return pred;
}

function slerp(q0: RawQuaternion, q1: RawQuaternion, t: number): RawQuaternion {
  let [x0, y0, z0, w0] = q0;
  let [x1, y1, z1, w1] = q1;
  let dot = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;
  if (dot < 0) {
    x1 = -x1;
    y1 = -y1;
    z1 = -z1;
    w1 = -w1;
    dot = -dot;
  }
  if (dot > 0.9995) {
    return quaternionNormalize([
      x0 + t * (x1 - x0),
      y0 + t * (y1 - y0),
      z0 + t * (z1 - z0),
      w0 + t * (w1 - w0),
    ]);
  }
  const th0 = Math.acos(Math.min(1, dot));
  const th = th0 * t;
  const s0 = Math.sin(th0 - th) / Math.sin(th0);
  const s1 = Math.sin(th) / Math.sin(th0);
  return quaternionNormalize([
    s0 * x0 + s1 * x1,
    s0 * y0 + s1 * y1,
    s0 * z0 + s1 * z1,
    s0 * w0 + s1 * w1,
  ]);
}

/** 出力ステップの EMA。rotation=slerp、motion=正規化 lerp、scale=lerp。 */
export function emaFilterStep(
  prev: WalkRelative | null,
  cur: WalkRelative,
  alpha = POSE_GATE_EMA_ALPHA,
): WalkRelative {
  if (!prev) return cur;
  const a = Math.min(1, Math.max(0, alpha));
  const rotation = slerp(prev.rotation, cur.rotation, a);
  const mx = prev.motion[0] * (1 - a) + cur.motion[0] * a;
  const my = prev.motion[1] * (1 - a) + cur.motion[1] * a;
  const mz = prev.motion[2] * (1 - a) + cur.motion[2] * a;
  const n = Math.hypot(mx, my, mz) || 1;
  const scale = prev.scale * (1 - a) + cur.scale * a;
  return {
    rotation,
    motion: [mx / n, my / n, mz / n],
    scale: Math.max(0.5, scale),
  };
}

/**
 * 相対ステップで InternalPose を更新（walkAccumulate と同じ順序:
 * 旧姿勢で並進を足してから回転を更新）。
 */
export function composeRelativeStep(prev: InternalPose, step: WalkRelative): InternalPose {
  const worldR = prev.R;
  const s = step.scale;
  const m = step.motion;
  const dx = worldR[0]![0]! * m[0] * s + worldR[0]![1]! * m[1] * s + worldR[0]![2]! * m[2] * s;
  const dy = worldR[1]![0]! * m[0] * s + worldR[1]![1]! * m[1] * s + worldR[1]![2]! * m[2] * s;
  const dz = worldR[2]![0]! * m[0] * s + worldR[2]![1]! * m[1] * s + worldR[2]![2]! * m[2] * s;
  const center: RawTranslation = [
    prev.center[0] + dx,
    prev.center[1] + dy,
    prev.center[2] + dz,
  ];
  const q = quaternionNormalize(quaternionMultiply(prev.q, step.rotation));
  const R = quatToMat3(q);
  // t = -R * center
  const t = [
    -(R[0]![0]! * center[0] + R[0]![1]! * center[1] + R[0]![2]! * center[2]),
    -(R[1]![0]! * center[0] + R[1]![1]! * center[1] + R[1]![2]! * center[2]),
    -(R[2]![0]! * center[0] + R[2]![1]! * center[1] + R[2]![2]! * center[2]),
  ];
  return { R, t, q, center };
}

/** 絶対ポーズ差から相対ステップを作る。scale は呼び出し側が pred.scale を入れる。 */
export function relativeFromPoses(
  prev: InternalPose,
  cur: InternalPose,
  scale: number,
): WalkRelative {
  const invPrev: RawQuaternion = [-prev.q[0], -prev.q[1], -prev.q[2], prev.q[3]];
  const rotation = quaternionNormalize(quaternionMultiply(invPrev, cur.q));
  const dc = [
    cur.center[0] - prev.center[0],
    cur.center[1] - prev.center[1],
    cur.center[2] - prev.center[2],
  ];
  // motion in prev orientation frame (same as walkAccumulate)
  const m = [
    prev.R[0]![0]! * dc[0]! + prev.R[0]![1]! * dc[1]! + prev.R[0]![2]! * dc[2]!,
    prev.R[1]![0]! * dc[0]! + prev.R[1]![1]! * dc[1]! + prev.R[1]![2]! * dc[2]!,
    prev.R[2]![0]! * dc[0]! + prev.R[2]![1]! * dc[1]! + prev.R[2]![2]! * dc[2]!,
  ];
  const n = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
  return {
    rotation,
    motion: [m[0]! / n, m[1]! / n, m[2]! / n],
    scale: Math.max(0.5, scale),
  };
}

export function internalPoseFromRt(R: number[][], t: number[]): InternalPose {
  const q = mat3ToQuaternion(R as Mat3);
  return { R, t, q, center: centerFromRt(R, t) };
}
