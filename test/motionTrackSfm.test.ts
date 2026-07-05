import { describe, expect, it } from "vitest";
import {
  so3Exp,
  so3Log,
  m3Mul,
  m3MulVec,
  m3Transpose,
  m3ToQuat,
  quatToM3,
  cameraCenter,
  poseFromCenter,
  projectPoint,
  solveSymmetric,
  type CamPose,
  type M3,
  type V3,
  SfmRng,
} from "../src/editor/motionTrack/sfm/sfmCore";
import { buildTrackTable, selectKeyframes, type FramePoints } from "../src/editor/motionTrack/sfm/sfmTracks";
import { estimateTwoViewInit, type PxPair } from "../src/editor/motionTrack/sfm/sfmTwoView";
import { pnpRansac, refinePoseLm, type Correspondence2d3d } from "../src/editor/motionTrack/sfm/sfmPnp";
import { bundleAdjust, type BaCamera, type BaObservation } from "../src/editor/motionTrack/sfm/sfmBa";
import { solveSfm } from "../src/editor/motionTrack/sfm/sfmSolver";
import {
  sfmFramesToMafterTrajectory,
  solvedFocalToCameraZoom,
  summarizeSolveHalfStats,
} from "../src/editor/motionTrack/sfm/sfmConvert";
import { rotationEuler, type Mat4 } from "../src/runtime/mat4";

// ---------------------------------------------------------------------------
// 合成シーンヘルパ
// ---------------------------------------------------------------------------

const W = 640;
const H = 360;
const CX = W / 2;
const CY = H / 2;
const GT_FOCAL = 550;

/** seeded gaussian（Box-Muller） */
function makeGaussian(rng: SfmRng): () => number {
  return () => {
    const u1 = Math.max(1e-12, rng.next());
    const u2 = rng.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
}

function eulerZyxToM3(rx: number, ry: number, rz: number): M3 {
  const Rz = so3Exp([0, 0, rz]);
  const Ry = so3Exp([0, ry, 0]);
  const Rx = so3Exp([rx, 0, 0]);
  return m3Mul(m3Mul(Rz, Ry), Rx);
}

interface SyntheticScene {
  posesGt: CamPose[];
  centersGt: V3[];
  framePoints: FramePoints[];
}

/**
 * 既知トラジェクトリ + ランダム 3D 点 → 観測（ノイズ・トラック寿命つき）。
 * kind: "walk" = 前進 + 揺れ + パン（Comp 27 型）、"pan" = 横ドリー、"rotationOnly" = その場パン。
 */
function makeScene(
  kind: "walk" | "lateral" | "rotationOnly",
  nFrames: number,
  noisePx: number,
  seed = 42,
): SyntheticScene {
  const rng = new SfmRng(seed);
  const gauss = makeGaussian(rng);

  // 3D 点: カメラ前方の箱
  const nPoints = 400;
  const points: V3[] = [];
  for (let i = 0; i < nPoints; i++) {
    points.push([
      (rng.next() - 0.5) * 24,
      (rng.next() - 0.5) * 14,
      8 + rng.next() * 32,
    ]);
  }
  // トラック寿命
  const trackStart: number[] = [];
  const trackEnd: number[] = [];
  for (let i = 0; i < nPoints; i++) {
    const start = Math.floor(rng.next() * nFrames * 0.7);
    const len = 25 + Math.floor(rng.next() * nFrames);
    trackStart.push(start);
    trackEnd.push(Math.min(nFrames, start + len));
  }
  // 序盤から見える点を確保
  for (let i = 0; i < 150; i++) {
    trackStart[i] = 0;
    trackEnd[i] = Math.max(trackEnd[i]!, Math.floor(nFrames * 0.5));
  }

  const posesGt: CamPose[] = [];
  const centersGt: V3[] = [];
  for (let f = 0; f < nFrames; f++) {
    let C: V3;
    let R: M3;
    if (kind === "walk") {
      C = [0.35 * Math.sin(f * 0.21), 0.06 * Math.sin(f * 0.37), 0.05 * f];
      R = eulerZyxToM3(0.02 * Math.sin(f * 0.15), 0.1 * Math.sin(f * 0.07), 0.01 * Math.sin(f * 0.3));
    } else if (kind === "lateral") {
      C = [0.06 * f, 0.02 * Math.sin(f * 0.3), 0];
      R = eulerZyxToM3(0, 0.002 * f, 0);
    } else {
      C = [0, 0, 0];
      R = eulerZyxToM3(0, 0.008 * f, 0);
    }
    // R は camera→world の姿勢として作ったので world→cam へ転置
    const pose = poseFromCenter(m3Transpose(R), C);
    posesGt.push(pose);
    centersGt.push(C);
  }

  const framePoints: FramePoints[] = [];
  for (let f = 0; f < nFrames; f++) {
    const pose = posesGt[f]!;
    const pts: FramePoints["points"] = [];
    for (let i = 0; i < nPoints; i++) {
      if (f < trackStart[i]! || f >= trackEnd[i]!) continue;
      const pr = projectPoint(pose, GT_FOCAL, CX, CY, points[i]!);
      if (!pr) continue;
      const u = pr.u + gauss() * noisePx;
      const v = pr.v + gauss() * noisePx;
      if (u < 2 || v < 2 || u > W - 2 || v > H - 2) continue;
      pts.push({ id: i, x: u, y: v });
    }
    framePoints.push({ points: pts });
  }
  return { posesGt, centersGt, framePoints };
}

/** frame0 基準に再アンカーした GT 中心（solver 出力と同一座標系）。 */
function gtCentersAnchored(scene: SyntheticScene): V3[] {
  const R0 = scene.posesGt[0]!.R;
  const C0 = scene.centersGt[0]!;
  return scene.centersGt.map((C) => m3MulVec(R0, [C[0] - C0[0], C[1] - C0[1], C[2] - C0[2]]));
}

function gtRotationsAnchored(scene: SyntheticScene): M3[] {
  const R0t = m3Transpose(scene.posesGt[0]!.R);
  return scene.posesGt.map((p) => m3Mul(p.R, R0t));
}

function rotationAngleDeg(A: M3, B: M3): number {
  const D = m3Mul(A, m3Transpose(B));
  const tr = Math.min(3, Math.max(-1, D[0][0] + D[1][1] + D[2][2]));
  return (Math.acos((tr - 1) / 2) * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// コア数学
// ---------------------------------------------------------------------------

describe("sfmCore", () => {
  it("so3 exp/log round-trips", () => {
    const w: V3 = [0.3, -0.5, 0.9];
    const back = so3Log(so3Exp(w));
    expect(back[0]).toBeCloseTo(w[0], 8);
    expect(back[1]).toBeCloseTo(w[1], 8);
    expect(back[2]).toBeCloseTo(w[2], 8);
  });

  it("quaternion/matrix round-trips", () => {
    const R = so3Exp([0.2, 0.7, -0.4]);
    const R2 = quatToM3(m3ToQuat(R));
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) expect(R2[r]![c]!).toBeCloseTo(R[r]![c]!, 8);
  });

  it("solveSymmetric solves SPD system", () => {
    // A = Mᵀ M + I（SPD 保証）
    const n = 5;
    const rng = new SfmRng(7);
    const M = new Float64Array(n * n).map(() => rng.next() * 2 - 1);
    const A = new Float64Array(n * n);
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        let s = r === c ? 1 : 0;
        for (let k = 0; k < n; k++) s += M[k * n + r]! * M[k * n + c]!;
        A[r * n + c] = s;
      }
    const xTrue = new Float64Array([1, -2, 3, 0.5, -0.25]);
    const b = new Float64Array(n);
    for (let r = 0; r < n; r++) {
      let s = 0;
      for (let c = 0; c < n; c++) s += A[r * n + c]! * xTrue[c]!;
      b[r] = s;
    }
    const x = solveSymmetric(A, b, n);
    expect(x).not.toBeNull();
    for (let i = 0; i < n; i++) expect(x![i]!).toBeCloseTo(xTrue[i]!, 6);
  });
});

// ---------------------------------------------------------------------------
// 2 視点初期化
// ---------------------------------------------------------------------------

describe("sfmTwoView", () => {
  it("recovers relative pose direction with noise and outliers", () => {
    const scene = makeScene("lateral", 40, 0.3, 11);
    const f0 = 0;
    const f1 = 30;
    const rng = new SfmRng(3);
    const p0 = new Map(scene.framePoints[f0]!.points.map((p) => [p.id, p]));
    const pairs: PxPair[] = [];
    for (const p of scene.framePoints[f1]!.points) {
      const a = p0.get(p.id);
      if (!a) continue;
      pairs.push({ x0: a.x, y0: a.y, x1: p.x, y1: p.y });
    }
    // 20% 外れ値を注入
    const nOut = Math.floor(pairs.length * 0.2);
    for (let i = 0; i < nOut; i++) {
      pairs[i] = { ...pairs[i]!, x1: rng.next() * W, y1: rng.next() * H };
    }
    const init = estimateTwoViewInit(pairs, GT_FOCAL, CX, CY, rng);
    expect(init).not.toBeNull();
    // GT: cam0→cam1 相対。t 方向 = -R1 · (C1 - C0)（world≈cam0）を正規化
    const C1 = scene.centersGt[f1]!;
    const R1 = scene.posesGt[f1]!.R;
    const tGt = m3MulVec(R1, [-C1[0], -C1[1], -C1[2]]);
    const norm = Math.hypot(tGt[0], tGt[1], tGt[2]);
    const tGtN = [tGt[0] / norm, tGt[1] / norm, tGt[2] / norm];
    const t = init!.pose.t;
    const cos = Math.abs(t[0] * tGtN[0]! + t[1] * tGtN[1]! + t[2] * tGtN[2]!);
    expect(cos).toBeGreaterThan(0.98);
  });
});

// ---------------------------------------------------------------------------
// PnP
// ---------------------------------------------------------------------------

describe("sfmPnp", () => {
  it("pnpRansac recovers pose under 30% outliers", () => {
    const rng = new SfmRng(5);
    const gauss = makeGaussian(rng);
    const Rgt = so3Exp([0.1, -0.25, 0.05]);
    const pose: CamPose = { R: Rgt, t: [0.4, -0.2, 1.5] };
    const corrs: Correspondence2d3d[] = [];
    for (let i = 0; i < 120; i++) {
      const X: V3 = [(rng.next() - 0.5) * 16, (rng.next() - 0.5) * 10, 6 + rng.next() * 20];
      const pr = projectPoint(pose, GT_FOCAL, CX, CY, X);
      if (!pr) continue;
      const outlier = i % 10 < 3;
      corrs.push({
        X,
        u: outlier ? rng.next() * W : pr.u + gauss() * 0.3,
        v: outlier ? rng.next() * H : pr.v + gauss() * 0.3,
      });
    }
    const res = pnpRansac(corrs, GT_FOCAL, CX, CY, rng);
    expect(res).not.toBeNull();
    expect(rotationAngleDeg(res!.pose.R, Rgt)).toBeLessThan(0.5);
    const Cgt = cameraCenter(pose);
    const Cest = cameraCenter(res!.pose);
    expect(Math.hypot(Cest[0] - Cgt[0], Cest[1] - Cgt[1], Cest[2] - Cgt[2])).toBeLessThan(0.1);
  });

  it("refinePoseLm converges from perturbed pose", () => {
    const rng = new SfmRng(9);
    const Rgt = so3Exp([-0.15, 0.3, 0.1]);
    const pose: CamPose = { R: Rgt, t: [0.2, 0.1, 2] };
    const corrs: Correspondence2d3d[] = [];
    for (let i = 0; i < 60; i++) {
      const X: V3 = [(rng.next() - 0.5) * 16, (rng.next() - 0.5) * 10, 6 + rng.next() * 20];
      const pr = projectPoint(pose, GT_FOCAL, CX, CY, X);
      if (pr) corrs.push({ X, u: pr.u, v: pr.v });
    }
    const perturbed: CamPose = {
      R: m3Mul(so3Exp([0.03, -0.02, 0.01]), Rgt),
      t: [0.25, 0.05, 2.1],
    };
    const refined = refinePoseLm(perturbed, corrs, GT_FOCAL, CX, CY, { iterations: 20 });
    expect(rotationAngleDeg(refined.R, Rgt)).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// バンドル調整
// ---------------------------------------------------------------------------

describe("sfmBa", () => {
  it("reduces reprojection error from perturbed poses/points and recovers focal", () => {
    const rng = new SfmRng(13);
    const gauss = makeGaussian(rng);
    const nCams = 8;
    const nPts = 120;
    const gtPoints: V3[] = [];
    for (let i = 0; i < nPts; i++) {
      gtPoints.push([(rng.next() - 0.5) * 20, (rng.next() - 0.5) * 12, 8 + rng.next() * 25]);
    }
    const gtPoses: CamPose[] = [];
    for (let k = 0; k < nCams; k++) {
      const C: V3 = [0.4 * k, 0.05 * Math.sin(k), 0.1 * k];
      const R = m3Transpose(eulerZyxToM3(0, 0.03 * k, 0));
      gtPoses.push(poseFromCenter(R, C));
    }
    const obs: BaObservation[] = [];
    for (let k = 0; k < nCams; k++) {
      for (let j = 0; j < nPts; j++) {
        const pr = projectPoint(gtPoses[k]!, GT_FOCAL, CX, CY, gtPoints[j]!);
        if (!pr) continue;
        obs.push({ cam: k, pt: j, u: pr.u + gauss() * 0.25, v: pr.v + gauss() * 0.25 });
      }
    }
    // 摂動: カメラ・点・焦点距離
    const cameras: BaCamera[] = gtPoses.map((p, k) => ({
      r: so3Log(k === 0 ? p.R : m3Mul(so3Exp([gauss() * 0.02, gauss() * 0.02, gauss() * 0.02]), p.R)),
      t: k === 0 ? [...p.t] : [p.t[0] + gauss() * 0.08, p.t[1] + gauss() * 0.08, p.t[2] + gauss() * 0.08],
      fixed: k === 0,
    }));
    const points: V3[] = gtPoints.map((X) => [
      X[0] + gauss() * 0.3,
      X[1] + gauss() * 0.3,
      X[2] + gauss() * 0.3,
    ]);
    const res = bundleAdjust(cameras, points, obs, {
      focal: GT_FOCAL * 1.15,
      cx: CX,
      cy: CY,
      optimizeFocal: true,
      maxIterations: 40,
    });
    expect(res.medianErrPx).toBeLessThan(0.5);
    expect(res.medianErrPx).toBeLessThan(res.initialMedianErrPx);
    expect(Math.abs(res.focal - GT_FOCAL) / GT_FOCAL).toBeLessThan(0.02);
  });
});

// ---------------------------------------------------------------------------
// フルパイプライン（AE 級精度の受け入れ基準）
// ---------------------------------------------------------------------------

describe("solveSfm full pipeline", () => {
  it("walk clip (forward + sway + pan): trajectory/rotation/focal within AE-grade tolerance", () => {
    const scene = makeScene("walk", 90, 0.3, 42);
    const table = buildTrackTable(scene.framePoints);
    const result = solveSfm(table, {
      width: W,
      height: H,
      focalPx: 800, // わざと 45% ずれた初期値
      optimizeFocal: true,
      seed: 1,
    });
    expect(result.mode).toBe("sfm");
    expect(Math.abs(result.focalPx - GT_FOCAL) / GT_FOCAL).toBeLessThan(0.05);

    const gtC = gtCentersAnchored(scene);
    const estC = result.frames.map((f) => f.c);
    // スケールのみ整合（座標系は両方 frame0 cam）
    let num = 0;
    let den = 0;
    for (let i = 0; i < gtC.length; i++) {
      num += estC[i]![0] * gtC[i]![0] + estC[i]![1] * gtC[i]![1] + estC[i]![2] * gtC[i]![2];
      den += estC[i]![0] ** 2 + estC[i]![1] ** 2 + estC[i]![2] ** 2;
    }
    const s = den > 0 ? num / den : 1;
    expect(s).toBeGreaterThan(0);

    let extent = 0;
    for (const c of gtC) extent = Math.max(extent, Math.hypot(c[0], c[1], c[2]));
    const posErrs = gtC.map((c, i) =>
      Math.hypot(s * estC[i]![0] - c[0], s * estC[i]![1] - c[1], s * estC[i]![2] - c[2]),
    );
    const rmse = Math.sqrt(posErrs.reduce((a, e) => a + e * e, 0) / posErrs.length);
    expect(rmse / extent).toBeLessThan(0.01); // 軌道全長の 1% 未満
    expect(Math.max(...posErrs) / extent).toBeLessThan(0.03);

    const gtR = gtRotationsAnchored(scene);
    const rotErrs = result.frames.map((f, i) => rotationAngleDeg(quatToM3(f.q), gtR[i]!));
    const medRot = [...rotErrs].sort((a, b) => a - b)[Math.floor(rotErrs.length / 2)]!;
    expect(medRot).toBeLessThan(0.2);
    expect(Math.max(...rotErrs)).toBeLessThan(1);
  }, 60000);

  it("lateral dolly clip solves with sub-percent trajectory error", () => {
    const scene = makeScene("lateral", 60, 0.3, 77);
    const table = buildTrackTable(scene.framePoints);
    const result = solveSfm(table, {
      width: W,
      height: H,
      focalPx: GT_FOCAL,
      optimizeFocal: false,
      seed: 2,
    });
    expect(result.mode).toBe("sfm");
    const gtC = gtCentersAnchored(scene);
    const estC = result.frames.map((f) => f.c);
    let num = 0;
    let den = 0;
    for (let i = 0; i < gtC.length; i++) {
      num += estC[i]![0] * gtC[i]![0] + estC[i]![1] * gtC[i]![1] + estC[i]![2] * gtC[i]![2];
      den += estC[i]![0] ** 2 + estC[i]![1] ** 2 + estC[i]![2] ** 2;
    }
    const s = den > 0 ? num / den : 1;
    let extent = 0;
    for (const c of gtC) extent = Math.max(extent, Math.hypot(c[0], c[1], c[2]));
    const posErrs = gtC.map((c, i) =>
      Math.hypot(s * estC[i]![0] - c[0], s * estC[i]![1] - c[1], s * estC[i]![2] - c[2]),
    );
    const rmse = Math.sqrt(posErrs.reduce((a, e) => a + e * e, 0) / posErrs.length);
    expect(rmse / extent).toBeLessThan(0.01);
  }, 60000);

  it("pure rotation clip falls back to rotationOnly with accurate yaw", () => {
    const scene = makeScene("rotationOnly", 50, 0.2, 21);
    const table = buildTrackTable(scene.framePoints);
    const result = solveSfm(table, {
      width: W,
      height: H,
      focalPx: GT_FOCAL,
      optimizeFocal: false,
      seed: 3,
    });
    expect(result.mode).toBe("rotationOnly");
    const gtR = gtRotationsAnchored(scene);
    const last = result.frames.length - 1;
    const err = rotationAngleDeg(quatToM3(result.frames[last]!.q), gtR[last]!);
    // 最終フレーム累積ヨー ~22° に対して誤差 < 0.5°
    expect(err).toBeLessThan(0.5);
  }, 30000);

  it("selectKeyframes picks bounded, ordered keyframes", () => {
    const scene = makeScene("walk", 90, 0.3, 4);
    const table = buildTrackTable(scene.framePoints);
    const kfs = selectKeyframes(table);
    expect(kfs[0]).toBe(0);
    expect(kfs[kfs.length - 1]).toBe(89);
    for (let i = 1; i < kfs.length; i++) expect(kfs[i]!).toBeGreaterThan(kfs[i - 1]!);
  });
});

// ---------------------------------------------------------------------------
// Mafter 変換
// ---------------------------------------------------------------------------

describe("sfmConvert", () => {
  it("camera center maps with Z flip only", () => {
    const traj = sfmFramesToMafterTrajectory(
      [
        { solved: true, q: [0, 0, 0, 1], c: [0, 0, 0], reprojErrPx: 0, numPoints: 0 },
        { solved: true, q: [0, 0, 0, 1], c: [1, 2, 3], reprojErrPx: 0, numPoints: 0 },
      ],
      { x: 100, y: 200, z: 50 },
      { x: 0, y: 0, z: 0 },
      1,
    );
    expect(traj.positions[1]).toEqual({ x: 101, y: 202, z: 47 });
  });

  it("rotation conversion matches Mafter rotationEuler axis behavior", () => {
    // SLAM でカメラを y（下向き）まわりに +30° 回した姿勢 R_wc
    const yaw = (30 * Math.PI) / 180;
    const Rwc = so3Exp([0, yaw, 0]);
    const Rworld2cam = m3Transpose(Rwc);
    const q = m3ToQuat(Rworld2cam);
    const traj = sfmFramesToMafterTrajectory(
      [{ solved: true, q, c: [0, 0, 0], reprojErrPx: 0, numPoints: 0 }],
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      1,
    );
    const e = traj.rotations[0]!;
    // Mafter rotationEuler（column-major Mat4）でカメラ前方 (0,0,-1) を回す
    const M: Mat4 = rotationEuler(e);
    const fx = -M[8]!;
    const fy = -M[9]!;
    const fz = -M[10]!;
    // SLAM 前方 = R_wc の第3列 = [sin(yaw), 0, cos(yaw)] → Mafter では z 反転
    const expected = [Math.sin(yaw), 0, -Math.cos(yaw)];
    expect(fx).toBeCloseTo(expected[0]!, 6);
    expect(fy).toBeCloseTo(expected[1]!, 6);
    expect(fz).toBeCloseTo(expected[2]!, 6);
  });

  it("solvedFocalToCameraZoom scales by height ratio", () => {
    expect(solvedFocalToCameraZoom(550, 360, 1080)).toBeCloseTo(1650, 6);
    expect(solvedFocalToCameraZoom(0, 360, 1080)).toBe(0);
  });

  it("summarizeSolveHalfStats reports early vs late median point counts", () => {
    const frames = [
      { numPoints: 40 },
      { numPoints: 38 },
      { numPoints: 36 },
      { numPoints: 10 },
      { numPoints: 8 },
      { numPoints: 6 },
    ];
    const s = summarizeSolveHalfStats(frames);
    expect(s).not.toBeNull();
    expect(s!.earlyFrameCount).toBe(3);
    expect(s!.lateFrameCount).toBe(3);
    expect(s!.earlyMedianPoints).toBe(38);
    expect(s!.lateMedianPoints).toBe(8);
  });
});

describe("buildTrackTable late rediscovery", () => {
  it("includes tracks that only appear in the second half", () => {
    const frames: FramePoints[] = [];
    for (let f = 0; f < 10; f++) {
      const points: FramePoints["points"] = [];
      // early-only track
      if (f < 4) points.push({ id: 1, x: 10 + f, y: 20 });
      // late-only track (rediscovered mid-clip)
      if (f >= 5) points.push({ id: 99, x: 100 + f, y: 50 });
      // bridge track across whole clip
      points.push({ id: 2, x: 30 + f, y: 40 });
      frames.push({ points });
    }
    const table = buildTrackTable(frames);
    const ids = table.tracks.map((t) => t.id);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(99);
    const late = table.tracks.find((t) => t.id === 99)!;
    expect(late.obs[0]!.frame).toBe(5);
    expect(late.obs.length).toBe(5);
    // late frames still have observations from new ids
    expect(table.frameIndex[8]!.some((e) => table.tracks[e.trackIdx]!.id === 99)).toBe(true);
  });
});
