/**
 * PnP RANSAC + pose-only Levenberg-Marquardt 精密化（solve 専用・純関数）。
 * 内部の線形解は既存 solvePnPDlt（DLT）を最小サンプルに使う。
 */

import {
  huberSqrtWeight,
  m3Mul,
  m3MulVec,
  smallestEigenvectorSym,
  so3Exp,
  so3Log,
  solveSymmetric,
  v3Add,
  v3Cross,
  v3Dot,
  v3Normalize,
  v3Scale,
  v3Sub,
  projectPoint,
  type CamPose,
  type M3,
  type V3,
  SfmRng,
} from "./sfmCore";

export interface Correspondence2d3d {
  X: V3;
  u: number;
  v: number;
}

/** 線形 PnP（DLT・正規化座標）。P の 12 次 nullspace を Jacobi 固有分解で解く。 */
function poseFromDlt(world: V3[], norms: Array<{ x: number; y: number }>): CamPose | null {
  const n = Math.min(world.length, norms.length);
  if (n < 6) return null;
  const AtA = new Float64Array(144);
  const addRow = (row: number[]) => {
    for (let r = 0; r < 12; r++) {
      for (let c = r; c < 12; c++) AtA[r * 12 + c]! += row[r]! * row[c]!;
    }
  };
  for (let i = 0; i < n; i++) {
    const [X, Y, Z] = world[i]!;
    const x = norms[i]!.x;
    const y = norms[i]!.y;
    addRow([X, Y, Z, 1, 0, 0, 0, 0, -x * X, -x * Y, -x * Z, -x]);
    addRow([0, 0, 0, 0, X, Y, Z, 1, -y * X, -y * Y, -y * Z, -y]);
  }
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < r; c++) AtA[r * 12 + c] = AtA[c * 12 + r]!;
  }
  const p = smallestEigenvectorSym(AtA, 12);
  if (!p) return null;

  // 射影スケール λ は負もありうる → ±両候補を SO(3) 射影して cheirality で選ぶ
  const s = Math.hypot(p[8]!, p[9]!, p[10]!);
  if (!(s > 1e-12)) return null;
  let best: { pose: CamPose; front: number } | null = null;
  for (const sigma of [1, -1] as const) {
    const M: M3 = [
      [sigma * p[0]!, sigma * p[1]!, sigma * p[2]!],
      [sigma * p[4]!, sigma * p[5]!, sigma * p[6]!],
      [sigma * p[8]!, sigma * p[9]!, sigma * p[10]!],
    ];
    const m0: V3 = [M[0][0], M[0][1], M[0][2]];
    const m1: V3 = [M[1][0], M[1][1], M[1][2]];
    const r0 = v3Normalize(m0);
    let r1 = v3Sub(m1, v3Scale(r0, v3Dot(r0, m1)));
    const r1n = Math.hypot(r1[0], r1[1], r1[2]);
    if (r1n < 1e-12) continue;
    r1 = v3Scale(r1, 1 / r1n);
    const r2 = v3Cross(r0, r1);
    const R: M3 = [r0, r1, r2];
    const t: V3 = [(sigma * p[3]!) / s, (sigma * p[7]!) / s, (sigma * p[11]!) / s];
    let front = 0;
    for (const X of world) {
      const z = R[2][0] * X[0] + R[2][1] * X[1] + R[2][2] * X[2] + t[2];
      if (z > 0) front++;
    }
    if (!best || front > best.front) best = { pose: { R, t }, front };
  }
  if (!best || best.front < n / 2) return null;
  return best.pose;
}

function reprojErrPx(pose: CamPose, f: number, cx: number, cy: number, c: Correspondence2d3d): number {
  const pr = projectPoint(pose, f, cx, cy, c.X);
  if (!pr) return Infinity;
  return Math.hypot(pr.u - c.u, pr.v - c.v);
}

export interface PnpRansacResult {
  pose: CamPose;
  inlierIdx: number[];
  medianErrPx: number;
}

/**
 * RANSAC PnP。threshPx 以内を inlier、最後に inlier 全体で pose-only LM。
 */
export function pnpRansac(
  corrs: Correspondence2d3d[],
  f: number,
  cx: number,
  cy: number,
  rng: SfmRng,
  opts?: { iterations?: number; threshPx?: number; initialPose?: CamPose },
): PnpRansacResult | null {
  const n = corrs.length;
  if (n < 6) return null;
  const iterations = opts?.iterations ?? 120;
  const threshPx = opts?.threshPx ?? 3;

  let bestInliers: number[] = [];
  let bestPose: CamPose | null = null;

  // 初期ポーズがあれば候補に含める（時間的連続性の活用）
  if (opts?.initialPose) {
    const inliers: number[] = [];
    for (let i = 0; i < n; i++) {
      if (reprojErrPx(opts.initialPose, f, cx, cy, corrs[i]!) < threshPx) inliers.push(i);
    }
    if (inliers.length >= 6) {
      bestInliers = inliers;
      bestPose = opts.initialPose;
    }
  }

  for (let it = 0; it < iterations; it++) {
    const idx = rng.sample(n, 6);
    const world = idx.map((i) => corrs[i]!.X);
    const norms = idx.map((i) => ({
      x: (corrs[i]!.u - cx) / f,
      y: (corrs[i]!.v - cy) / f,
    }));
    const pose = poseFromDlt(world, norms);
    if (!pose) continue;
    const inliers: number[] = [];
    for (let i = 0; i < n; i++) {
      if (reprojErrPx(pose, f, cx, cy, corrs[i]!) < threshPx) inliers.push(i);
    }
    if (inliers.length > bestInliers.length) {
      bestInliers = inliers;
      bestPose = pose;
    }
  }
  if (!bestPose || bestInliers.length < 6) return null;

  // inlier 全体で LM 精密化 → inlier 再判定 → もう一度 LM
  let pose = bestPose;
  for (let round = 0; round < 2; round++) {
    const subset = bestInliers.map((i) => corrs[i]!);
    pose = refinePoseLm(pose, subset, f, cx, cy, { iterations: 12, huberPx: threshPx });
    const next: number[] = [];
    for (let i = 0; i < n; i++) {
      if (reprojErrPx(pose, f, cx, cy, corrs[i]!) < threshPx) next.push(i);
    }
    if (next.length < 6) break;
    bestInliers = next;
  }

  const errs = bestInliers
    .map((i) => reprojErrPx(pose, f, cx, cy, corrs[i]!))
    .sort((a, b) => a - b);
  const medianErr = errs.length > 0 ? errs[Math.floor(errs.length / 2)]! : Infinity;
  return { pose, inlierIdx: bestInliers, medianErrPx: medianErr };
}

/**
 * pose-only LM（6 パラメータ・Huber IRLS）。
 * 更新は左乗算増分: R ← exp([δω]×)·R, t ← t + δt。
 */
export function refinePoseLm(
  initial: CamPose,
  corrs: Correspondence2d3d[],
  f: number,
  cx: number,
  cy: number,
  opts?: { iterations?: number; huberPx?: number },
): CamPose {
  const iterations = opts?.iterations ?? 10;
  const huberPx = opts?.huberPx ?? 2;
  let R = initial.R;
  let t = initial.t;
  let lambda = 1e-3;

  const cost = (Rc: M3, tc: V3): number => {
    let sum = 0;
    for (const c of corrs) {
      const pr = projectPoint({ R: Rc, t: tc }, f, cx, cy, c.X);
      if (!pr) {
        sum += 100 * 100;
        continue;
      }
      const r = Math.hypot(pr.u - c.u, pr.v - c.v);
      // Huber コスト
      sum += r <= huberPx ? r * r : huberPx * (2 * r - huberPx);
    }
    return sum;
  };

  let currentCost = cost(R, t);

  for (let it = 0; it < iterations; it++) {
    const H = new Float64Array(36);
    const g = new Float64Array(6);
    for (const c of corrs) {
      const p = v3Add(m3MulVec(R, c.X), t);
      if (p[2] <= 1e-9) continue;
      const invZ = 1 / p[2];
      const u = f * p[0] * invZ + cx;
      const v = f * p[1] * invZ + cy;
      const ru = u - c.u;
      const rv = v - c.v;
      const rn = Math.hypot(ru, rv);
      const w = huberSqrtWeight(rn, huberPx);

      // ∂p/∂δω = -[p_r]×（p_r = R X）、∂p/∂δt = I
      const pr: V3 = [p[0] - t[0], p[1] - t[1], p[2] - t[2]];
      // J_proj: 2x3
      const ju: V3 = [f * invZ, 0, -f * p[0] * invZ * invZ];
      const jv: V3 = [0, f * invZ, -f * p[1] * invZ * invZ];
      // 2x6 行 [dω(3), dt(3)]
      const rowU = new Float64Array(6);
      const rowV = new Float64Array(6);
      // dω: j · (-[pr]×) → j × pr の巡回で書ける: (-[pr]× )ᵀ j = j × pr… 展開して直接:
      // (-[pr]×) の列 k に対する j·col
      // [pr]× = [[0,-z,y],[z,0,-x],[-y,x,0]]
      const [px, py, pz] = pr;
      const negCross: M3 = [
        [0, pz, -py],
        [-pz, 0, px],
        [py, -px, 0],
      ];
      for (let k = 0; k < 3; k++) {
        rowU[k] = w * (ju[0] * negCross[0][k]! + ju[1] * negCross[1][k]! + ju[2] * negCross[2][k]!);
        rowV[k] = w * (jv[0] * negCross[0][k]! + jv[1] * negCross[1][k]! + jv[2] * negCross[2][k]!);
        rowU[3 + k] = w * ju[k]!;
        rowV[3 + k] = w * jv[k]!;
      }
      const wu = w * ru;
      const wv = w * rv;
      for (let r = 0; r < 6; r++) {
        g[r]! += rowU[r]! * wu + rowV[r]! * wv;
        for (let cc = r; cc < 6; cc++) {
          H[r * 6 + cc]! += rowU[r]! * rowU[cc]! + rowV[r]! * rowV[cc]!;
        }
      }
    }
    for (let r = 0; r < 6; r++) {
      for (let cc = 0; cc < r; cc++) H[r * 6 + cc] = H[cc * 6 + r]!;
    }

    let improved = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const Hd = new Float64Array(H);
      for (let d = 0; d < 6; d++) Hd[d * 6 + d]! *= 1 + lambda;
      const negG = new Float64Array(6);
      for (let d = 0; d < 6; d++) negG[d] = -g[d]!;
      const delta = solveSymmetric(Hd, negG, 6);
      if (!delta) {
        lambda *= 10;
        continue;
      }
      const dw: V3 = [delta[0]!, delta[1]!, delta[2]!];
      const dt: V3 = [delta[3]!, delta[4]!, delta[5]!];
      const Rn = m3Mul(so3Exp(dw), R);
      const tn: V3 = [t[0] + dt[0], t[1] + dt[1], t[2] + dt[2]];
      const newCost = cost(Rn, tn);
      if (newCost < currentCost) {
        R = Rn;
        t = tn;
        currentCost = newCost;
        lambda = Math.max(1e-7, lambda / 3);
        improved = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }

  // R を SO(3) に射影し直す（数値誤差の蓄積防止）
  const w = so3Log(R);
  return { R: so3Exp(w), t };
}
