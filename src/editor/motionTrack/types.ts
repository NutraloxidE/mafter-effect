import type { Frame, Vec3 } from "../../core/schema";
import type { TrackMaskSpec, TrackRoi } from "./trackRoi";

export type { TrackMaskSpec, TrackRoi } from "./trackRoi";

export type TrackMode = "position" | "rotation" | "both" | "walk";

/** [qx, qy, qz, qw] — rotation-only 推定器の出力。 */
export type RawQuaternion = [number, number, number, number];

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
  /** @deprecated mask を使う。単一 include の後方互換。 */
  roi?: TrackRoi;
  /** 追跡マスク（include/exclude）。未指定 = 全体。 */
  mask?: TrackMaskSpec;
  /** 逆光向けコントラスト伸長（既定 true）。 */
  enhanceContrast?: boolean;
  /** 並進を comp 寸法の一定割合へ自動正規化（既定 true）。 */
  autoScale?: boolean;
  /** autoScale 時の目標 range（px）。未指定は height * 0.15。 */
  autoScaleTargetPx?: number;
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

export interface RawRotationPose {
  frame: Frame;
  rotation: RawQuaternion | null;
  inlierRatio: number;
  residual: number;
  processMs: number;
}

export interface RotationTrackResult {
  poses: RawRotationPose[];
  smoothed: RawQuaternion[];
}

export interface RotationTrackOptions extends TrackOptions {
  /** ピンホール焦点距離（px）。fx = fy = focalLength。 */
  focalLength: number;
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

export interface ApplyRotationTrackParams {
  baselineRotation: Vec3;
  rotationsByFrame: Map<Frame, Vec3>;
  bakeStart: Frame;
  bakeEnd: Frame;
  clearExpression: boolean;
}

export interface RotationTrackWorkerInit {
  type: "init";
  opencvUrl: string;
}

export type TrackEstimateMode = "rotation" | "walk";

export interface RotationTrackWorkerFrame {
  type: "frame";
  idx: number;
  data: ArrayBuffer;
  w: number;
  h: number;
  focalLength: number;
  reset: boolean;
  /** @deprecated mask を使う。 */
  roi?: TrackRoi;
  /** 追跡マスク。縁マージン棄却用。 */
  mask?: TrackMaskSpec;
  /** rotation = その場回転のみ / walk = essential R+t */
  estimateMode?: TrackEstimateMode;
}

export interface RotationTrackWorkerDispose {
  type: "dispose";
}

export type RotationTrackWorkerRequest =
  | RotationTrackWorkerInit
  | RotationTrackWorkerFrame
  | RotationTrackWorkerDispose;

export interface RotationTrackWorkerReady {
  type: "ready";
  initMs: number;
}

export interface RotationTrackWorkerRotation {
  type: "rotation";
  idx: number;
  rotation: RawQuaternion | null;
  inlierRatio: number;
  residual: number;
  processMs: number;
  error?: string;
  /** walk モード: カメラ運動方向（単位） */
  translation?: RawTranslation | null;
  /** walk モード: 対応点 median flow (px) */
  medianFlow?: number;
}

export interface RotationTrackWorkerError {
  type: "error";
  message: string;
}

export type RotationTrackWorkerResponse =
  | RotationTrackWorkerReady
  | RotationTrackWorkerRotation
  | RotationTrackWorkerError;
