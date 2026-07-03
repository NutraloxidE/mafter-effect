import type { Vec3 } from "../../core/schema";
import {
  composeBaselineRotation,
  slamTranslationToMafterDelta,
} from "./coordConvert";
import {
  identityQuaternion,
  quaternionMultiply,
  quaternionNormalize,
  type Mat3,
} from "./rotationEstimator";
import type { RawQuaternion, RawTranslation } from "./types";

function quatToMat3(q: RawQuaternion): Mat3 {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

export interface WalkRelative {
  /** フレーム間相対回転（SLAM / OpenCV 規約） */
  rotation: RawQuaternion;
  /** カメラ運動方向（単位、cam0 系） */
  motion: RawTranslation;
  /** このステップの並進スケール（px 相当） */
  scale: number;
}

/**
 * 相対ポーズ列を累積し、Mafter の絶対 position / rotation を返す。
 * baseline は frame0 の値。
 */
export function accumulateWalkTrajectory(
  relatives: Array<WalkRelative | null>,
  baselinePosition: Vec3,
  baselineRotation: Vec3,
  userScale: number,
): { positions: Vec3[]; rotations: Vec3[]; validMask: boolean[] } {
  const n = relatives.length;
  const positions: Vec3[] = new Array(n);
  const rotations: Vec3[] = new Array(n);
  const validMask: boolean[] = new Array(n);

  let cumQ: RawQuaternion = identityQuaternion();
  let slamPos: RawTranslation = [0, 0, 0];
  let worldR: Mat3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  positions[0] = { ...baselinePosition };
  rotations[0] = { ...baselineRotation };
  validMask[0] = true;

  for (let i = 1; i < n; i++) {
    const rel = relatives[i];
    if (!rel) {
      positions[i] = { ...positions[i - 1]! };
      rotations[i] = { ...rotations[i - 1]! };
      validMask[i] = false;
      continue;
    }
    validMask[i] = true;
    cumQ = quaternionNormalize(quaternionMultiply(cumQ, rel.rotation));
    // カメラ中心移動をワールド（累積回転）で積分
    const m = rel.motion;
    const s = rel.scale * userScale;
    const dx = worldR[0]![0]! * m[0] * s + worldR[0]![1]! * m[1] * s + worldR[0]![2]! * m[2] * s;
    const dy = worldR[1]![0]! * m[0] * s + worldR[1]![1]! * m[1] * s + worldR[1]![2]! * m[2] * s;
    const dz = worldR[2]![0]! * m[0] * s + worldR[2]![1]! * m[1] * s + worldR[2]![2]! * m[2] * s;
    slamPos = [slamPos[0] + dx, slamPos[1] + dy, slamPos[2] + dz];
    worldR = quatToMat3(cumQ);

    const delta = slamTranslationToMafterDelta(slamPos[0], slamPos[1], slamPos[2], 1);
    positions[i] = {
      x: baselinePosition.x + delta.x,
      y: baselinePosition.y + delta.y,
      z: baselinePosition.z + delta.z,
    };
    rotations[i] = composeBaselineRotation(baselineRotation, cumQ);
  }

  return { positions, rotations, validMask };
}
