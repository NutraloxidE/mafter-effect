import type { Vec3Tuple } from "./triangulate";

export interface PoseRt {
  /** X_cam = R * X_world + t */
  R: number[][];
  t: number[];
}

/**
 * 正規化座標での線形 PnP（DLT）。
 * points: ワールド点、norms: 正規化画像点 (x,y) = ((u-cx)/fx, (v-cy)/fy)
 */
export function solvePnPDlt(
  worldPoints: Vec3Tuple[],
  norms: Array<{ x: number; y: number }>,
): PoseRt | null {
  const n = Math.min(worldPoints.length, norms.length);
  if (n < 6) return null;

  // Build 2n x 12 matrix for P (3x4 row-major)
  const A: number[][] = [];
  for (let i = 0; i < n; i++) {
    const [X, Y, Z] = worldPoints[i]!;
    const x = norms[i]!.x;
    const y = norms[i]!.y;
    A.push([X, Y, Z, 1, 0, 0, 0, 0, -x * X, -x * Y, -x * Z, -x]);
    A.push([0, 0, 0, 0, X, Y, Z, 1, -y * X, -y * Y, -y * Z, -y]);
  }

  const p = nullspace12(A);
  if (!p) return null;

  // P = [p0..p11] as 3x4
  const P = [
    [p[0]!, p[1]!, p[2]!, p[3]!],
    [p[4]!, p[5]!, p[6]!, p[7]!],
    [p[8]!, p[9]!, p[10]!, p[11]!],
  ];

  // P = scale * [R|t], recover R via RQ-ish: M = P[0:3,0:3] = s R
  const M = [
    [P[0]![0]!, P[0]![1]!, P[0]![2]!],
    [P[1]![0]!, P[1]![1]!, P[1]![2]!],
    [P[2]![0]!, P[2]![1]!, P[2]![2]!],
  ];
  // Polar decomposition-ish: orthonormalize rows
  let R = gramRows(M);
  // Ensure det(R)=1
  const d =
    R[0]![0]! * (R[1]![1]! * R[2]![2]! - R[1]![2]! * R[2]![1]!) -
    R[0]![1]! * (R[1]![0]! * R[2]![2]! - R[1]![2]! * R[2]![0]!) +
    R[0]![2]! * (R[1]![0]! * R[2]![1]! - R[1]![1]! * R[2]![0]!);
  if (d < 0) {
    R = R.map((row) => row.map((v) => -v));
  }

  // t = s * P[:,3], scale from ||M|| / ||R||
  const s =
    Math.hypot(M[2]![0]!, M[2]![1]!, M[2]![2]!) /
    Math.hypot(R[2]![0]!, R[2]![1]!, R[2]![2]!);
  const t = [P[0]![3]! / s, P[1]![3]! / s, P[2]![3]! / s];

  // Cheirality: majority of points in front
  let front = 0;
  for (const X of worldPoints) {
    const z = R[2]![0]! * X[0] + R[2]![1]! * X[1] + R[2]![2]! * X[2] + t[2]!;
    if (z > 0) front++;
  }
  if (front < n / 2) {
    // flip
    R = R.map((row) => row.map((v) => -v));
    t[0] = -t[0]!;
    t[1] = -t[1]!;
    t[2] = -t[2]!;
  }

  return { R, t };
}

export type ISolvePnP = (
  worldPoints: Vec3Tuple[],
  norms: Array<{ x: number; y: number }>,
  prev?: PoseRt,
) => PoseRt | null;

function cameraCenter(p: PoseRt): number[] {
  const { R, t } = p;
  return [
    -(R[0]![0]! * t[0]! + R[1]![0]! * t[1]! + R[2]![0]! * t[2]!),
    -(R[0]![1]! * t[0]! + R[1]![1]! * t[1]! + R[2]![1]! * t[2]!),
    -(R[0]![2]! * t[0]! + R[1]![2]! * t[1]! + R[2]![2]! * t[2]!),
  ];
}

/**
 * PnP + prevPose 外れ値 reject。
 * 連続性の本判定は poseGate.acceptPnpRelative。ここは明らかな破綻のみ落とす。
 */
export function solvePnPWithPrior(
  worldPoints: Vec3Tuple[],
  norms: Array<{ x: number; y: number }>,
  prev?: PoseRt,
): PoseRt | null {
  const pose = solvePnPDlt(worldPoints, norms);
  if (!pose) return null;
  if (!prev) return pose;
  const c0 = cameraCenter(prev);
  const c1 = cameraCenter(pose);
  const jump = Math.hypot(c1[0]! - c0[0]!, c1[1]! - c0[1]!, c1[2]! - c0[2]!);
  // 内部単位で極端なジャンプのみ reject（細かい連続性は poseGate）
  if (jump > 200) return null;
  return pose;
}

function gramRows(M: number[][]): number[][] {
  const r0 = normalize([M[0]![0]!, M[0]![1]!, M[0]![2]!]);
  let r1 = [
    M[1]![0]! - r0[0]! * dot(r0, [M[1]![0]!, M[1]![1]!, M[1]![2]!]),
    M[1]![1]! - r0[1]! * dot(r0, [M[1]![0]!, M[1]![1]!, M[1]![2]!]),
    M[1]![2]! - r0[2]! * dot(r0, [M[1]![0]!, M[1]![1]!, M[1]![2]!]),
  ];
  r1 = normalize(r1);
  let r2 = [
    r0[1]! * r1[2]! - r0[2]! * r1[1]!,
    r0[2]! * r1[0]! - r0[0]! * r1[2]!,
    r0[0]! * r1[1]! - r0[1]! * r1[0]!,
  ];
  r2 = normalize(r2);
  return [r0, r1, r2];
}

function dot(a: number[], b: number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

function normalize(v: number[]): number[] {
  const n = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / n, v[1]! / n, v[2]! / n];
}

function nullspace12(A: number[][]): number[] | null {
  const cols = 12;
  const AtA = Array.from({ length: cols }, () => Array<number>(cols).fill(0));
  for (const row of A) {
    for (let r = 0; r < cols; r++) {
      for (let c = 0; c < cols; c++) {
        AtA[r]![c]! += row[r]! * row[c]!;
      }
    }
  }
  let v = Array.from({ length: cols }, (_, i) => (i === cols - 1 ? 1 : 0.01 * (i + 1)));
  // power for max
  for (let it = 0; it < 30; it++) {
    const Av = Array<number>(cols).fill(0);
    for (let r = 0; r < cols; r++) {
      for (let c = 0; c < cols; c++) Av[r]! += AtA[r]![c]! * v[c]!;
    }
    const n = Math.hypot(...Av) || 1;
    v = Av.map((a) => a / n);
  }
  let lambdaMax = 0;
  for (let r = 0; r < cols; r++) {
    let s = 0;
    for (let c = 0; c < cols; c++) s += AtA[r]![c]! * v[c]!;
    lambdaMax += v[r]! * s;
  }
  const shift = lambdaMax + 1e-3;
  v = Array.from({ length: cols }, (_, i) => (i === cols - 1 ? 1 : 0.01 * (i + 1)));
  for (let it = 0; it < 50; it++) {
    const M = AtA.map((row, r) => row.map((x, c) => (r === c ? x - shift : x)));
    const x = v.slice();
    for (let gs = 0; gs < 30; gs++) {
      for (let r = 0; r < cols; r++) {
        let s = v[r]!;
        for (let c = 0; c < cols; c++) if (c !== r) s -= M[r]![c]! * x[c]!;
        const d = M[r]![r]!;
        x[r] = Math.abs(d) < 1e-12 ? s : s / d;
      }
    }
    const n = Math.hypot(...x) || 1;
    v = x.map((a) => a / n);
  }
  return v;
}
