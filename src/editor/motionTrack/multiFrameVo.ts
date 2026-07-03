import { estimateWalkStepFromFlow } from "./flowWalk";
import type { PixelPair } from "./essentialPose";
import {
  acceptPnpRelative,
  composeRelativeStep,
  emaFilterStep,
  identityInternalPose,
  internalPoseFromRt,
  relativeFromPoses,
  type InternalPose,
} from "./poseGate";
import { depthInCamera, triangulateLinear, type Vec3Tuple } from "./triangulate";
import { solvePnPWithPrior, type ISolvePnP } from "./pnp";
import type { WalkRelative } from "./walkAccumulate";

function makeProjection(R: number[][], t: number[]): number[][] {
  return [
    [R[0]![0]!, R[0]![1]!, R[0]![2]!, t[0]!],
    [R[1]![0]!, R[1]![1]!, R[1]![2]!, t[1]!],
    [R[2]![0]!, R[2]![1]!, R[2]![2]!, t[2]!],
  ];
}

export interface FeatureTrack {
  id: number;
  points: Array<{ frameIdx: number; x: number; y: number }>;
  world?: Vec3Tuple;
  /** 三角測量時の再投影誤差 (px) */
  reprojErr?: number;
}

const KEYFRAME_GAP = 5;
const MIN_TRACK_LEN = 5;
const MIN_MAP_POINTS = 20;
const MIN_TRI_BATCHES = 2;
const MAX_REPROJ_PX = 2;

export interface MultiFrameStepResult {
  step: WalkRelative;
  pnpAccepted: boolean;
  mapPoints: number;
  reprojErrPx: number;
  newIds: number[];
}

/**
 * AE Track+Solve ミニ版。
 * 出力は常に相対ステップのみ。絶対ポーズは内部 prevPose のみ。
 */
export class MultiFrameVoState {
  tracks = new Map<number, FeatureTrack>();
  private nextId = 1;
  private lastKeyframe = 0;
  private triBatches = 0;
  private prevPose: InternalPose = identityInternalPose();
  private prevStep: WalkRelative | null = null;
  private poseAtFrame = new Map<number, InternalPose>();
  private solvePnP: ISolvePnP = solvePnPWithPrior;

  reset(): void {
    this.tracks.clear();
    this.nextId = 1;
    this.lastKeyframe = 0;
    this.triBatches = 0;
    this.prevPose = identityInternalPose();
    this.prevStep = null;
    this.poseAtFrame.clear();
    this.poseAtFrame.set(0, identityInternalPose());
  }

  setSolvePnP(fn: ISolvePnP): void {
    this.solvePnP = fn;
  }

  seedFrame0(points: Array<{ x: number; y: number }>): number[] {
    this.reset();
    const ids: number[] = [];
    for (const p of points) {
      const id = this.nextId++;
      ids.push(id);
      this.tracks.set(id, { id, points: [{ frameIdx: 0, x: p.x, y: p.y }] });
    }
    return ids;
  }

  mapPointCount(): number {
    let n = 0;
    for (const t of this.tracks.values()) if (t.world) n++;
    return n;
  }

  medianMapReprojErr(): number {
    const errs: number[] = [];
    for (const t of this.tracks.values()) {
      if (t.world && t.reprojErr !== undefined) errs.push(t.reprojErr);
    }
    if (errs.length === 0) return Infinity;
    errs.sort((a, b) => a - b);
    return errs[Math.floor(errs.length / 2)]!;
  }

  private mapReady(): boolean {
    if (this.mapPointCount() < MIN_MAP_POINTS) return false;
    if (this.triBatches < MIN_TRI_BATCHES) return false;
    if (this.medianMapReprojErr() > MAX_REPROJ_PX) return false;
    return true;
  }

  processFrame(
    frameIdx: number,
    pairs: Array<{ id: number; x0: number; y0: number; x1: number; y1: number }>,
    newPoints: Array<{ x: number; y: number }>,
    width: number,
    height: number,
    focalLength: number,
  ): MultiFrameStepResult {
    for (const p of pairs) {
      let tr = this.tracks.get(p.id);
      if (!tr) {
        tr = { id: p.id, points: [{ frameIdx: frameIdx - 1, x: p.x0, y: p.y0 }] };
        this.tracks.set(p.id, tr);
      }
      tr.points.push({ frameIdx, x: p.x1, y: p.y1 });
    }
    const newIds: number[] = [];
    for (const p of newPoints) {
      const id = this.nextId++;
      newIds.push(id);
      this.tracks.set(id, { id, points: [{ frameIdx, x: p.x, y: p.y }] });
    }

    const pixelPairs: PixelPair[] = pairs.map((p) => ({
      x0: p.x0,
      y0: p.y0,
      x1: p.x1,
      y1: p.y1,
    }));

    const flow = estimateWalkStepFromFlow(pixelPairs, width, height, focalLength);
    const pred: WalkRelative = flow ?? {
      rotation: [0, 0, 0, 1],
      motion: [0, 0, 1],
      scale: 0.5,
    };

    let pnpAccepted = false;
    let chosen = pred;

    const fx = focalLength;
    const fy = focalLength;
    const cx = width / 2;
    const cy = height / 2;

    if (this.mapReady()) {
      const worldPts: Vec3Tuple[] = [];
      const norms: Array<{ x: number; y: number }> = [];
      for (const p of pairs) {
        const tr = this.tracks.get(p.id);
        if (!tr?.world) continue;
        if (tr.points.length < MIN_TRACK_LEN) continue;
        worldPts.push(tr.world);
        norms.push({ x: (p.x1 - cx) / fx, y: (p.y1 - cy) / fy });
      }
      if (worldPts.length >= MIN_MAP_POINTS) {
        const pnp = this.solvePnP(worldPts, norms, {
          R: this.prevPose.R,
          t: this.prevPose.t,
        });
        if (pnp) {
          const cur = internalPoseFromRt(pnp.R, pnp.t);
          const pnpRel = relativeFromPoses(this.prevPose, cur, pred.scale);
          const gated = acceptPnpRelative(pred, pnpRel);
          pnpAccepted = gated !== pred;
          chosen = gated;
        }
      }
    }

    const step = emaFilterStep(this.prevStep, chosen);
    this.prevStep = step;
    this.prevPose = composeRelativeStep(this.prevPose, step);
    this.poseAtFrame.set(frameIdx, this.prevPose);

    if (frameIdx - this.lastKeyframe >= KEYFRAME_GAP) {
      this.triangulateFromKeyframes(this.lastKeyframe, frameIdx, fx, fy, cx, cy);
      this.lastKeyframe = frameIdx;
    }

    return {
      step,
      pnpAccepted,
      mapPoints: this.mapPointCount(),
      reprojErrPx: this.medianMapReprojErr(),
      newIds,
    };
  }

  private triangulateFromKeyframes(
    i0: number,
    i1: number,
    fx: number,
    fy: number,
    cx: number,
    cy: number,
  ): void {
    const pose0 = this.poseAtFrame.get(i0);
    const pose1 = this.poseAtFrame.get(i1);
    if (!pose0 || !pose1) return;

    const P0 = makeProjection(pose0.R, pose0.t);
    const P1 = makeProjection(pose1.R, pose1.t);

    let added = 0;
    for (const tr of this.tracks.values()) {
      if (tr.world) continue;
      if (tr.points.length < MIN_TRACK_LEN) continue;
      const o0 = tr.points.find((p) => p.frameIdx === i0);
      const o1 = tr.points.find((p) => p.frameIdx === i1);
      if (!o0 || !o1) continue;

      const parallax = Math.hypot(o1.x - o0.x, o1.y - o0.y);
      if (parallax < 2) continue;

      const x0 = (o0.x - cx) / fx;
      const y0 = (o0.y - cy) / fy;
      const x1 = (o1.x - cx) / fx;
      const y1 = (o1.y - cy) / fy;

      const Xw = triangulateLinear(P0, P1, x0, y0, x1, y1);
      if (!Xw) continue;
      const z0 = depthInCamera(pose0.R, pose0.t, Xw);
      const z1 = depthInCamera(pose1.R, pose1.t, Xw);
      if (z0 <= 0.1 || z1 <= 0.1) continue;

      const u1 =
        (pose1.R[0]![0]! * Xw[0] + pose1.R[0]![1]! * Xw[1] + pose1.R[0]![2]! * Xw[2] + pose1.t[0]!) /
        z1;
      const v1 =
        (pose1.R[1]![0]! * Xw[0] + pose1.R[1]![1]! * Xw[1] + pose1.R[1]![2]! * Xw[2] + pose1.t[1]!) /
        z1;
      const err = Math.hypot(u1 * fx + cx - o1.x, v1 * fy + cy - o1.y);
      if (err > MAX_REPROJ_PX * 2) continue;

      tr.world = Xw;
      tr.reprojErr = err;
      added++;
    }
    if (added > 0) this.triBatches++;
  }
}
