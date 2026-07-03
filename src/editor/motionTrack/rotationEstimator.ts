import type { RawQuaternion } from "./types";

export type BearingVec = [number, number, number];
export type BearingPair = [BearingVec, BearingVec];

export type Mat3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
];

const IDENTITY_QUAT: RawQuaternion = [0, 0, 0, 1];

/** ピンホール像素 → 単位ベアリング（+x 右 / +y 下 / +z シーン奥）。 */
export function bearingFromPixel(
  u: number,
  v: number,
  fx: number,
  fy: number,
  cx: number,
  cy: number,
): BearingVec {
  const x = (u - cx) / fx;
  const y = (v - cy) / fy;
  const n = Math.hypot(x, y, 1);
  return [x / n, y / n, 1 / n];
}

function applyMat3(R: Mat3, a: BearingVec): BearingVec {
  return [
    R[0][0] * a[0] + R[0][1] * a[1] + R[0][2] * a[2],
    R[1][0] * a[0] + R[1][1] * a[1] + R[1][2] * a[2],
    R[2][0] * a[0] + R[2][1] * a[1] + R[2][2] * a[2],
  ];
}

function topEigenvector4(M: number[][]): [number, number, number, number] {
  let v: [number, number, number, number] = [1, 1, 1, 1];
  for (let it = 0; it < 60; it++) {
    const nv: [number, number, number, number] = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        nv[i] = nv[i]! + M[i]![j]! * v[j]!;
      }
    }
    const n = Math.hypot(nv[0], nv[1], nv[2], nv[3]) || 1;
    v = [nv[0] / n, nv[1] / n, nv[2] / n, nv[3] / n];
  }
  return v;
}

/** Horn の四元数閉形式: R·a ≈ b を最小二乗で解く。 */
export function hornRotation(pairs: BearingPair[]): Mat3 {
  let Sxx = 0;
  let Sxy = 0;
  let Sxz = 0;
  let Syx = 0;
  let Syy = 0;
  let Syz = 0;
  let Szx = 0;
  let Szy = 0;
  let Szz = 0;
  for (const [a, b] of pairs) {
    Sxx += a[0] * b[0];
    Sxy += a[0] * b[1];
    Sxz += a[0] * b[2];
    Syx += a[1] * b[0];
    Syy += a[1] * b[1];
    Syz += a[1] * b[2];
    Szx += a[2] * b[0];
    Szy += a[2] * b[1];
    Szz += a[2] * b[2];
  }
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  const [qw, qx, qy, qz] = topEigenvector4(N);
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  const x = qx / n;
  const y = qy / n;
  const z = qz / n;
  const w = qw / n;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

export function mat3ToQuaternion(R: Mat3): RawQuaternion {
  const m00 = R[0][0];
  const m01 = R[0][1];
  const m02 = R[0][2];
  const m10 = R[1][0];
  const m11 = R[1][1];
  const m12 = R[1][2];
  const m20 = R[2][0];
  const m21 = R[2][1];
  const m22 = R[2][2];
  const tr = m00 + m11 + m22;
  let qw: number;
  let qx: number;
  let qy: number;
  let qz: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    qw = 0.25 * s;
    qx = (m21 - m12) / s;
    qy = (m02 - m20) / s;
    qz = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  return [qx / n, qy / n, qz / n, qw / n];
}

export function quaternionMultiply(a: RawQuaternion, b: RawQuaternion): RawQuaternion {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quaternionNormalize(q: RawQuaternion): RawQuaternion {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function quaternionConjugate(q: RawQuaternion): RawQuaternion {
  return [-q[0], -q[1], -q[2], q[3]];
}

function meanResidual(R: Mat3, pairs: BearingPair[]): number {
  if (pairs.length === 0) return Infinity;
  let sum = 0;
  for (const [a, b] of pairs) {
    const rb = applyMat3(R, a);
    sum += Math.hypot(rb[0] - b[0], rb[1] - b[1], rb[2] - b[2]);
  }
  return sum / pairs.length;
}

export interface RansacRotationResult {
  R: Mat3;
  inlierRatio: number;
  residual: number;
  inliers: BearingPair[];
}

export function ransacRotation(
  pairs: BearingPair[],
  options?: { iterations?: number; thresh?: number; seed?: number },
): RansacRotationResult | null {
  if (pairs.length < 4) return null;
  const iterations = options?.iterations ?? 80;
  const thresh = options?.thresh ?? 0.02;
  let seed = options?.seed ?? 42;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  let best: RansacRotationResult | null = null;
  let bestInliers = 0;

  for (let it = 0; it < iterations; it++) {
    const sample: BearingPair[] = [];
    const used = new Set<number>();
    while (sample.length < 4) {
      const i = Math.floor(rnd() * pairs.length);
      if (used.has(i)) continue;
      used.add(i);
      sample.push(pairs[i]!);
    }
    const R = hornRotation(sample);
    const inliers: BearingPair[] = [];
    for (const pair of pairs) {
      const rb = applyMat3(R, pair[0]);
      const err = Math.hypot(rb[0] - pair[1][0], rb[1] - pair[1][1], rb[2] - pair[1][2]);
      if (err < thresh) inliers.push(pair);
    }
    if (inliers.length > bestInliers) {
      bestInliers = inliers.length;
      const refined = hornRotation(inliers.length >= 4 ? inliers : sample);
      best = {
        R: refined,
        inlierRatio: inliers.length / pairs.length,
        residual: meanResidual(refined, inliers.length >= 4 ? inliers : sample),
        inliers: inliers.length >= 4 ? inliers : sample,
      };
    }
  }
  return best;
}

export function estimateRotationFromPairs(
  pairs: BearingPair[],
): { quaternion: RawQuaternion; inlierRatio: number; residual: number } | null {
  const fit = ransacRotation(pairs);
  if (!fit) return null;
  return {
    quaternion: mat3ToQuaternion(fit.R),
    inlierRatio: fit.inlierRatio,
    residual: fit.residual,
  };
}

export function identityQuaternion(): RawQuaternion {
  return [...IDENTITY_QUAT];
}
