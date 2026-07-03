import type { Vec3 } from "../../core/schema";
import type { RawTranslation } from "./types";

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
