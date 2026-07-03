import type { Vec3 } from "../../core/schema";
import { decomposeTrs, multiplyAll, rotationEuler, type Mat4 } from "../../runtime/mat4";
import type { RawQuaternion, RawTranslation } from "./types";
import type { Mat3 } from "./rotationEstimator";
import { quaternionMultiply, quaternionNormalize } from "./rotationEstimator";

/**
 * QUAR TrackerHandle translation → Mafter 相対変位。
 * 実測: +x 右 / +y 下 / +z シーン奥。Mafter は +z 手前のため Z のみ反転。
 */
export function slamTranslationToMafterDelta(
  tx: number,
  ty: number,
  tz: number,
  userScale: number,
): Vec3 {
  const mz = -tz * userScale;
  return {
    x: tx * userScale,
    y: ty * userScale,
    z: mz === 0 ? 0 : mz,
  };
}

export function rawTranslationToMafterDelta(
  t: RawTranslation,
  userScale: number,
): Vec3 {
  return slamTranslationToMafterDelta(t[0], t[1], t[2], userScale);
}

export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function mat3ToMat4(R: Mat3): Mat4 {
  return [
    R[0][0], R[0][1], R[0][2], 0,
    R[1][0], R[1][1], R[1][2], 0,
    R[2][0], R[2][1], R[2][2], 0,
    0, 0, 0, 1,
  ];
}

function quatToMat3(q: RawQuaternion): Mat3 {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

/** SLAM 座標（+z 奥）→ Mafter（+z 手前）への回転共役: R' = C·R·C, C = diag(1,1,-1)。 */
export function slamMat3ToMafterMat3(R: Mat3): Mat3 {
  return [
    [R[0][0], R[0][1], -R[0][2]],
    [R[1][0], R[1][1], -R[1][2]],
    [-R[2][0], -R[2][1], R[2][2]],
  ];
}

/**
 * SLAM rotation-only 四元数 → Mafter euler ZYX（度）。
 * 並進と同様 +z のみ反転（C·R·C）後に decomposeTrs。
 */
export function slamRotationToMafterEuler(q: RawQuaternion): Vec3 {
  const Rslam = quatToMat3(quaternionNormalize(q));
  const Rmafter = slamMat3ToMafterMat3(Rslam);
  const e = decomposeTrs(mat3ToMat4(Rmafter)).rotation;
  return e;
}

/** baseline euler に累積相対四元数（SLAM）を右から合成した絶対 euler。 */
export function composeBaselineRotation(baseline: Vec3, cumQ: RawQuaternion): Vec3 {
  const baseMat = rotationEuler(baseline);
  const relMat = mat3ToMat4(slamMat3ToMafterMat3(quatToMat3(quaternionNormalize(cumQ))));
  const composed = multiplyAll(baseMat, relMat);
  return decomposeTrs(composed).rotation;
}

/** フレーム間 delta 四元数列から累積相対四元数を構築。 */
export function accumulateRotationQuaternions(
  deltas: Array<RawQuaternion | null>,
): RawQuaternion[] {
  const out: RawQuaternion[] = [[0, 0, 0, 1]];
  let cum: RawQuaternion = [0, 0, 0, 1];
  for (let i = 1; i < deltas.length; i++) {
    const d = deltas[i];
    if (d) {
      cum = quaternionNormalize(quaternionMultiply(cum, d));
    }
    out.push([...cum]);
  }
  return out;
}

