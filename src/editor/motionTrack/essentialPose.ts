import type { RawQuaternion, RawTranslation } from "./types";
import type { Mat3 } from "./rotationEstimator";
import { mat3ToQuaternion } from "./rotationEstimator";

export interface PixelPair {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RelativePose {
  /** cam0 → cam1 の回転（点変換: x1 ≈ R x0 + t） */
  R: Mat3;
  /** 単位並進（カメラ運動方向、cam0 座標系） */
  t: RawTranslation;
  inlierRatio: number;
  /** Sampson 誤差中央値 */
  residual: number;
}

function normalizePixels(
  pairs: PixelPair[],
  fx: number,
  fy: number,
  cx: number,
  cy: number,
): Array<{ x0: number; y0: number; x1: number; y1: number }> {
  return pairs.map((p) => ({
    x0: (p.x0 - cx) / fx,
    y0: (p.y0 - cy) / fy,
    x1: (p.x1 - cx) / fx,
    y1: (p.y1 - cy) / fy,
  }));
}

/** 3x3 SVD (Jacobi) — E 分解用の簡易実装。 */
function svd3(A: number[][]): { U: number[][]; S: number[]; V: number[][] } {
  // A = U S V^T via eigenvalue of A^T A
  const AtA = mul33(transpose33(A), A);
  const { vecs, vals } = eigenSym3(AtA);
  // vals descending
  const order = [0, 1, 2].sort((a, b) => vals[b]! - vals[a]!);
  const V = [vecs[order[0]!]!, vecs[order[1]!]!, vecs[order[2]!]!];
  const S = [Math.sqrt(Math.max(0, vals[order[0]!]!)), Math.sqrt(Math.max(0, vals[order[1]!]!)), Math.sqrt(Math.max(0, vals[order[2]!]!))];
  // U = A V S^+
  const Ucols: number[][] = [];
  for (let i = 0; i < 3; i++) {
    const v = V[i]!;
    const Av = [dot3(A[0]!, v), dot3(A[1]!, v), dot3(A[2]!, v)];
    const s = S[i]! > 1e-12 ? S[i]! : 1;
    Ucols.push([Av[0]! / s, Av[1]! / s, Av[2]! / s]);
  }
  // orthonormalize U
  const U = gramSchmidt(Ucols);
  return { U, S, V };
}

function dot3(a: number[], b: number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

function transpose33(M: number[][]): number[][] {
  return [
    [M[0]![0]!, M[1]![0]!, M[2]![0]!],
    [M[0]![1]!, M[1]![1]!, M[2]![1]!],
    [M[0]![2]!, M[1]![2]!, M[2]![2]!],
  ];
}

function mul33(A: number[][], B: number[][]): number[][] {
  const out: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r]![c] = A[r]![0]! * B[0]![c]! + A[r]![1]! * B[1]![c]! + A[r]![2]! * B[2]![c]!;
    }
  }
  return out;
}

function gramSchmidt(cols: number[][]): number[][] {
  const u0 = normalize3(cols[0]!);
  let u1 = sub3(cols[1]!, scale3(u0, dot3(cols[1]!, u0)));
  u1 = normalize3(u1);
  let u2 = sub3(cols[2]!, scale3(u0, dot3(cols[2]!, u0)));
  u2 = sub3(u2, scale3(u1, dot3(u2, u1)));
  u2 = normalize3(u2);
  return [
    [u0[0]!, u1[0]!, u2[0]!],
    [u0[1]!, u1[1]!, u2[1]!],
    [u0[2]!, u1[2]!, u2[2]!],
  ];
}

function normalize3(v: number[]): number[] {
  const n = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / n, v[1]! / n, v[2]! / n];
}

function scale3(v: number[], s: number): number[] {
  return [v[0]! * s, v[1]! * s, v[2]! * s];
}

function sub3(a: number[], b: number[]): number[] {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}

/** 対称 3x3 の固有分解（Jacobi）。 */
function eigenSym3(M: number[][]): { vals: number[]; vecs: number[][] } {
  let A = M.map((r) => r.slice());
  let V: number[][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 40; iter++) {
    let p = 0;
    let q = 1;
    let max = Math.abs(A[0]![1]!);
    for (const [i, j] of [
      [0, 2],
      [1, 2],
    ] as const) {
      const v = Math.abs(A[i]![j]!);
      if (v > max) {
        max = v;
        p = i;
        q = j;
      }
    }
    if (max < 1e-12) break;
    const app = A[p]![p]!;
    const aqq = A[q]![q]!;
    const apq = A[p]![q]!;
    const tau = (aqq - app) / (2 * apq);
    const t = Math.sign(tau) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    const App = app - t * apq;
    const Aqq = aqq + t * apq;
    A[p]![p] = App;
    A[q]![q] = Aqq;
    A[p]![q] = 0;
    A[q]![p] = 0;
    for (let r = 0; r < 3; r++) {
      if (r === p || r === q) continue;
      const arp = A[r]![p]!;
      const arq = A[r]![q]!;
      A[r]![p] = c * arp - s * arq;
      A[p]![r] = A[r]![p]!;
      A[r]![q] = s * arp + c * arq;
      A[q]![r] = A[r]![q]!;
    }
    for (let r = 0; r < 3; r++) {
      const vrp = V[r]![p]!;
      const vrq = V[r]![q]!;
      V[r]![p] = c * vrp - s * vrq;
      V[r]![q] = s * vrp + c * vrq;
    }
  }
  const vals = [A[0]![0]!, A[1]![1]!, A[2]![2]!];
  const vecs = [
    [V[0]![0]!, V[1]![0]!, V[2]![0]!],
    [V[0]![1]!, V[1]![1]!, V[2]![1]!],
    [V[0]![2]!, V[1]![2]!, V[2]![2]!],
  ];
  return { vals, vecs };
}

/** 対称行列の最小固有ベクトル（逆反復 + シフト）。 */
function smallestEigenvector(AtA: number[][], dim: number): number[] {
  // シフト: λ_max を冪乗法で近似し (AtA - (λ_max+ε)I) の逆反復で最小固有ベクトルへ
  let v = Array.from({ length: dim }, (_, i) => (i === dim - 1 ? 1 : 0.01 * (i + 1)));
  for (let it = 0; it < 40; it++) {
    const Av = Array<number>(dim).fill(0);
    for (let r = 0; r < dim; r++) {
      for (let c = 0; c < dim; c++) Av[r]! += AtA[r]![c]! * v[c]!;
    }
    const n = Math.hypot(...Av) || 1;
    v = Av.map((a) => a / n);
  }
  let lambdaMax = 0;
  for (let r = 0; r < dim; r++) {
    let s = 0;
    for (let c = 0; c < dim; c++) s += AtA[r]![c]! * v[c]!;
    lambdaMax += v[r]! * s;
  }
  const shift = lambdaMax + 1e-3;
  v = Array.from({ length: dim }, (_, i) => (i === dim - 1 ? 1 : 0.01 * (i + 1)));
  for (let it = 0; it < 60; it++) {
    const M = AtA.map((row, r) => row.map((x, c) => (r === c ? x - shift : x)));
    // Gauss-Seidel solve M x = v
    const x = v.slice();
    for (let gs = 0; gs < 40; gs++) {
      for (let r = 0; r < dim; r++) {
        let s = v[r]!;
        for (let c = 0; c < dim; c++) {
          if (c !== r) s -= M[r]![c]! * x[c]!;
        }
        const diag = M[r]![r]!;
        x[r] = Math.abs(diag) < 1e-12 ? s : s / diag;
      }
    }
    const n = Math.hypot(...x) || 1;
    v = x.map((a) => a / n);
  }
  return v;
}

function eightPoint(normPairs: Array<{ x0: number; y0: number; x1: number; y1: number }>): number[][] {
  const n = normPairs.length;
  const A: number[][] = [];
  for (const p of normPairs) {
    const { x0, y0, x1, y1 } = p;
    A.push([x0 * x1, y0 * x1, x1, x0 * y1, y0 * y1, y1, x0, y0, 1]);
  }
  const AtA = Array.from({ length: 9 }, () => Array<number>(9).fill(0));
  for (let i = 0; i < n; i++) {
    const row = A[i]!;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        AtA[r]![c]! += row[r]! * row[c]!;
      }
    }
  }
  const v = smallestEigenvector(AtA, 9);
  const E = [
    [v[0]!, v[1]!, v[2]!],
    [v[3]!, v[4]!, v[5]!],
    [v[6]!, v[7]!, v[8]!],
  ];
  const { U, S, V } = svd3(E);
  const s = [(S[0]! + S[1]!) / 2, (S[0]! + S[1]!) / 2, 0];
  const Sm = [
    [s[0]!, 0, 0],
    [0, s[1]!, 0],
    [0, 0, 0],
  ];
  return mul33(mul33(U, Sm), transpose33(V));
}

function det3(M: number[][]): number {
  return (
    M[0]![0]! * (M[1]![1]! * M[2]![2]! - M[1]![2]! * M[2]![1]!) -
    M[0]![1]! * (M[1]![0]! * M[2]![2]! - M[1]![2]! * M[2]![0]!) +
    M[0]![2]! * (M[1]![0]! * M[2]![1]! - M[1]![1]! * M[2]![0]!)
  );
}

function recoverPoseCandidates(E: number[][]): Array<{ R: number[][]; t: number[] }> {
  const { U, V } = svd3(E);
  const W = [
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ];
  const Wt = transpose33(W);
  let R1 = mul33(mul33(U, W), transpose33(V));
  let R2 = mul33(mul33(U, Wt), transpose33(V));
  if (det3(R1) < 0) R1 = R1.map((r) => r.map((x) => -x));
  if (det3(R2) < 0) R2 = R2.map((r) => r.map((x) => -x));
  const t = [U[0]![2]!, U[1]![2]!, U[2]![2]!];
  const tn = normalize3(t);
  const tm = scale3(tn, -1);
  return [
    { R: R1, t: tn },
    { R: R1, t: tm },
    { R: R2, t: tn },
    { R: R2, t: tm },
  ];
}

function triangulateDepth(
  R: number[][],
  t: number[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { z0: number; z1: number } {
  // Linear triangulation (DLT simplified for z)
  // X = depth0 * [x0,y0,1], X' = R X + t = depth1 * [x1,y1,1]
  // Solve least squares for depths
  const p0 = [x0, y0, 1];
  const Rp0 = [dot3(R[0]!, p0), dot3(R[1]!, p0), dot3(R[2]!, p0)];
  // depth0 * Rp0 + t = depth1 * p1
  // Use first two eqs
  const a11 = Rp0[0]!;
  const a12 = -x1;
  const a21 = Rp0[1]!;
  const a22 = -y1;
  const b1 = -t[0]!;
  const b2 = -t[1]!;
  const det = a11 * a22 - a12 * a21;
  if (Math.abs(det) < 1e-12) return { z0: -1, z1: -1 };
  const d0 = (b1 * a22 - a12 * b2) / det;
  const d1 = (a11 * b2 - b1 * a21) / det;
  return { z0: d0, z1: d1 };
}

function cheiralityScore(
  R: number[][],
  t: number[],
  pairs: Array<{ x0: number; y0: number; x1: number; y1: number }>,
): number {
  let score = 0;
  for (const p of pairs) {
    const { z0, z1 } = triangulateDepth(R, t, p.x0, p.y0, p.x1, p.y1);
    if (z0 > 0 && z1 > 0) score++;
  }
  return score;
}

function sampsonError(
  E: number[][],
  p: { x0: number; y0: number; x1: number; y1: number },
): number {
  const x0 = [p.x0, p.y0, 1];
  const x1 = [p.x1, p.y1, 1];
  const Ex0 = [dot3(E[0]!, x0), dot3(E[1]!, x0), dot3(E[2]!, x0)];
  const Etx1 = [
    E[0]![0]! * x1[0]! + E[1]![0]! * x1[1]! + E[2]![0]! * x1[2]!,
    E[0]![1]! * x1[0]! + E[1]![1]! * x1[1]! + E[2]![1]! * x1[2]!,
    E[0]![2]! * x1[0]! + E[1]![2]! * x1[1]! + E[2]![2]! * x1[2]!,
  ];
  const x1Ex0 = dot3(x1, Ex0);
  const denom = Ex0[0]! ** 2 + Ex0[1]! ** 2 + Etx1[0]! ** 2 + Etx1[1]! ** 2;
  if (denom < 1e-12) return Math.abs(x1Ex0);
  return (x1Ex0 * x1Ex0) / denom;
}

function median(nums: number[]): number {
  if (nums.length === 0) return Infinity;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

/**
 * ピクセル対応から相対ポーズを RANSAC 推定。
 * t は単位ベクトル（カメラ運動方向、cam0 系）。
 */
export function estimateRelativePose(
  pairs: PixelPair[],
  fx: number,
  fy: number,
  cx: number,
  cy: number,
  options?: { iterations?: number; thresh?: number; seed?: number },
): RelativePose | null {
  if (pairs.length < 8) return null;
  const iterations = options?.iterations ?? 80;
  const thresh = options?.thresh ?? 2e-4;
  let seed = options?.seed ?? 7;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const normAll = normalizePixels(pairs, fx, fy, cx, cy);

  // まず全点で eight-point（ノイズ少のときはこれが最良）
  let bestInliers = normAll;
  let E = eightPoint(normAll);
  let errsAll = normAll.map((p) => sampsonError(E, p));
  let medErr = median(errsAll);

  // 残差が大きいときだけ RANSAC
  if (medErr > thresh * 10) {
    let bestCount = 0;
    let bestE: number[][] | null = null;
    let bestSet: typeof normAll = [];
    for (let it = 0; it < iterations; it++) {
      const sample: typeof normAll = [];
      const used = new Set<number>();
      while (sample.length < 8) {
        const i = Math.floor(rnd() * normAll.length);
        if (used.has(i)) continue;
        used.add(i);
        sample.push(normAll[i]!);
      }
      const Ec = eightPoint(sample);
      const inliers: typeof normAll = [];
      for (const p of normAll) {
        if (sampsonError(Ec, p) < thresh * 50) inliers.push(p);
      }
      if (inliers.length > bestCount) {
        bestCount = inliers.length;
        bestE = Ec;
        bestSet = inliers;
      }
    }
    if (bestE && bestSet.length >= 8) {
      E = eightPoint(bestSet);
      bestInliers = bestSet;
    }
  }

  if (bestInliers.length < 8) return null;
  const candidates = recoverPoseCandidates(E);
  let best = candidates[0]!;
  let bestScore = -1;
  for (const c of candidates) {
    const score = cheiralityScore(c.R, c.t, bestInliers);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (bestScore < 4) return null;

  const errs = bestInliers.map((p) => sampsonError(E, p));
  const R: Mat3 = [
    [best.R[0]![0]!, best.R[0]![1]!, best.R[0]![2]!],
    [best.R[1]![0]!, best.R[1]![1]!, best.R[1]![2]!],
    [best.R[2]![0]!, best.R[2]![1]!, best.R[2]![2]!],
  ];
  return {
    R,
    t: [best.t[0]!, best.t[1]!, best.t[2]!],
    inlierRatio: bestInliers.length / normAll.length,
    residual: median(errs),
  };
}

export function relativePoseToQuaternion(pose: RelativePose): RawQuaternion {
  return mat3ToQuaternion(pose.R);
}

/**
 * カメラ中心の移動（cam0 系）: C1 = -R^T t（OpenCV recoverPose 規約）。
 * 返す t は単位並進のカメラ運動方向（cam0 がどちらへ動いたか）。
 */
export function cameraMotionFromRelativePose(pose: RelativePose): RawTranslation {
  const R = pose.R;
  const t = pose.t;
  // -R^T t
  const Rt = [
    [R[0][0], R[1][0], R[2][0]],
    [R[0][1], R[1][1], R[2][1]],
    [R[0][2], R[1][2], R[2][2]],
  ];
  const mx = -(Rt[0]![0]! * t[0] + Rt[0]![1]! * t[1] + Rt[0]![2]! * t[2]);
  const my = -(Rt[1]![0]! * t[0] + Rt[1]![1]! * t[1] + Rt[1]![2]! * t[2]);
  const mz = -(Rt[2]![0]! * t[0] + Rt[2]![1]! * t[1] + Rt[2]![2]! * t[2]);
  const n = Math.hypot(mx, my, mz) || 1;
  return [mx / n, my / n, mz / n];
}

/** 対応点の median flow（px）。スケール結合用。 */
export function medianFlowPx(pairs: PixelPair[]): number {
  if (pairs.length === 0) return 0;
  const flows = pairs.map((p) => Math.hypot(p.x1 - p.x0, p.y1 - p.y0));
  return median(flows);
}
