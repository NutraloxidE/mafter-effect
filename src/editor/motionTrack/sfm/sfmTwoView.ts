/**
 * 2 視点初期化: RANSAC essential 行列 + ポーズ復元 + 三角測量 + 焦点距離スイープ。
 * 既存 essentialPose.ts（walk 用）とは独立（solve 専用に inlier 集合・視差角を返す）。
 */

import {
  m3Mul,
  m3MulVec,
  m3Transpose,
  m3Det,
  median,
  smallestEigenvectorSym,
  svd3,
  v3Normalize,
  v3Scale,
  triangulationAngleDeg,
  triangulateDlt,
  cameraCenter,
  projectPoint,
  type CamPose,
  type M3,
  type V3,
  SfmRng,
} from "./sfmCore";

export interface PxPair {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface NormPair {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function normalizePairs(pairs: PxPair[], f: number, cx: number, cy: number): NormPair[] {
  return pairs.map((p) => ({
    x0: (p.x0 - cx) / f,
    y0: (p.y0 - cy) / f,
    x1: (p.x1 - cx) / f,
    y1: (p.y1 - cy) / f,
  }));
}

/** 8-point（最小二乗）+ rank-2 射影。 */
function eightPointE(pairs: NormPair[]): M3 | null {
  if (pairs.length < 8) return null;
  // AᵀA (9x9) を組んで最小固有ベクトル
  const AtA = new Float64Array(81);
  for (const p of pairs) {
    const row = [
      p.x0 * p.x1,
      p.y0 * p.x1,
      p.x1,
      p.x0 * p.y1,
      p.y0 * p.y1,
      p.y1,
      p.x0,
      p.y0,
      1,
    ];
    for (let r = 0; r < 9; r++) {
      for (let c = r; c < 9; c++) {
        AtA[r * 9 + c]! += row[r]! * row[c]!;
      }
    }
  }
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < r; c++) AtA[r * 9 + c] = AtA[c * 9 + r]!;
  }
  const v = smallestEigenvectorSym(AtA, 9);
  if (!v) return null;
  const E: M3 = [
    [v[0]!, v[1]!, v[2]!],
    [v[3]!, v[4]!, v[5]!],
    [v[6]!, v[7]!, v[8]!],
  ];
  const { U, S, V } = svd3(E);
  const s = (S[0] + S[1]) / 2;
  const Sm: M3 = [
    [s, 0, 0],
    [0, s, 0],
    [0, 0, 0],
  ];
  return m3Mul(m3Mul(U, Sm), m3Transpose(V));
}

function sampsonErrSq(E: M3, p: NormPair): number {
  const x0: V3 = [p.x0, p.y0, 1];
  const x1: V3 = [p.x1, p.y1, 1];
  const Ex0 = m3MulVec(E, x0);
  const Etx1 = m3MulVec(m3Transpose(E), x1);
  const x1Ex0 = x1[0] * Ex0[0] + x1[1] * Ex0[1] + x1[2] * Ex0[2];
  const denom = Ex0[0] ** 2 + Ex0[1] ** 2 + Etx1[0] ** 2 + Etx1[1] ** 2;
  if (denom < 1e-14) return Math.abs(x1Ex0);
  return (x1Ex0 * x1Ex0) / denom;
}

export interface RansacEssentialResult {
  E: M3;
  inlierIdx: number[];
}

/**
 * RANSAC で essential 行列を推定。threshPx は Sampson 距離（px 換算）。
 */
export function ransacEssential(
  pairs: PxPair[],
  f: number,
  cx: number,
  cy: number,
  rng: SfmRng,
  opts?: { iterations?: number; threshPx?: number },
): RansacEssentialResult | null {
  if (pairs.length < 8) return null;
  const iterations = opts?.iterations ?? 200;
  const threshPx = opts?.threshPx ?? 1.5;
  // 正規化座標での閾値: (px / f)^2
  const threshSq = (threshPx / f) ** 2;
  const norm = normalizePairs(pairs, f, cx, cy);

  let bestInliers: number[] = [];
  for (let it = 0; it < iterations; it++) {
    const idx = rng.sample(norm.length, 8);
    const sample = idx.map((i) => norm[i]!);
    const Ec = eightPointE(sample);
    if (!Ec) continue;
    const inliers: number[] = [];
    for (let i = 0; i < norm.length; i++) {
      if (sampsonErrSq(Ec, norm[i]!) < threshSq) inliers.push(i);
    }
    if (inliers.length > bestInliers.length) {
      bestInliers = inliers;
    }
  }
  if (bestInliers.length < 12) return null;

  // inlier 全体で再推定 → inlier 再判定を 2 回回す
  let E: M3 | null = null;
  for (let round = 0; round < 2; round++) {
    E = eightPointE(bestInliers.map((i) => norm[i]!));
    if (!E) return null;
    const next: number[] = [];
    for (let i = 0; i < norm.length; i++) {
      if (sampsonErrSq(E, norm[i]!) < threshSq) next.push(i);
    }
    if (next.length < 12) break;
    bestInliers = next;
  }
  if (!E) return null;
  return { E, inlierIdx: bestInliers };
}

function decomposeE(E: M3): Array<{ R: M3; t: V3 }> {
  const { U, V } = svd3(E);
  const W: M3 = [
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ];
  let R1 = m3Mul(m3Mul(U, W), m3Transpose(V));
  let R2 = m3Mul(m3Mul(U, m3Transpose(W)), m3Transpose(V));
  if (m3Det(R1) < 0) R1 = R1.map((r) => r.map((x) => -x) as V3) as M3;
  if (m3Det(R2) < 0) R2 = R2.map((r) => r.map((x) => -x) as V3) as M3;
  const t = v3Normalize([U[0][2], U[1][2], U[2][2]]);
  const tm = v3Scale(t, -1);
  return [
    { R: R1, t },
    { R: R1, t: tm },
    { R: R2, t },
    { R: R2, t: tm },
  ];
}

export interface TwoViewInit {
  /** cam0 → cam1（X1 = R X0 + t、|t| = 1） */
  pose: CamPose;
  inlierIdx: number[];
  /** inlier のうち三角測量が通った (pairIdx, X) */
  points: Array<{ pairIdx: number; X: V3 }>;
  medianAngleDeg: number;
  medianReprojPx: number;
}

/**
 * 2 視点初期化。E → ポーズ候補 4 つを cheirality で選択 → inlier を三角測量。
 */
export function estimateTwoViewInit(
  pairs: PxPair[],
  f: number,
  cx: number,
  cy: number,
  rng: SfmRng,
  opts?: { iterations?: number; threshPx?: number; minAngleDeg?: number },
): TwoViewInit | null {
  const res = ransacEssential(pairs, f, cx, cy, rng, opts);
  if (!res) return null;
  const norm = normalizePairs(pairs, f, cx, cy);
  const inliers = res.inlierIdx;
  const candidates = decomposeE(res.E);

  const pose0: CamPose = { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] };
  let best: { R: M3; t: V3 } | null = null;
  let bestCount = -1;
  for (const c of candidates) {
    const poseC: CamPose = { R: c.R, t: c.t };
    let count = 0;
    // cheirality は inlier のサブサンプルで十分
    const step = Math.max(1, Math.floor(inliers.length / 60));
    for (let k = 0; k < inliers.length; k += step) {
      const p = norm[inliers[k]!]!;
      const X = triangulateDlt(pose0, poseC, p.x0, p.y0, p.x1, p.y1);
      if (!X) continue;
      const z0 = X[2];
      const z1 = c.R[2][0] * X[0] + c.R[2][1] * X[1] + c.R[2][2] * X[2] + c.t[2];
      if (z0 > 0 && z1 > 0) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  if (!best || bestCount < 8) return null;

  const pose: CamPose = { R: best.R, t: best.t };
  const C0 = cameraCenter(pose0);
  const C1 = cameraCenter(pose);

  const points: Array<{ pairIdx: number; X: V3 }> = [];
  const angles: number[] = [];
  const reprojErrs: number[] = [];
  const minAngle = opts?.minAngleDeg ?? 0.5;
  for (const i of inliers) {
    const p = norm[i]!;
    const X = triangulateDlt(pose0, pose, p.x0, p.y0, p.x1, p.y1);
    if (!X) continue;
    const z1 = best.R[2][0] * X[0] + best.R[2][1] * X[1] + best.R[2][2] * X[2] + best.t[2];
    if (X[2] <= 0 || z1 <= 0) continue;
    const orig = pairs[i]!;
    const pr0 = projectPoint(pose0, f, cx, cy, X);
    const pr1 = projectPoint(pose, f, cx, cy, X);
    if (!pr0 || !pr1) continue;
    const e0 = Math.hypot(pr0.u - orig.x0, pr0.v - orig.y0);
    const e1 = Math.hypot(pr1.u - orig.x1, pr1.v - orig.y1);
    const err = Math.max(e0, e1);
    if (err > 3) continue;
    const ang = triangulationAngleDeg(C0, C1, X);
    if (ang < minAngle) continue;
    points.push({ pairIdx: i, X });
    angles.push(ang);
    reprojErrs.push(err);
  }
  if (points.length < 12) return null;

  return {
    pose,
    inlierIdx: inliers,
    points,
    medianAngleDeg: median(angles),
    medianReprojPx: median(reprojErrs),
  };
}

/**
 * 焦点距離スイープ: 候補ごとに 2 視点初期化を行い median 再投影誤差（px）最小を選ぶ。
 * 誤差が同程度（1.25x 以内）なら初期推定に近い候補を優先。
 */
export function sweepFocalCandidates(
  pairs: PxPair[],
  width: number,
  height: number,
  initialFocal: number,
  rng: SfmRng,
  factors: number[] = [0.55, 0.7, 0.85, 1, 1.2, 1.45, 1.75],
): { focal: number; init: TwoViewInit } | null {
  const cx = width / 2;
  const cy = height / 2;
  let best: { focal: number; init: TwoViewInit; score: number } | null = null;
  for (const k of factors) {
    const f = initialFocal * k;
    const init = estimateTwoViewInit(pairs, f, cx, cy, rng, { iterations: 150 });
    if (!init) continue;
    // 誤差が小さく、視差角があり、点数が多いものが良い
    const score =
      init.medianReprojPx / Math.max(1, Math.min(init.points.length, 200)) /
      Math.max(0.2, Math.min(init.medianAngleDeg, 8));
    if (!best || score < best.score) {
      best = { focal: f, init, score };
    }
  }
  if (!best) return null;
  return { focal: best.focal, init: best.init };
}
