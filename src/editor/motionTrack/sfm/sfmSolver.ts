/**
 * オフライン SfM ソルバ（AE 3D Camera Tracker 相当の一括解法）。
 *
 * 長寿命トラック → キーフレーム選択 → 視差最大ペアで初期化（essential + 三角測量）
 * → 逐次 PnP + 新規点三角測量 → 全体バンドル調整（外れ値除去付き）
 * → 全フレーム pose-only 局所化 → frame0 基準へ再アンカー。
 *
 * world 座標 = frame0 のカメラ座標（+x 右 / +y 下 / +z 前方）。
 * 出力 q は world→cam 回転、c はカメラ中心（world）。スケールは不定（単眼）。
 */

import {
  cameraCenter,
  m3Mul,
  m3ToQuat,
  m3Transpose,
  m3MulVec,
  median,
  poseFromCenter,
  quatSlerp,
  quatToM3,
  so3Exp,
  so3Log,
  projectPoint,
  triangulationAngleDeg,
  triangulateDlt,
  v3Norm,
  v3Sub,
  type CamPose,
  type M3,
  type Quat,
  type V3,
  SfmRng,
} from "./sfmCore";
import { commonTrackPairs, selectKeyframes, type TrackTable } from "./sfmTracks";
import { estimateTwoViewInit, sweepFocalCandidates, type PxPair, type TwoViewInit } from "./sfmTwoView";
import { pnpRansac, refinePoseLm, type Correspondence2d3d } from "./sfmPnp";
import { bundleAdjust, type BaCamera, type BaObservation } from "./sfmBa";
import { smallestEigenvectorSym } from "./sfmCore";

export type SfmProgressStage = "init" | "map" | "ba" | "frames";

export interface SfmSolveOptions {
  width: number;
  height: number;
  /** 焦点距離の初期推定（px、追跡解像度基準） */
  focalPx: number;
  optimizeFocal: boolean;
  seed?: number;
  onProgress?: (stage: SfmProgressStage, current: number, total: number) => void;
}

export interface SfmFramePose {
  solved: boolean;
  /** world(=frame0 cam) → cam 回転 */
  q: Quat;
  /** カメラ中心（world、スケール不定） */
  c: V3;
  reprojErrPx: number;
  numPoints: number;
}

export interface SfmSolveResult {
  mode: "sfm" | "rotationOnly" | "failed";
  frames: SfmFramePose[];
  focalPx: number;
  keyframes: number[];
  pointCount: number;
  medianReprojErrPx: number;
  message?: string;
}

const MIN_INIT_COMMON = 40;
const MIN_INIT_POINTS = 30;
const MIN_INIT_ANGLE_DEG = 0.8;
const MIN_PNP_CORRS = 10;
const TRI_MIN_ANGLE_DEG = 0.4;
const TRI_MAX_REPROJ_PX = 3;
const OBS_OUTLIER_PX = 3;
const BA_EVERY_N_KFS = 5;

interface SolverState {
  table: TrackTable;
  width: number;
  height: number;
  cx: number;
  cy: number;
  focal: number;
  rng: SfmRng;
  /** KF frame → pose */
  kfPose: Map<number, CamPose>;
  /** trackIdx → world 点 */
  pointByTrack: Map<number, V3>;
  /** trackIdx → BA 外れ値として除去した frame 集合 */
  removedObs: Map<number, Set<number>>;
}

function obsAt(state: SolverState, frame: number): Array<{ trackIdx: number; x: number; y: number }> {
  const out: Array<{ trackIdx: number; x: number; y: number }> = [];
  for (const e of state.table.frameIndex[frame] ?? []) {
    const o = state.table.tracks[e.trackIdx]!.obs[e.obsIdx]!;
    out.push({ trackIdx: e.trackIdx, x: o.x, y: o.y });
  }
  return out;
}

function isObsRemoved(state: SolverState, trackIdx: number, frame: number): boolean {
  return state.removedObs.get(trackIdx)?.has(frame) ?? false;
}

function collect2d3d(
  state: SolverState,
  frame: number,
): Array<Correspondence2d3d & { trackIdx: number }> {
  const out: Array<Correspondence2d3d & { trackIdx: number }> = [];
  for (const o of obsAt(state, frame)) {
    const X = state.pointByTrack.get(o.trackIdx);
    if (!X) continue;
    if (isObsRemoved(state, o.trackIdx, frame)) continue;
    out.push({ X, u: o.x, v: o.y, trackIdx: o.trackIdx });
  }
  return out;
}

/** 視差ポテンシャル: flow ベクトルの中央値まわりの ばらつき（回転/パンは一様 flow）。 */
function flowSpread(pairs: PxPair[]): number {
  if (pairs.length === 0) return 0;
  const dxs = pairs.map((p) => p.x1 - p.x0);
  const dys = pairs.map((p) => p.y1 - p.y0);
  const mx = median(dxs);
  const my = median(dys);
  const dev = pairs.map((p) => Math.hypot(p.x1 - p.x0 - mx, p.y1 - p.y0 - my));
  return median(dev);
}

interface InitPairResult {
  kfA: number;
  kfB: number;
  init: TwoViewInit;
  pairs: PxPair[];
  trackIdxs: number[];
  focal: number;
}

function findInitPair(state: SolverState, kfs: number[], optimizeFocal: boolean): InitPairResult | null {
  interface Candidate {
    kfA: number;
    kfB: number;
    pairs: PxPair[];
    trackIdxs: number[];
    spread: number;
  }
  const candidates: Candidate[] = [];
  for (let i = 0; i < kfs.length; i++) {
    for (let j = i + 1; j < Math.min(kfs.length, i + 10); j++) {
      const common = commonTrackPairs(state.table, kfs[i]!, kfs[j]!);
      if (common.length < MIN_INIT_COMMON) continue;
      const pairs: PxPair[] = common.map((c) => ({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }));
      const spread = flowSpread(pairs);
      if (spread < 2) continue;
      candidates.push({
        kfA: kfs[i]!,
        kfB: kfs[j]!,
        pairs,
        trackIdxs: common.map((c) => c.trackIdx),
        spread,
      });
    }
  }
  candidates.sort(
    (a, b) => b.spread * Math.sqrt(b.pairs.length) - a.spread * Math.sqrt(a.pairs.length),
  );

  let best: InitPairResult | null = null;
  let bestScore = -1;
  const tryCount = Math.min(candidates.length, 6);
  for (let k = 0; k < tryCount; k++) {
    const c = candidates[k]!;
    const init = estimateTwoViewInit(c.pairs, state.focal, state.cx, state.cy, state.rng, {
      iterations: 200,
      minAngleDeg: 0.3,
    });
    if (!init) continue;
    if (init.points.length < MIN_INIT_POINTS) continue;
    if (init.medianAngleDeg < MIN_INIT_ANGLE_DEG) continue;
    const score = init.points.length * Math.min(init.medianAngleDeg, 10);
    if (score > bestScore) {
      bestScore = score;
      best = { kfA: c.kfA, kfB: c.kfB, init, pairs: c.pairs, trackIdxs: c.trackIdxs, focal: state.focal };
    }
  }
  if (!best) return null;

  if (optimizeFocal) {
    const sweep = sweepFocalCandidates(
      best.pairs,
      state.width,
      state.height,
      state.focal,
      state.rng,
    );
    if (sweep && sweep.init.points.length >= MIN_INIT_POINTS) {
      best = { ...best, init: sweep.init, focal: sweep.focal };
    }
  }
  return best;
}

/** frame の新規トラックを、solved KF を相手に三角測量してマップへ追加。 */
function triangulateNewPoints(state: SolverState, frame: number): number {
  const pose = state.kfPose.get(frame);
  if (!pose) return 0;
  const C1 = cameraCenter(pose);
  let added = 0;
  for (const o of obsAt(state, frame)) {
    if (state.pointByTrack.has(o.trackIdx)) continue;
    const track = state.table.tracks[o.trackIdx]!;
    // 相手: このトラックを観測する solved KF のうち基線最大
    let partner: { frame: number; pose: CamPose; x: number; y: number } | null = null;
    let bestBaseline = 0;
    for (const ob of track.obs) {
      if (ob.frame === frame) continue;
      const p = state.kfPose.get(ob.frame);
      if (!p) continue;
      const b = v3Norm(v3Sub(cameraCenter(p), C1));
      if (b > bestBaseline) {
        bestBaseline = b;
        partner = { frame: ob.frame, pose: p, x: ob.x, y: ob.y };
      }
    }
    if (!partner || bestBaseline < 1e-9) continue;

    const f = state.focal;
    const n0 = { x: (partner.x - state.cx) / f, y: (partner.y - state.cy) / f };
    const n1 = { x: (o.x - state.cx) / f, y: (o.y - state.cy) / f };
    const X = triangulateDlt(partner.pose, pose, n0.x, n0.y, n1.x, n1.y);
    if (!X) continue;
    const Xv: V3 = X;
    const pr0 = projectPoint(partner.pose, f, state.cx, state.cy, Xv);
    const pr1 = projectPoint(pose, f, state.cx, state.cy, Xv);
    if (!pr0 || !pr1) continue;
    if (Math.hypot(pr0.u - partner.x, pr0.v - partner.y) > TRI_MAX_REPROJ_PX) continue;
    if (Math.hypot(pr1.u - o.x, pr1.v - o.y) > TRI_MAX_REPROJ_PX) continue;
    const ang = triangulationAngleDeg(cameraCenter(partner.pose), C1, Xv);
    if (ang < TRI_MIN_ANGLE_DEG) continue;
    state.pointByTrack.set(o.trackIdx, Xv);
    added++;
  }
  return added;
}

/** solved KF + マップ点で全体 BA。外れ値除去付き。anchorFrame をゲージ固定。 */
function runGlobalBa(
  state: SolverState,
  anchorFrame: number,
  optimizeFocal: boolean,
  maxIterations: number,
): { medianErrPx: number } {
  const kfFrames = [...state.kfPose.keys()].sort((a, b) => a - b);
  const camIndexByFrame = new Map<number, number>();
  const cameras: BaCamera[] = [];
  for (const f of kfFrames) {
    const pose = state.kfPose.get(f)!;
    camIndexByFrame.set(f, cameras.length);
    cameras.push({ r: so3Log(pose.R), t: [...pose.t], fixed: f === anchorFrame });
  }

  const ptIndexByTrack = new Map<number, number>();
  const points: V3[] = [];
  const obs: BaObservation[] = [];
  const obsMeta: Array<{ trackIdx: number; frame: number }> = [];
  for (const [trackIdx, X] of state.pointByTrack) {
    const track = state.table.tracks[trackIdx]!;
    const trackObs: Array<{ cam: number; frame: number; u: number; v: number }> = [];
    for (const ob of track.obs) {
      const ci = camIndexByFrame.get(ob.frame);
      if (ci === undefined) continue;
      if (isObsRemoved(state, trackIdx, ob.frame)) continue;
      trackObs.push({ cam: ci, frame: ob.frame, u: ob.x, v: ob.y });
    }
    if (trackObs.length < 2) continue;
    const pi = points.length;
    ptIndexByTrack.set(trackIdx, pi);
    points.push([...X]);
    for (const to of trackObs) {
      obs.push({ cam: to.cam, pt: pi, u: to.u, v: to.v });
      obsMeta.push({ trackIdx, frame: to.frame });
    }
  }
  if (cameras.length < 2 || points.length < 10) return { medianErrPx: Infinity };

  const result = bundleAdjust(cameras, points, obs, {
    focal: state.focal,
    cx: state.cx,
    cy: state.cy,
    optimizeFocal,
    huberPx: 2,
    maxIterations,
  });
  state.focal = result.focal;

  // 書き戻し
  for (const f of kfFrames) {
    const ci = camIndexByFrame.get(f)!;
    const cam = cameras[ci]!;
    state.kfPose.set(f, { R: so3Exp(cam.r), t: [...cam.t] });
  }
  for (const [trackIdx, pi] of ptIndexByTrack) {
    state.pointByTrack.set(trackIdx, [...points[pi]!] as V3);
  }

  // 外れ値観測を除去 → 観測 2 未満の点を削除
  for (let k = 0; k < obs.length; k++) {
    const o = obs[k]!;
    const meta = obsMeta[k]!;
    const cam = cameras[o.cam]!;
    const pose: CamPose = { R: so3Exp(cam.r), t: cam.t };
    const pr = projectPoint(pose, state.focal, state.cx, state.cy, points[o.pt]!);
    const err = pr ? Math.hypot(pr.u - o.u, pr.v - o.v) : Infinity;
    if (err > OBS_OUTLIER_PX) {
      let set = state.removedObs.get(meta.trackIdx);
      if (!set) {
        set = new Set();
        state.removedObs.set(meta.trackIdx, set);
      }
      set.add(meta.frame);
    }
  }
  for (const [trackIdx] of [...state.pointByTrack]) {
    const track = state.table.tracks[trackIdx]!;
    let count = 0;
    for (const ob of track.obs) {
      if (!camIndexByFrame.has(ob.frame)) continue;
      if (isObsRemoved(state, trackIdx, ob.frame)) continue;
      count++;
    }
    if (count < 2) state.pointByTrack.delete(trackIdx);
  }

  return { medianErrPx: result.medianErrPx };
}

/** 全フレーム局所化（PnP tracking モード）+ 補間フィル + frame0 再アンカー。 */
function localizeAllFrames(
  state: SolverState,
  onProgress?: SfmSolveOptions["onProgress"],
): { poses: Array<CamPose | null>; stats: Array<{ err: number; n: number }> } {
  const n = state.table.frameCount;
  const poses: Array<CamPose | null> = new Array<CamPose | null>(n).fill(null);
  const stats: Array<{ err: number; n: number }> = new Array(n)
    .fill(null)
    .map(() => ({ err: Infinity, n: 0 }));

  const kfFrames = [...state.kfPose.keys()].sort((a, b) => a - b);
  const nearestKfPose = (f: number): CamPose | null => {
    let best: CamPose | null = null;
    let bestDist = Infinity;
    for (const kf of kfFrames) {
      const d = Math.abs(kf - f);
      if (d < bestDist) {
        bestDist = d;
        best = state.kfPose.get(kf)!;
      }
    }
    return best;
  };

  let prevPose: CamPose | null = null;
  for (let f = 0; f < n; f++) {
    if (f % 20 === 0) onProgress?.("frames", f, n);
    const kfp = state.kfPose.get(f);
    if (kfp) {
      poses[f] = kfp;
      const corrs = collect2d3d(state, f);
      stats[f] = { err: medianReproj(state, kfp, corrs), n: corrs.length };
      prevPose = kfp;
      continue;
    }
    const corrs = collect2d3d(state, f);
    if (corrs.length < 8) continue;
    const init = prevPose ?? nearestKfPose(f);
    let pose: CamPose | null = null;

    if (init) {
      // tracking モード: 予測ポーズの inlier が十分なら RANSAC を省略
      const inliers = corrs.filter((c) => {
        const pr = projectPoint(init, state.focal, state.cx, state.cy, c.X);
        return pr !== null && Math.hypot(pr.u - c.u, pr.v - c.v) < 8;
      });
      if (inliers.length >= Math.max(8, corrs.length * 0.5)) {
        pose = refinePoseLm(init, inliers, state.focal, state.cx, state.cy, {
          iterations: 12,
          huberPx: 2,
        });
        const err = medianReproj(state, pose, inliers);
        if (err > 4) pose = null;
      }
    }
    if (!pose) {
      const res = pnpRansac(corrs, state.focal, state.cx, state.cy, state.rng, {
        iterations: 60,
        threshPx: 3,
        initialPose: init ?? undefined,
      });
      if (res && res.inlierIdx.length >= 8) pose = res.pose;
    }
    if (pose) {
      poses[f] = pose;
      stats[f] = { err: medianReproj(state, pose, corrs), n: corrs.length };
      prevPose = pose;
    }
  }
  onProgress?.("frames", n, n);
  return { poses, stats };
}

function medianReproj(
  state: SolverState,
  pose: CamPose,
  corrs: Correspondence2d3d[],
): number {
  const errs: number[] = [];
  for (const c of corrs) {
    const pr = projectPoint(pose, state.focal, state.cx, state.cy, c.X);
    if (!pr) continue;
    errs.push(Math.hypot(pr.u - c.u, pr.v - c.v));
  }
  return median(errs);
}

/** null フレームを近傍 solved の slerp/lerp で補間。 */
function fillUnsolved(
  poses: Array<CamPose | null>,
): { filled: CamPose[]; solvedMask: boolean[] } | null {
  const n = poses.length;
  const solvedIdx: number[] = [];
  for (let i = 0; i < n; i++) if (poses[i]) solvedIdx.push(i);
  if (solvedIdx.length === 0) return null;

  const filled: CamPose[] = new Array(n);
  const solvedMask: boolean[] = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) solvedMask[i] = poses[i] !== null;

  let s = 0;
  for (let i = 0; i < n; i++) {
    const p = poses[i];
    if (p) {
      filled[i] = p;
      continue;
    }
    while (s < solvedIdx.length && solvedIdx[s]! < i) s++;
    const after = s < solvedIdx.length ? solvedIdx[s]! : -1;
    const before = s > 0 ? solvedIdx[s - 1]! : -1;
    if (before < 0 && after < 0) return null;
    if (before < 0) {
      filled[i] = poses[after]!;
      continue;
    }
    if (after < 0) {
      filled[i] = poses[before]!;
      continue;
    }
    const t = (i - before) / (after - before);
    const pa = poses[before]!;
    const pb = poses[after]!;
    const qa = m3ToQuat(pa.R);
    const qb = m3ToQuat(pb.R);
    const q = quatSlerp(qa, qb, t);
    const Ca = cameraCenter(pa);
    const Cb = cameraCenter(pb);
    const C: V3 = [
      Ca[0] + (Cb[0] - Ca[0]) * t,
      Ca[1] + (Cb[1] - Ca[1]) * t,
      Ca[2] + (Cb[2] - Ca[2]) * t,
    ];
    filled[i] = poseFromCenter(quatToM3(q), C);
  }
  return { filled, solvedMask };
}

type BearingPairV = [V3, V3];

function bearing(u: number, v: number, f: number, cx: number, cy: number): V3 {
  const x = (u - cx) / f;
  const y = (v - cy) / f;
  const n = Math.hypot(x, y, 1);
  return [x / n, y / n, 1 / n];
}

/**
 * Horn の閉形式で R·a ≈ b を当てはめる（Jacobi 固有分解・最大固有ベクトル）。
 * 既存 rotationEstimator の冪乗法は最大|λ| に収束し符号を誤るため solve では使わない。
 */
function hornFit(pairs: BearingPairV[]): M3 | null {
  if (pairs.length < 3) return null;
  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
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
  // 最大固有ベクトル = (-N) の最小固有ベクトル
  const N = [
    Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx,
    Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz,
    Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy,
    Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz,
  ];
  const negN = new Float64Array(16);
  for (let i = 0; i < 16; i++) negN[i] = -N[i]!;
  const q = smallestEigenvectorSym(negN, 4);
  if (!q) return null;
  // Horn の並びは [w, x, y, z]
  return quatToM3([q[1]!, q[2]!, q[3]!, q[0]!]);
}

function bearingResidual(R: M3, p: BearingPairV): number {
  const rb: V3 = [
    R[0][0] * p[0][0] + R[0][1] * p[0][1] + R[0][2] * p[0][2],
    R[1][0] * p[0][0] + R[1][1] * p[0][1] + R[1][2] * p[0][2],
    R[2][0] * p[0][0] + R[2][1] * p[0][1] + R[2][2] * p[0][2],
  ];
  return Math.hypot(rb[0] - p[1][0], rb[1] - p[1][1], rb[2] - p[1][2]);
}

/** RANSAC 付き Horn 回転。 */
function robustRotation(pairs: BearingPairV[], rng: SfmRng): M3 | null {
  if (pairs.length < 4) return null;
  const thresh = 3e-3; // 単位ベアリング差 ≈ rad
  let bestInliers: BearingPairV[] = [];
  for (let it = 0; it < 40; it++) {
    const idx = rng.sample(pairs.length, 4);
    const R = hornFit(idx.map((i) => pairs[i]!));
    if (!R) continue;
    const inliers = pairs.filter((p) => bearingResidual(R, p) < thresh);
    if (inliers.length > bestInliers.length) bestInliers = inliers;
  }
  if (bestInliers.length < Math.max(4, pairs.length * 0.3)) return null;
  return hornFit(bestInliers);
}

/** 回転のみフォールバック（視差なしクリップ: パン/チルト）。 */
function solveRotationOnly(
  table: TrackTable,
  opts: SfmSolveOptions,
): SfmSolveResult {
  const n = table.frameCount;
  const f = opts.focalPx;
  const cx = opts.width / 2;
  const cy = opts.height / 2;
  const rng = new SfmRng((opts.seed ?? 1) + 777);
  const frames: SfmFramePose[] = [];
  let R: M3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  frames.push({ solved: true, q: m3ToQuat(R), c: [0, 0, 0], reprojErrPx: 0, numPoints: 0 });
  for (let i = 1; i < n; i++) {
    const common = commonTrackPairs(table, i - 1, i);
    const pairs: BearingPairV[] = common.map((c) => [
      bearing(c.x0, c.y0, f, cx, cy),
      bearing(c.x1, c.y1, f, cx, cy),
    ]);
    let solved = false;
    if (pairs.length >= 8) {
      const Rrel = robustRotation(pairs, rng);
      if (Rrel) {
        // Rrel: cam_{i-1} 点 → cam_i 点（world→cam の相対）
        R = m3Mul(Rrel, R);
        solved = true;
      }
    }
    frames.push({
      solved,
      q: m3ToQuat(R),
      c: [0, 0, 0],
      reprojErrPx: solved ? 1 : Infinity,
      numPoints: pairs.length,
    });
  }
  return {
    mode: "rotationOnly",
    frames,
    focalPx: f,
    keyframes: [],
    pointCount: 0,
    medianReprojErrPx: Infinity,
    message: "視差が検出できないため回転のみ推定しました（パン/チルト相当）",
  };
}

export function solveSfm(table: TrackTable, opts: SfmSolveOptions): SfmSolveResult {
  const n = table.frameCount;
  if (n < 2 || table.tracks.length < 20) {
    return {
      mode: "failed",
      frames: [],
      focalPx: opts.focalPx,
      keyframes: [],
      pointCount: 0,
      medianReprojErrPx: Infinity,
      message: "トラック数が不足しています（テクスチャの少ない映像・短すぎる範囲）",
    };
  }

  const state: SolverState = {
    table,
    width: opts.width,
    height: opts.height,
    cx: opts.width / 2,
    cy: opts.height / 2,
    focal: opts.focalPx,
    rng: new SfmRng(opts.seed ?? 20260704),
    kfPose: new Map(),
    pointByTrack: new Map(),
    removedObs: new Map(),
  };

  opts.onProgress?.("init", 0, 1);
  const kfs = selectKeyframes(table);
  const initPair = findInitPair(state, kfs, opts.optimizeFocal);
  if (!initPair) {
    // 視差なし → 回転のみフォールバック
    return solveRotationOnly(table, opts);
  }
  state.focal = initPair.focal;
  opts.onProgress?.("init", 1, 1);

  // マップ初期化（world = kfA カメラ座標）
  const identity: CamPose = {
    R: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    t: [0, 0, 0],
  };
  state.kfPose.set(initPair.kfA, identity);
  state.kfPose.set(initPair.kfB, initPair.init.pose);
  for (const p of initPair.init.points) {
    const trackIdx = initPair.trackIdxs[p.pairIdx];
    if (trackIdx === undefined) continue;
    state.pointByTrack.set(trackIdx, p.X);
  }

  // 逐次拡張
  let sinceBa = 0;
  let progressCount = 2;
  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    for (const f of kfs) {
      if (state.kfPose.has(f)) continue;
      const corrs = collect2d3d(state, f);
      if (corrs.length < MIN_PNP_CORRS) continue;
      // 最寄りの solved KF を初期値に
      let nearest: CamPose | undefined;
      let bestDist = Infinity;
      for (const [kf, pose] of state.kfPose) {
        const d = Math.abs(kf - f);
        if (d < bestDist) {
          bestDist = d;
          nearest = pose;
        }
      }
      const res = pnpRansac(corrs, state.focal, state.cx, state.cy, state.rng, {
        iterations: 120,
        threshPx: 3,
        initialPose: nearest,
      });
      if (!res || res.inlierIdx.length < MIN_PNP_CORRS) continue;
      state.kfPose.set(f, res.pose);
      triangulateNewPoints(state, f);
      madeProgress = true;
      progressCount++;
      opts.onProgress?.("map", progressCount, kfs.length);
      sinceBa++;
      if (sinceBa >= BA_EVERY_N_KFS) {
        runGlobalBa(state, initPair.kfA, opts.optimizeFocal, 15);
        sinceBa = 0;
      }
    }
  }

  if (state.kfPose.size < 3 || state.pointByTrack.size < 20) {
    return solveRotationOnly(table, opts);
  }

  // 最終 BA（外れ値除去 → 再 BA）
  opts.onProgress?.("ba", 0, 2);
  runGlobalBa(state, initPair.kfA, opts.optimizeFocal, 30);
  opts.onProgress?.("ba", 1, 2);
  const finalBa = runGlobalBa(state, initPair.kfA, opts.optimizeFocal, 20);
  opts.onProgress?.("ba", 2, 2);

  // 全フレーム局所化 + 補間
  const { poses, stats } = localizeAllFrames(state, opts.onProgress);
  const fill = fillUnsolved(poses);
  if (!fill) {
    return {
      mode: "failed",
      frames: [],
      focalPx: state.focal,
      keyframes: kfs,
      pointCount: state.pointByTrack.size,
      medianReprojErrPx: finalBa.medianErrPx,
      message: "フレーム局所化に失敗しました",
    };
  }

  // frame0 基準へ再アンカー: R'_i = R_i R_0ᵀ, C'_i = R_0 (C_i - C_0)
  const p0 = fill.filled[0]!;
  const R0 = p0.R;
  const C0 = cameraCenter(p0);
  const R0t = m3Transpose(R0);
  const frames: SfmFramePose[] = [];
  for (let i = 0; i < n; i++) {
    const p = fill.filled[i]!;
    const Rp = m3Mul(p.R, R0t);
    const Cp = m3MulVec(R0, v3Sub(cameraCenter(p), C0));
    frames.push({
      solved: fill.solvedMask[i]!,
      q: m3ToQuat(Rp),
      c: Cp,
      reprojErrPx: stats[i]!.err,
      numPoints: stats[i]!.n,
    });
  }

  const solvedErrs = frames.filter((f) => f.solved && Number.isFinite(f.reprojErrPx)).map((f) => f.reprojErrPx);
  return {
    mode: "sfm",
    frames,
    focalPx: state.focal,
    keyframes: kfs,
    pointCount: state.pointByTrack.size,
    medianReprojErrPx: median(solvedErrs),
  };
}
