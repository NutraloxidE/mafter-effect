/**
 * バンドル調整: Levenberg-Marquardt + Schur 補元（point ブロック消去）。
 * - カメラ 6 パラメータ（angle-axis + t、X_cam = R X + t）
 * - 共有焦点距離 f を任意で同時最適化（fx = fy = f、主点固定）
 * - Huber ロバスト損失（IRLS 重み）
 * cameras / points は in-place 更新。純計算（DOM/乱数なし）。
 */

import {
  huberSqrtWeight,
  invSym3,
  m3Mul,
  m3MulVec,
  so3Exp,
  so3Log,
  solveSymmetric,
  v3Add,
  type M3,
  type V3,
} from "./sfmCore";

export interface BaCamera {
  /** angle-axis（world→cam） */
  r: V3;
  t: V3;
  /** true ならゲージ固定（最適化から除外） */
  fixed: boolean;
}

export interface BaObservation {
  cam: number;
  pt: number;
  u: number;
  v: number;
}

export interface BaOptions {
  focal: number;
  cx: number;
  cy: number;
  optimizeFocal: boolean;
  huberPx?: number;
  maxIterations?: number;
  /** 相対コスト減少がこれ未満で収束 */
  costTolerance?: number;
}

export interface BaResult {
  focal: number;
  iterations: number;
  initialMedianErrPx: number;
  medianErrPx: number;
  converged: boolean;
}

const INVALID_DEPTH_COST = 1e4;

function computeCostAndErrs(
  ts: V3[],
  Rs: M3[],
  points: V3[],
  obs: BaObservation[],
  f: number,
  cx: number,
  cy: number,
  huberPx: number,
): { cost: number; errs: number[] } {
  let cost = 0;
  const errs: number[] = [];
  for (const o of obs) {
    const R = Rs[o.cam]!;
    const t = ts[o.cam]!;
    const X = points[o.pt]!;
    const p = v3Add(m3MulVec(R, X), t);
    if (p[2] <= 1e-9) {
      cost += INVALID_DEPTH_COST;
      errs.push(Infinity);
      continue;
    }
    const u = (f * p[0]) / p[2] + cx;
    const v = (f * p[1]) / p[2] + cy;
    const r = Math.hypot(u - o.u, v - o.v);
    errs.push(r);
    cost += r <= huberPx ? r * r : huberPx * (2 * r - huberPx);
  }
  return { cost, errs };
}

function medianFinite(errs: number[]): number {
  const fin = errs.filter((e) => Number.isFinite(e)).sort((a, b) => a - b);
  if (fin.length === 0) return Infinity;
  return fin[Math.floor(fin.length / 2)]!;
}

/** 点ごとの c-block cross 項（off = c-block オフセット、width = 1(focal) or 6(camera)）。 */
interface CrossBlock {
  off: number;
  width: number;
  /** width×3 row-major */
  W: Float64Array;
}

export function bundleAdjust(
  cameras: BaCamera[],
  points: V3[],
  obs: BaObservation[],
  opts: BaOptions,
): BaResult {
  const huberPx = opts.huberPx ?? 2;
  const maxIterations = opts.maxIterations ?? 30;
  const costTol = opts.costTolerance ?? 1e-5;
  const cx = opts.cx;
  const cy = opts.cy;
  let focal = opts.focal;
  const focal0 = opts.focal;

  // c-block レイアウト: [focal?] + 非固定カメラ×6
  const focalOff = opts.optimizeFocal ? 0 : -1;
  const camOff: number[] = new Array<number>(cameras.length).fill(-1);
  let nc = opts.optimizeFocal ? 1 : 0;
  for (let i = 0; i < cameras.length; i++) {
    if (cameras[i]!.fixed) continue;
    camOff[i] = nc;
    nc += 6;
  }

  const nPoints = points.length;
  let Rs = cameras.map((c) => so3Exp(c.r));
  let ts = cameras.map((c) => [...c.t] as V3);

  const first = computeCostAndErrs(ts, Rs, points, obs, focal, cx, cy, huberPx);
  let currentCost = first.cost;
  const initialMedianErrPx = medianFinite(first.errs);

  let lambda = 1e-3;
  let iterations = 0;
  let converged = false;
  let lastErrs = first.errs;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;

    // ---- 線形化（λ 非依存の基礎項を蓄積）----
    const baseScc = new Float64Array(nc * nc);
    const baseBc = new Float64Array(nc);
    const Hpp: Array<M3 | null> = new Array<M3 | null>(nPoints).fill(null);
    const bp: Array<V3 | null> = new Array<V3 | null>(nPoints).fill(null);
    const crossByPoint: CrossBlock[][] = Array.from({ length: nPoints }, () => []);

    for (const o of obs) {
      const R = Rs[o.cam]!;
      const t = ts[o.cam]!;
      const X = points[o.pt]!;
      const p = v3Add(m3MulVec(R, X), t);
      if (p[2] <= 1e-9) continue;
      const invZ = 1 / p[2];
      const uPred = focal * p[0] * invZ + cx;
      const vPred = focal * p[1] * invZ + cy;
      const ru = uPred - o.u;
      const rv = vPred - o.v;
      const w = huberSqrtWeight(Math.hypot(ru, rv), huberPx);

      // 射影 Jacobian（2×3）: ∂(u,v)/∂p
      const ju: V3 = [focal * invZ, 0, -focal * p[0] * invZ * invZ];
      const jv: V3 = [0, focal * invZ, -focal * p[1] * invZ * invZ];

      // 点: J_pt = J_proj · R（2×3）
      const jptU: V3 = [0, 0, 0];
      const jptV: V3 = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        jptU[k] = w * (ju[0] * R[0][k]! + ju[1] * R[1][k]! + ju[2] * R[2][k]!);
        jptV[k] = w * (jv[0] * R[0][k]! + jv[1] * R[1][k]! + jv[2] * R[2][k]!);
      }

      // カメラ: [dω | dt]。dp/dδω = -[p_r]×, p_r = R X = p - t
      const px = p[0] - t[0];
      const py = p[1] - t[1];
      const pz = p[2] - t[2];
      const negCross: M3 = [
        [0, pz, -py],
        [-pz, 0, px],
        [py, -px, 0],
      ];
      const jcU = new Float64Array(6);
      const jcV = new Float64Array(6);
      for (let k = 0; k < 3; k++) {
        jcU[k] =
          w * (ju[0] * negCross[0][k]! + ju[1] * negCross[1][k]! + ju[2] * negCross[2][k]!);
        jcV[k] =
          w * (jv[0] * negCross[0][k]! + jv[1] * negCross[1][k]! + jv[2] * negCross[2][k]!);
        jcU[3 + k] = w * ju[k]!;
        jcV[3 + k] = w * jv[k]!;
      }

      // 焦点距離: du/df = p_x/z, dv/df = p_y/z
      const jfU = w * (p[0] * invZ);
      const jfV = w * (p[1] * invZ);

      const wru = w * ru;
      const wrv = w * rv;

      // ---- 点ブロック ----
      let hpp = Hpp[o.pt];
      let bpj = bp[o.pt];
      if (!hpp || !bpj) {
        hpp = [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ];
        bpj = [0, 0, 0];
        Hpp[o.pt] = hpp;
        bp[o.pt] = bpj;
      }
      for (let r = 0; r < 3; r++) {
        bpj[r]! -= jptU[r]! * wru + jptV[r]! * wrv;
        for (let c = r; c < 3; c++) {
          hpp[r]![c]! += jptU[r]! * jptU[c]! + jptV[r]! * jptV[c]!;
        }
      }
      hpp[1]![0] = hpp[0]![1]!;
      hpp[2]![0] = hpp[0]![2]!;
      hpp[2]![1] = hpp[1]![2]!;

      const co = camOff[o.cam]!;

      // ---- c-block 直接項 ----
      if (co >= 0) {
        for (let r = 0; r < 6; r++) {
          baseBc[co + r]! -= jcU[r]! * wru + jcV[r]! * wrv;
          for (let c = 0; c < 6; c++) {
            baseScc[(co + r) * nc + (co + c)]! += jcU[r]! * jcU[c]! + jcV[r]! * jcV[c]!;
          }
        }
      }
      if (focalOff >= 0) {
        baseScc[focalOff * nc + focalOff]! += jfU * jfU + jfV * jfV;
        baseBc[focalOff]! -= jfU * wru + jfV * wrv;
        if (co >= 0) {
          for (let c = 0; c < 6; c++) {
            const val = jfU * jcU[c]! + jfV * jcV[c]!;
            baseScc[focalOff * nc + (co + c)]! += val;
            baseScc[(co + c) * nc + focalOff]! += val;
          }
        }
      }

      // ---- cross（c-block × point）----
      if (co >= 0) {
        const W = new Float64Array(6 * 3);
        for (let r = 0; r < 6; r++) {
          for (let c = 0; c < 3; c++) {
            W[r * 3 + c] = jcU[r]! * jptU[c]! + jcV[r]! * jptV[c]!;
          }
        }
        crossByPoint[o.pt]!.push({ off: co, width: 6, W });
      }
      if (focalOff >= 0) {
        const W = new Float64Array(3);
        for (let c = 0; c < 3; c++) {
          W[c] = jfU * jptU[c]! + jfV * jptV[c]!;
        }
        crossByPoint[o.pt]!.push({ off: focalOff, width: 1, W });
      }
    }

    // ---- λ 試行ループ ----
    let accepted = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const Scc = new Float64Array(baseScc);
      const bc = new Float64Array(baseBc);
      for (let d = 0; d < nc; d++) Scc[d * nc + d]! *= 1 + lambda;

      // 点消去
      const HppInv: Array<M3 | null> = new Array<M3 | null>(nPoints).fill(null);
      for (let j = 0; j < nPoints; j++) {
        const hpp = Hpp[j];
        const bpj = bp[j];
        if (!hpp || !bpj) continue;
        const damped: M3 = [
          [hpp[0][0] * (1 + lambda), hpp[0][1], hpp[0][2]],
          [hpp[1][0], hpp[1][1] * (1 + lambda), hpp[1][2]],
          [hpp[2][0], hpp[2][1], hpp[2][2] * (1 + lambda)],
        ];
        const inv = invSym3(damped);
        if (!inv) continue;
        HppInv[j] = inv;
        const y = m3MulVec(inv, bpj);
        const entries = crossByPoint[j]!;
        for (const a of entries) {
          for (let r = 0; r < a.width; r++) {
            bc[a.off + r]! -=
              a.W[r * 3 + 0]! * y[0] + a.W[r * 3 + 1]! * y[1] + a.W[r * 3 + 2]! * y[2];
          }
        }
        for (const a of entries) {
          // T = W_a · inv（width_a × 3）
          const T = new Float64Array(a.width * 3);
          for (let r = 0; r < a.width; r++) {
            for (let c = 0; c < 3; c++) {
              T[r * 3 + c] =
                a.W[r * 3 + 0]! * inv[0][c]! +
                a.W[r * 3 + 1]! * inv[1][c]! +
                a.W[r * 3 + 2]! * inv[2][c]!;
            }
          }
          for (const b of entries) {
            for (let r = 0; r < a.width; r++) {
              for (let c = 0; c < b.width; c++) {
                Scc[(a.off + r) * nc + (b.off + c)]! -=
                  T[r * 3 + 0]! * b.W[c * 3 + 0]! +
                  T[r * 3 + 1]! * b.W[c * 3 + 1]! +
                  T[r * 3 + 2]! * b.W[c * 3 + 2]!;
              }
            }
          }
        }
      }

      const deltaC = nc > 0 ? solveSymmetric(Scc, bc, nc, 1e-9) : new Float64Array(0);
      if (nc > 0 && !deltaC) {
        lambda *= 10;
        continue;
      }
      const dC = deltaC ?? new Float64Array(0);

      // 候補パラメータ
      const newFocal =
        focalOff >= 0 ? Math.max(focal0 * 0.2, Math.min(focal0 * 5, focal + dC[focalOff]!)) : focal;
      const newRs: M3[] = new Array<M3>(cameras.length);
      const newTs: V3[] = new Array<V3>(cameras.length);
      for (let i = 0; i < cameras.length; i++) {
        const co = camOff[i]!;
        if (co < 0) {
          newRs[i] = Rs[i]!;
          newTs[i] = ts[i]!;
          continue;
        }
        const dw: V3 = [dC[co]!, dC[co + 1]!, dC[co + 2]!];
        const dt: V3 = [dC[co + 3]!, dC[co + 4]!, dC[co + 5]!];
        newRs[i] = m3Mul(so3Exp(dw), Rs[i]!);
        newTs[i] = [ts[i]![0] + dt[0], ts[i]![1] + dt[1], ts[i]![2] + dt[2]];
      }
      const newPoints: V3[] = new Array<V3>(nPoints);
      for (let j = 0; j < nPoints; j++) {
        const inv = HppInv[j];
        const bpj = bp[j];
        const X = points[j]!;
        if (!inv || !bpj) {
          newPoints[j] = X;
          continue;
        }
        // δp = inv (bp - Σ Wᵀ δc)
        const s: V3 = [bpj[0], bpj[1], bpj[2]];
        for (const a of crossByPoint[j]!) {
          for (let r = 0; r < a.width; r++) {
            const d = dC[a.off + r]!;
            s[0] -= a.W[r * 3 + 0]! * d;
            s[1] -= a.W[r * 3 + 1]! * d;
            s[2] -= a.W[r * 3 + 2]! * d;
          }
        }
        const dp = m3MulVec(inv, s);
        newPoints[j] = [X[0] + dp[0], X[1] + dp[1], X[2] + dp[2]];
      }

      const trial = computeCostAndErrs(newTs, newRs, newPoints, obs, newFocal, cx, cy, huberPx);
      if (trial.cost < currentCost) {
        const rel = (currentCost - trial.cost) / Math.max(currentCost, 1e-12);
        Rs = newRs;
        ts = newTs;
        for (let j = 0; j < nPoints; j++) points[j] = newPoints[j]!;
        focal = newFocal;
        currentCost = trial.cost;
        lastErrs = trial.errs;
        lambda = Math.max(1e-8, lambda / 3);
        accepted = true;
        if (rel < costTol) converged = true;
        break;
      }
      lambda *= 10;
    }

    if (!accepted || converged) break;
  }

  // 正準表現へ書き戻し
  for (let i = 0; i < cameras.length; i++) {
    if (cameras[i]!.fixed) continue;
    cameras[i]!.r = so3Log(Rs[i]!);
    cameras[i]!.t = ts[i]!;
  }

  return {
    focal,
    iterations,
    initialMedianErrPx,
    medianErrPx: medianFinite(lastErrs),
    converged,
  };
}
