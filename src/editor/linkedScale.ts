import type { Vec3 } from "../core/schema";

const SCALE_LINK_EPS = 1e-6;

/** Inspector Scale スクラブ: リンク ON 時は X/Y を比例維持（Z は独立）。 */
export function applyLinkedScaleValue(
  vals: Vec3,
  axis: "x" | "y" | "z",
  newVal: number,
  linked: boolean,
): Vec3 {
  if (!linked || axis === "z") {
    return { ...vals, [axis]: newVal };
  }
  const old = vals[axis];
  if (Math.abs(old) < SCALE_LINK_EPS) {
    const delta = newVal - old;
    const other: "x" | "y" = axis === "x" ? "y" : "x";
    return {
      ...vals,
      [axis]: newVal,
      [other]: vals[other] + delta,
    };
  }
  const ratio = newVal / old;
  return {
    x: vals.x * ratio,
    y: vals.y * ratio,
    z: vals.z,
  };
}

export function applyLinkedScaleDelta(
  vals: Vec3,
  axis: "x" | "y" | "z",
  delta: number,
  linked: boolean,
): Vec3 {
  return applyLinkedScaleValue(vals, axis, vals[axis] + delta, linked);
}
