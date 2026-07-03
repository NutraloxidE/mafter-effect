import {
  isValidTrackMaskPoint,
  resolveTrackMask,
  type TrackMaskSpec,
  type TrackRoi,
} from "./trackRoi";

export const FB_ERR_PX = 1;
export const LK_ERR_MAX = 20;
export const ROI_EDGE_MARGIN_PX = 3;
export const FRAME_BORDER_PX = 2;
export const REDISCOVER_INTERVAL = 10;
export const MIN_TRACK_COUNT = 40;
export const GRID_COLS = 8;
export const GRID_ROWS = 6;
export const PER_CELL_MAX = 5;
export const MIN_POINT_DIST = 8;

export interface Point2 {
  x: number;
  y: number;
}

/** forward-backward 往復誤差と LK err・status で点を残す。 */
export function filterTrackedPoints(
  prev: Point2[],
  forward: Point2[],
  backward: Point2[],
  statusFwd: ArrayLike<number>,
  statusBack: ArrayLike<number>,
  errFwd: ArrayLike<number>,
  fbThresh = FB_ERR_PX,
  errMax = LK_ERR_MAX,
): { keptPrev: Point2[]; keptCur: Point2[] } {
  const keptPrev: Point2[] = [];
  const keptCur: Point2[] = [];
  const n = Math.min(prev.length, forward.length, backward.length);
  for (let i = 0; i < n; i++) {
    if (!statusFwd[i] || !statusBack[i]) continue;
    const err = errFwd[i] ?? 0;
    if (!Number.isFinite(err) || err > errMax) continue;
    const p0 = prev[i]!;
    const p1 = forward[i]!;
    const pb = backward[i]!;
    if (
      !Number.isFinite(p0.x) ||
      !Number.isFinite(p0.y) ||
      !Number.isFinite(p1.x) ||
      !Number.isFinite(p1.y) ||
      !Number.isFinite(pb.x) ||
      !Number.isFinite(pb.y)
    ) {
      continue;
    }
    const fb = Math.hypot(p0.x - pb.x, p0.y - pb.y);
    if (fb > fbThresh) continue;
    keptPrev.push(p0);
    keptCur.push(p1);
  }
  return { keptPrev, keptCur };
}

/** 追跡マスク上で有効な点のみ残す（縁 margin・exclude 境界を除外）。 */
export function filterPointsInRoiInterior(
  points: Point2[],
  w: number,
  h: number,
  roiOrMask: TrackRoi | TrackMaskSpec | null | undefined,
  margin = ROI_EDGE_MARGIN_PX,
): Point2[] {
  const mask = resolveMaskArg(roiOrMask);
  return points.filter((p) => isValidTrackMaskPoint(p.x, p.y, mask, margin, w, h));
}

function resolveMaskArg(
  roiOrMask: TrackRoi | TrackMaskSpec | null | undefined,
): TrackMaskSpec {
  if (!roiOrMask) return {};
  if ("include" in roiOrMask || "exclude" in roiOrMask) {
    return resolveTrackMask(roiOrMask as TrackMaskSpec, null);
  }
  return resolveTrackMask(null, roiOrMask as TrackRoi);
}

function minDistSq(p: Point2, others: Point2[]): number {
  let best = Infinity;
  for (const o of others) {
    const d = (p.x - o.x) ** 2 + (p.y - o.y) ** 2;
    if (d < best) best = d;
  }
  return best;
}

/**
 * 候補点を 8×6 グリッドで分散選択。既存点近傍（minDist）は除外。
 * 各セル最大 perCell 点。
 */
export function selectGridDispersedPoints(
  candidates: Point2[],
  existing: Point2[],
  w: number,
  h: number,
  opts?: {
    cols?: number;
    rows?: number;
    perCell?: number;
    minDist?: number;
  },
): Point2[] {
  const cols = opts?.cols ?? GRID_COLS;
  const rows = opts?.rows ?? GRID_ROWS;
  const perCell = opts?.perCell ?? PER_CELL_MAX;
  const minDist = opts?.minDist ?? MIN_POINT_DIST;
  const minDistSqThresh = minDist * minDist;

  const cellW = w / cols;
  const cellH = h / rows;
  const buckets: Point2[][] = Array.from({ length: cols * rows }, () => []);

  for (const p of candidates) {
    if (p.x < 0 || p.y < 0 || p.x >= w || p.y >= h) continue;
    if (existing.length > 0 && minDistSq(p, existing) < minDistSqThresh) continue;
    const cx = Math.min(cols - 1, Math.floor(p.x / cellW));
    const cy = Math.min(rows - 1, Math.floor(p.y / cellH));
    buckets[cy * cols + cx]!.push(p);
  }

  const selected: Point2[] = [];
  for (const bucket of buckets) {
    // セル中心に近い順（安定）
    const cx = (bucket[0] ? Math.floor(bucket[0].x / cellW) : 0) + 0.5;
    const cy = (bucket[0] ? Math.floor(bucket[0].y / cellH) : 0) + 0.5;
    const centerX = cx * cellW;
    const centerY = cy * cellH;
    bucket.sort(
      (a, b) =>
        (a.x - centerX) ** 2 +
        (a.y - centerY) ** 2 -
        ((b.x - centerX) ** 2 + (b.y - centerY) ** 2),
    );
    let taken = 0;
    for (const p of bucket) {
      if (taken >= perCell) break;
      if (selected.length > 0 && minDistSq(p, selected) < minDistSqThresh) continue;
      if (existing.length > 0 && minDistSq(p, existing) < minDistSqThresh) continue;
      selected.push(p);
      taken++;
    }
  }
  return selected;
}

export function shouldRediscover(frameIdx: number, trackCount: number): boolean {
  if (trackCount < MIN_TRACK_COUNT) return true;
  if (frameIdx > 0 && frameIdx % REDISCOVER_INTERVAL === 0) return true;
  return false;
}
