import type { Vec3 } from "../../core/schema";

/**
 * valid な相対変位列の支配軸 range が targetRange になる倍率を返す。
 * range が極小のときは 1（増幅しない）。
 */
export function computeAutoScale(
  deltas: Array<Vec3 | null>,
  targetRange: number,
  options?: { minRange?: number; maxScale?: number },
): number {
  const minRange = options?.minRange ?? 1e-6;
  const maxScale = options?.maxScale ?? 1e6;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let any = false;
  for (const d of deltas) {
    if (!d) continue;
    any = true;
    if (d.x < minX) minX = d.x;
    if (d.x > maxX) maxX = d.x;
    if (d.y < minY) minY = d.y;
    if (d.y > maxY) maxY = d.y;
    if (d.z < minZ) minZ = d.z;
    if (d.z > maxZ) maxZ = d.z;
  }
  if (!any || !(targetRange > 0)) return 1;
  const rx = maxX - minX;
  const ry = maxY - minY;
  const rz = maxZ - minZ;
  const dominant = Math.max(rx, ry, rz);
  if (dominant < minRange) return 1;
  const s = targetRange / dominant;
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.min(maxScale, s);
}

/** 絶対位置列から baseline 相対変位を作り auto-scale を掛ける。 */
export function applyAutoScaleToPositions(
  positions: Vec3[],
  baseline: Vec3,
  targetRange: number,
  userScale = 1,
): { positions: Vec3[]; autoScale: number } {
  const deltas: Array<Vec3 | null> = positions.map((p) => ({
    x: p.x - baseline.x,
    y: p.y - baseline.y,
    z: p.z - baseline.z,
  }));
  const autoScale = computeAutoScale(deltas, targetRange);
  const eff = autoScale * userScale;
  return {
    autoScale,
    positions: positions.map((p) => ({
      x: baseline.x + (p.x - baseline.x) * eff,
      y: baseline.y + (p.y - baseline.y) * eff,
      z: baseline.z + (p.z - baseline.z) * eff,
    })),
  };
}

/** 変位 range が flow に対して極小か。 */
export function isMotionSuspiciouslySmall(
  positionRange: number,
  medianFlowPx: number,
  options?: { minFlow?: number; maxRangeRatio?: number },
): boolean {
  const minFlow = options?.minFlow ?? 1.5;
  const maxRangeRatio = options?.maxRangeRatio ?? 0.05;
  if (medianFlowPx < minFlow) return false;
  return positionRange < medianFlowPx * maxRangeRatio;
}

export function vec3Range(positions: Vec3[]): number {
  if (positions.length === 0) return 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of positions) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return Math.max(maxX - minX, maxY - minY, maxZ - minZ);
}
