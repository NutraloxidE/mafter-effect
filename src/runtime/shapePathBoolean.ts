import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Polygon, Ring } from "polygon-clipping";
import type { BooleanOp } from "../core/schema";
import type { ResolvedShapeVertex } from "./shapePath";

// §5.5d shape kind="merge"（Boolean/Pathfinder 合成・Illustrator 風・他レイヤー参照）用の純関数（INV-1）。
// polygon-clipping は直線ポリゴンのみを扱うため、bezier tangent は合成前に直線分割（flatten）し、
// rect/ellipse も同じポリゴン輪（Ring）表現へ変換してから合成する。そのため合成結果の輪郭は
// 厳密な曲線ではなく多角形近似になる（合成しない単体 shape は shapePath.ts の buildShapePathD /
// 通常の CSS box 描画のまま厳密な形状を保つ — この近似は merge 使用時のみ）。
// rect の角丸（radiusTL/TR/BR/BL）は v1 では簡略化のため無視し、鋭角の矩形として扱う（既知の制約）。

const ELLIPSE_SEGMENTS = 48;
const FLATTEN_SEGMENTS_PER_EDGE = 24;

type Point = [number, number];

function cubicBezierPoint(p0: Point, c1: Point, c2: Point, p1: Point, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1],
  ];
}

/** 頂点配列（tangent 含む）を閉じたポリゴン輪へ直線分割する（kind="path" 用）。 */
export function flattenVerticesToRing(
  vertices: ResolvedShapeVertex[],
  segmentsPerEdge = FLATTEN_SEGMENTS_PER_EDGE,
): Ring {
  if (vertices.length < 2) return [];
  const n = vertices.length;
  const ring: Ring = [];
  for (let i = 0; i < n; i++) {
    const from = vertices[i]!;
    const to = vertices[(i + 1) % n]!;
    const p0: Point = [from.pos.x, from.pos.y];
    ring.push(p0);
    if (!from.outTangent && !to.inTangent) continue;
    const c1: Point = from.outTangent ? [from.pos.x + from.outTangent.x, from.pos.y + from.outTangent.y] : p0;
    const p1: Point = [to.pos.x, to.pos.y];
    const c2: Point = to.inTangent ? [to.pos.x + to.inTangent.x, to.pos.y + to.inTangent.y] : p1;
    for (let s = 1; s < segmentsPerEdge; s++) {
      ring.push(cubicBezierPoint(p0, c1, c2, p1, s / segmentsPerEdge));
    }
  }
  return ring;
}

/** rect（kind="rect"）をポリゴン輪へ変換する（局所原点=左上、角丸は無視）。 */
export function rectToRing(size: { x: number; y: number }): Ring {
  const w = size.x;
  const h = size.y;
  return [[0, 0], [w, 0], [w, h], [0, h]];
}

/** ellipse（kind="ellipse"）を N 角形近似のポリゴン輪へ変換する（局所原点=左上の外接矩形基準）。 */
export function ellipseToRing(size: { x: number; y: number }, segments = ELLIPSE_SEGMENTS): Ring {
  const rx = size.x / 2;
  const ry = size.y / 2;
  const cx = rx;
  const cy = ry;
  const ring: Ring = [];
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    ring.push([cx + rx * Math.cos(theta), cy + ry * Math.sin(theta)]);
  }
  return ring;
}

/** rings を順に合成した MultiPolygon を返す（Pathfinder 相当 — 各 ring は「直前までの合成結果」に
 * 対して自分の op を適用する。rings[0] の op は無視される＝ベース図形）。 */
export function composeRings(rings: { op: BooleanOp; ring: Ring }[]): MultiPolygon {
  const valid = rings.filter((r) => r.ring.length >= 3);
  if (valid.length === 0) return [];
  let acc: MultiPolygon = [[valid[0]!.ring]];
  for (let i = 1; i < valid.length; i++) {
    acc = OP_FN[valid[i]!.op](acc, [valid[i]!.ring]);
  }
  return acc;
}

const OP_FN: Record<BooleanOp, (a: Polygon | MultiPolygon, b: Polygon | MultiPolygon) => MultiPolygon> = {
  unite: polygonClipping.union,
  subtract: polygonClipping.difference,
  intersect: polygonClipping.intersection,
  exclude: polygonClipping.xor,
};

/** MultiPolygon（外輪+穴）を SVG `<path d>` へ変換する。穴は fill-rule="evenodd" 前提で正しく描画される。 */
export function multiPolygonToPathD(mp: MultiPolygon): string {
  const parts: string[] = [];
  for (const polygon of mp) {
    for (const ring of polygon) {
      if (ring.length < 2) continue;
      const first = ring[0]!;
      const rest = ring.slice(1).map((p) => `L ${p[0]},${p[1]}`).join(" ");
      parts.push(`M ${first[0]},${first[1]}${rest ? ` ${rest}` : ""} Z`);
    }
  }
  return parts.join(" ");
}
