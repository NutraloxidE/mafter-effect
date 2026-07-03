import type { Frame, Vec3 } from "../../core/schema";

/** QUAR TrackerHandle process_frame の translation（カメラ運動・+z 前方）。 */
export type RawTranslation = [number, number, number];

export interface RawPose {
  frame: Frame;
  /** comp 絶対フレーム */
  translation: RawTranslation | null;
  confidence: number;
  /** worker 内 process_frame 所要 ms */
  processMs: number;
}

export interface TrackOptions {
  userScale: number;
  sampleInterval: number;
  targetWidth?: number;
}

export interface TrackProgress {
  phase: "loading" | "extracting" | "tracking" | "baking";
  current: number;
  total: number;
}

export interface TrackResult {
  poses: RawPose[];
  smoothed: RawTranslation[];
}

export interface MotionTrackWorkerInit {
  type: "init";
  wasmUrl: string;
}

export interface MotionTrackWorkerFrame {
  type: "frame";
  idx: number;
  data: ArrayBuffer;
  w: number;
  h: number;
}

export interface MotionTrackWorkerDispose {
  type: "dispose";
}

export type MotionTrackWorkerRequest =
  | MotionTrackWorkerInit
  | MotionTrackWorkerFrame
  | MotionTrackWorkerDispose;

export interface MotionTrackWorkerReady {
  type: "ready";
  version?: string;
  initMs: number;
}

export interface MotionTrackWorkerPose {
  type: "pose";
  idx: number;
  translation: RawTranslation | null;
  confidence: number;
  processMs: number;
  error?: string;
}

export interface MotionTrackWorkerError {
  type: "error";
  message: string;
}

export type MotionTrackWorkerResponse =
  | MotionTrackWorkerReady
  | MotionTrackWorkerPose
  | MotionTrackWorkerError;

export interface ApplyMotionTrackParams {
  baselinePosition: Vec3;
  /** comp 絶対フレーム → 絶対 position（baseline + 相対変位済み） */
  positionsByFrame: Map<Frame, Vec3>;
  bakeStart: Frame;
  bakeEnd: Frame;
  clearExpression: boolean;
}
