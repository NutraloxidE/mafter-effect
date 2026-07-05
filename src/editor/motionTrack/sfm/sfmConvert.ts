/**
 * SfM グローバルポーズ（world = frame0 カメラ、+z 前方）→ Mafter position / rotation 系列。
 *
 * - position: カメラ中心 C（world）を Z 反転して baseline に加算（既存 coordConvert と同じ規約）
 * - rotation: カメラ姿勢 R_wc = R_i^T を C·R·C 共役で Mafter 化し baseline euler と合成
 */

import type { Vec3 } from "../../../core/schema";
import { composeBaselineRotation, slamTranslationToMafterDelta } from "../coordConvert";
import type { SfmFramePose } from "./sfmSolver";

export interface MafterTrajectory {
  positions: Vec3[];
  rotations: Vec3[];
  validMask: boolean[];
}

/**
 * SfM フレームポーズ列を Mafter の絶対 position / rotation 列へ変換。
 * userScale は単眼スケール補正（autoScale は呼び出し側で適用）。
 */
export function sfmFramesToMafterTrajectory(
  frames: SfmFramePose[],
  baselinePosition: Vec3,
  baselineRotation: Vec3,
  userScale: number,
): MafterTrajectory {
  const positions: Vec3[] = [];
  const rotations: Vec3[] = [];
  const validMask: boolean[] = [];
  for (const f of frames) {
    const delta = slamTranslationToMafterDelta(f.c[0], f.c[1], f.c[2], userScale);
    positions.push({
      x: baselinePosition.x + delta.x,
      y: baselinePosition.y + delta.y,
      z: baselinePosition.z + delta.z,
    });
    // 注意: coordConvert.mat3ToMat4 は row-major 詰め＝column-major Mat4 上では転置。
    // 既存の検証済み回転経路はこの転置を前提にしているため、姿勢（cam→world）ではなく
    // world→cam の q をそのまま渡すと合成後に正しいカメラ姿勢 euler になる。
    rotations.push(composeBaselineRotation(baselineRotation, [f.q[0], f.q[1], f.q[2], f.q[3]]));
    validMask.push(f.solved);
  }
  return { positions, rotations, validMask };
}

/**
 * 推定焦点距離（追跡解像度 px）→ Mafter カメラ zoom（px、comp 高さ基準）。
 * fov = 2·atan((h/2)/f) は解像度に対して不変なので高さ比で換算する。
 */
export function solvedFocalToCameraZoom(
  focalPx: number,
  trackHeight: number,
  compHeight: number,
): number {
  if (!(focalPx > 0) || !(trackHeight > 0) || !(compHeight > 0)) return 0;
  return (focalPx * compHeight) / trackHeight;
}

export interface SolveHalfStats {
  earlyMedianPoints: number;
  lateMedianPoints: number;
  earlyFrameCount: number;
  lateFrameCount: number;
}

/** 前半/後半の PnP 対応点数中央値（見切れ以降の地図薄さを診断）。 */
export function summarizeSolveHalfStats(
  frames: Array<{ numPoints: number }>,
): SolveHalfStats | null {
  if (frames.length < 2) return null;
  const mid = Math.floor(frames.length / 2);
  const medianOf = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };
  const early = frames.slice(0, mid);
  const late = frames.slice(mid);
  return {
    earlyMedianPoints: medianOf(early.map((f) => f.numPoints)),
    lateMedianPoints: medianOf(late.map((f) => f.numPoints)),
    earlyFrameCount: early.length,
    lateFrameCount: late.length,
  };
}
