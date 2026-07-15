import earcutFn from "earcut";
import type { BevelStyle, MeshData, OutlineGlyph, Vec2 } from "./geom3dTypes";

/**
 * §5.2 押し出しメッシュ生成（純関数）。P1 スコープ = depth + bevel（lambert 陰影用の法線込み）。
 * front cap は常にローカル z=0（3D トグル ON でも depth=0 なら見た目が変わらない）、
 * back cap は z=-depth（"+z 手前" 規約に対し奥へ伸びる、§6.5 座標系）。
 * MeshData の設計判断（uniform ではなく実座標で焼く理由）は geom3dTypes.ts のコメント参照。
 */

interface Vec3Local {
  x: number;
  y: number;
  z: number;
}

export interface ExtrudeOptions {
  depth: number;
  bevelSize: number;
  bevelStyle: BevelStyle;
  /** angular では無視される（1 セグメントで厳密なため）。 */
  bevelSegments: number;
}

interface RingGroup {
  outer: Vec2[];
  holes: Vec2[][];
}

/** シューレース公式（符号は「このリング自身の巻き方向」判定に使う。純粋に相対値として使う）。 */
export function signedArea(ring: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function pointInPolygon(pt: Vec2, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i]!;
    const pj = ring[j]!;
    const intersect =
      pi.y > pt.y !== pj.y > pt.y &&
      pt.x < ((pj.x - pi.x) * (pt.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * リング列を「外周 + 直下のホール」のグループへ分解する（点包含の入れ子深度ベース・巻き方向に非依存）。
 * 深度が偶数のリングを外周として扱い、深度が親+1 のリングをそのホールとして割り当てる
 * （TrueType/OpenType の穴付きグリフ「O」「A」「8」等、および「i」「%」のような複数輪郭を両対応）。
 *
 * **前提（重要）**: 入力リングは互いに交差しない（`normalizeRingsNonzero` 通過済み・geom3dTypes.ts の
 * OutlineGlyph 参照）。巻き方向を捨てる本アルゴリズムは重なる輪郭を原理的に解けず、フォントの生
 * アウトラインを直接渡すと実体を穴と誤判定する（例: `日` の横棒は枠の内側にあるが穴ではない）。
 */
export function groupRingsByNesting(rings: Vec2[][]): RingGroup[] {
  const n = rings.length;
  if (n === 0) return [];
  const areas = rings.map((r) => Math.abs(signedArea(r)));
  const parent: number[] = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let bestParent = -1;
    let bestArea = Infinity;
    const testPt = rings[i]![0]!;
    for (let j = 0; j < n; j++) {
      if (j === i || areas[j]! <= areas[i]!) continue;
      if (pointInPolygon(testPt, rings[j]!) && areas[j]! < bestArea) {
        bestArea = areas[j]!;
        bestParent = j;
      }
    }
    parent[i] = bestParent;
  }
  const depth: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let d = 0;
    let p = parent[i] ?? -1;
    const seen = new Set<number>();
    while (p !== -1 && !seen.has(p)) {
      seen.add(p);
      d++;
      p = parent[p] ?? -1;
    }
    depth[i] = d;
  }
  const groups: RingGroup[] = [];
  for (let i = 0; i < n; i++) {
    if (depth[i]! % 2 !== 0) continue;
    const holes = rings.filter((_, j) => depth[j] === depth[i]! + 1 && parent[j] === i);
    groups.push({ outer: rings[i]!, holes });
  }
  return groups;
}

/** 頂点 i の「材料から外向き」単位法線（隣接 2 辺の法線平均）。signedArea の符号で外周/穴を自動判別。 */
function outwardVertexNormal(ring: Vec2[], i: number, ringSign: number): Vec2 {
  const n = ring.length;
  const prev = ring[(i - 1 + n) % n]!;
  const cur = ring[i]!;
  const next = ring[(i + 1) % n]!;
  const e1 = edgeOutward(prev, cur, ringSign);
  const e2 = edgeOutward(cur, next, ringSign);
  let x = e1.x + e2.x;
  let y = e1.y + e2.y;
  const len = Math.hypot(x, y) || 1;
  x /= len;
  y /= len;
  return { x, y };
}

function edgeOutward(a: Vec2, b: Vec2, ringSign: number): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // signedArea>0 のリングでは (dy,-dx) が外向き（shoelace と同じ規約で導出・extrudeMesh.test.ts で検証）。
  return ringSign >= 0 ? { x: dy / len, y: -dx / len } : { x: -dy / len, y: dx / len };
}

/** リング全頂点の外向き法線（プロファイル生成とベベル法線で共有するため一度だけ作る）。 */
function ringOutwardNormals(ring: Vec2[]): Vec2[] {
  const sign = Math.sign(signedArea(ring)) || 1;
  return ring.map((_, i) => outwardVertexNormal(ring, i, sign));
}

/**
 * リングの各頂点を「材料の外から内へ」dist だけオフセットする（ベベルのチャンファ生成用）。
 * 法線は呼び出し側が `ringOutwardNormals` で用意する（全プロファイルリングで同じ法線を共有し、
 * 頂点の 1:1 対応を保つため）。
 */
function insetRingWith(ring: Vec2[], normals: Vec2[], dist: number): Vec2[] {
  return ring.map((p, i) => {
    const n = normals[i]!;
    return { x: p.x - n.x * dist, y: p.y - n.y * dist };
  });
}

function vsub(a: Vec3Local, b: Vec3Local): Vec3Local {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function vcross(a: Vec3Local, b: Vec3Local): Vec3Local {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
/**
 * ゼロ長ベクトル（退化三角形の cross product 等）は正規化不能。フォールバックは (0,0,1) —
 * 退化三角形は面積ゼロで見た目に寄与しないため、法線の値自体は無害（何であっても可視影響なし）。
 */
function vnormalize(a: Vec3Local): Vec3Local {
  const len = Math.hypot(a.x, a.y, a.z);
  if (len < 1e-9) return { x: 0, y: 0, z: 1 };
  return { x: a.x / len, y: a.y / len, z: a.z / len };
}

class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  faceGroup: number[] = [];
  indices: number[] = [];

  private pushVertex(p: Vec3Local, n: Vec3Local, group: number): number {
    const idx = this.positions.length / 3;
    this.positions.push(p.x, p.y, p.z);
    this.normals.push(n.x, n.y, n.z);
    this.faceGroup.push(group);
    return idx;
  }

  addTriangle(p1: Vec3Local, p2: Vec3Local, p3: Vec3Local, n: Vec3Local, group: number): void {
    const i1 = this.pushVertex(p1, n, group);
    const i2 = this.pushVertex(p2, n, group);
    const i3 = this.pushVertex(p3, n, group);
    this.indices.push(i1, i2, i3);
  }

  /** 頂点ごとに異なる法線を与える（ベベルの解析法線＝スムースシェーディング用）。 */
  addTriangleSmooth(
    p1: Vec3Local, n1: Vec3Local,
    p2: Vec3Local, n2: Vec3Local,
    p3: Vec3Local, n3: Vec3Local,
    group: number,
  ): void {
    const i1 = this.pushVertex(p1, n1, group);
    const i2 = this.pushVertex(p2, n2, group);
    const i3 = this.pushVertex(p3, n3, group);
    this.indices.push(i1, i2, i3);
  }

  toMeshData(): MeshData {
    return {
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      faceGroup: Uint8Array.from(this.faceGroup),
      indices: Uint32Array.from(this.indices),
      vertexCount: this.positions.length / 3,
      triangleCount: this.indices.length / 3,
    };
  }
}

/** earcut で外周+穴を三角化し、フラットな法線で cap を追加する。 */
function addCap(builder: MeshBuilder, group: RingGroup, z: number, normal: Vec3Local, faceGroupId: number): void {
  const rings = [group.outer, ...group.holes];
  const flatVerts: number[] = [];
  const holeIndices: number[] = [];
  for (const ring of rings) {
    if (flatVerts.length > 0) holeIndices.push(flatVerts.length / 2);
    for (const p of ring) flatVerts.push(p.x, p.y);
  }
  const triIdx = earcutFn(flatVerts, holeIndices.length > 0 ? holeIndices : null, 2);
  const verts: Vec2[] = [];
  for (let i = 0; i < flatVerts.length; i += 2) verts.push({ x: flatVerts[i]!, y: flatVerts[i + 1]! });
  for (let i = 0; i < triIdx.length; i += 3) {
    const a = verts[triIdx[i]!]!;
    const b = verts[triIdx[i + 1]!]!;
    const c = verts[triIdx[i + 2]!]!;
    builder.addTriangle(
      { x: a.x, y: a.y, z },
      { x: b.x, y: b.y, z },
      { x: c.x, y: c.y, z },
      normal,
      faceGroupId,
    );
  }
}

/** 2 つの対応リング（同じ頂点数・順序）を帯状に結び、実 3D 法線を面ごとに計算する。 */
function addBand(builder: MeshBuilder, ringA: Vec2[], zA: number, ringB: Vec2[], zB: number, faceGroupId: number): void {
  const n = ringA.length;
  const sign = Math.sign(signedArea(ringA)) || 1;
  for (let i = 0; i < n; i++) {
    const a0 = ringA[i]!;
    const a1 = ringA[(i + 1) % n]!;
    const b0 = ringB[i]!;
    const b1 = ringB[(i + 1) % n]!;
    const p0: Vec3Local = { x: a0.x, y: a0.y, z: zA };
    const p1: Vec3Local = { x: a1.x, y: a1.y, z: zA };
    const p2: Vec3Local = { x: b1.x, y: b1.y, z: zB };
    const p3: Vec3Local = { x: b0.x, y: b0.y, z: zB };
    const face = vnormalize(vcross(vsub(p1, p0), vsub(p2, p0)));
    const hint = edgeOutward(a0, a1, sign);
    const flipped = face.x * hint.x + face.y * hint.y < 0 ? { x: -face.x, y: -face.y, z: -face.z } : face;
    builder.addTriangle(p0, p1, p2, flipped, faceGroupId);
    builder.addTriangle(p0, p2, p3, flipped, faceGroupId);
  }
}

const FACE_FRONT = 0;
const FACE_BACK = 1;
const FACE_SIDE = 2;
const FACE_BEVEL = 3;

/**
 * ベベル断面の 1 点（§5.5f「ベベル断面」）。断面座標は (n, z) = (輪郭から外向き, 手前が +)、
 * 半径 R で正規化した比率で返す。t=0 が cap の縁 (n=-R, z=0)、t=1 が側壁の上端 (n=0, z=-R)
 * ＝ **3 スタイルは端点を共有し曲線だけが違う**。
 *
 * 凸/凹は円弧の中心が材料の内側か外側かで決まる:
 *   round  中心 (-R,-R) = 材料の内側 → 凸（ラウンドオーバー）
 *   concave 中心 (0,0)  = 外側の角   → 凹（コーブ）
 * 中心を輪郭の角 (0,-R) に置くと凹になり、cap も z=0 から後退して「ベベルでなくへこみ」になる
 * （2026-07-15 に修正した実バグ。extrude.test.ts の凸性テストで固定）。
 *
 * `offsetFrac` = 輪郭から内側へ inset する量 / R、`zFrac` = cap 平面から奥へ進む量 / R、
 * `(nComp, zComp)` = (n, z) 平面の単位法線（|(nComp, zComp)| = 1）。
 */
function bevelProfilePoint(
  style: BevelStyle,
  t: number,
): { offsetFrac: number; zFrac: number; nComp: number; zComp: number } {
  if (style === "angular") {
    // 直線 45° チャンファ。法線は断面全体で一定なので 1 セグメントで厳密。
    return { offsetFrac: 1 - t, zFrac: t, nComp: Math.SQRT1_2, zComp: Math.SQRT1_2 };
  }
  const theta = t * (Math.PI / 2);
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);
  if (style === "concave") {
    return { offsetFrac: cos, zFrac: sin, nComp: cos, zComp: sin };
  }
  return { offsetFrac: 1 - sin, zFrac: 1 - cos, nComp: sin, zComp: cos };
}

/** プロファイル 1 段（実座標に落とした断面リング）。 */
interface ProfileStep {
  ring: Vec2[];
  z: number;
  /** (n, z) 平面の単位法線。back 側は zComp の符号が反転する。 */
  nComp: number;
  zComp: number;
}

/** 断面法線 (nComp, zComp) と頂点の外向き XY から 3D 頂点法線を作る。両者が単位なので結果も単位。 */
function bevelVertexNormal(outXY: Vec2, nComp: number, zComp: number): Vec3Local {
  return { x: outXY.x * nComp, y: outXY.y * nComp, z: zComp };
}

/**
 * ベベル帯を張る。法線は面ごとの実ジオメトリ法線ではなく**断面の解析法線**を頂点法線として与える
 * ＝ segments を上げるとファセットが消えて滑らかになる（フラット法線の addBand と対照的）。
 */
function addBevelBand(builder: MeshBuilder, a: ProfileStep, b: ProfileStep, outXY: Vec2[]): void {
  const n = a.ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ni = outXY[i]!;
    const nj = outXY[j]!;
    const p0: Vec3Local = { x: a.ring[i]!.x, y: a.ring[i]!.y, z: a.z };
    const p1: Vec3Local = { x: a.ring[j]!.x, y: a.ring[j]!.y, z: a.z };
    const p2: Vec3Local = { x: b.ring[j]!.x, y: b.ring[j]!.y, z: b.z };
    const p3: Vec3Local = { x: b.ring[i]!.x, y: b.ring[i]!.y, z: b.z };
    const n0 = bevelVertexNormal(ni, a.nComp, a.zComp);
    const n1 = bevelVertexNormal(nj, a.nComp, a.zComp);
    const n2 = bevelVertexNormal(nj, b.nComp, b.zComp);
    const n3 = bevelVertexNormal(ni, b.nComp, b.zComp);
    builder.addTriangleSmooth(p0, n0, p1, n1, p2, n2, FACE_BEVEL);
    builder.addTriangleSmooth(p0, n0, p2, n2, p3, n3, FACE_BEVEL);
  }
}

function extrudeGroup(group: RingGroup, opts: ExtrudeOptions, builder: MeshBuilder): void {
  const { depth, bevelSize, bevelSegments, bevelStyle } = opts;
  const bevelExtent = bevelSize > 0 ? Math.min(bevelSize, depth / 2) : 0;

  if (bevelExtent <= 0) {
    addCap(builder, group, 0, { x: 0, y: 0, z: 1 }, FACE_FRONT);
    addCap(builder, { outer: [...group.outer].reverse(), holes: group.holes.map((h) => [...h].reverse()) }, -depth, { x: 0, y: 0, z: -1 }, FACE_BACK);
    addBand(builder, group.outer, 0, group.outer, -depth, FACE_SIDE);
    for (const hole of group.holes) addBand(builder, hole, 0, hole, -depth, FACE_SIDE);
    return;
  }

  // ベベル断面は §5.5f「ベベル断面」＝ 3 スタイルとも「cap の縁 → 側壁の上端」を結び、曲線だけが違う。
  // angular は法線が一定なので 1 セグメントで厳密（segments を消費しない）。
  const segs = bevelStyle === "angular" ? 1 : Math.max(1, bevelSegments);

  const buildProfile = (ring: Vec2[], outXY: Vec2[], atFront: boolean): ProfileStep[] => {
    const steps: ProfileStep[] = [];
    for (let s = 0; s <= segs; s++) {
      const pr = bevelProfilePoint(bevelStyle, s / segs);
      const offset = bevelExtent * pr.offsetFrac;
      steps.push({
        ring: offset > 0 ? insetRingWith(ring, outXY, offset) : ring,
        z: atFront ? -bevelExtent * pr.zFrac : -depth + bevelExtent * pr.zFrac,
        nComp: pr.nComp,
        zComp: atFront ? pr.zComp : -pr.zComp,
      });
    }
    return steps;
  };

  const emitContourBevel = (ring: Vec2[]): { frontCapRing: Vec2[]; backCapRing: Vec2[] } => {
    // 外向き法線は元の輪郭から一度だけ作り、全プロファイルリングで共有する
    // （inset 後のリングから作り直すと頂点対応と法線がずれる）。
    const outXY = ringOutwardNormals(ring);
    const front = buildProfile(ring, outXY, true);
    const back = buildProfile(ring, outXY, false);
    for (let s = 0; s < segs; s++) {
      addBevelBand(builder, front[s]!, front[s + 1]!, outXY);
      addBevelBand(builder, back[s]!, back[s + 1]!, outXY);
    }
    // 側壁: 両ベベルの外周端（= 元の輪郭）どうしを結ぶ＝シルエットは 2D の輪郭と一致する。
    const frontWall = front[segs]!;
    const backWall = back[segs]!;
    addBand(builder, frontWall.ring, frontWall.z, backWall.ring, backWall.z, FACE_SIDE);
    return { frontCapRing: front[0]!.ring, backCapRing: back[0]!.ring };
  };

  const outerBevel = emitContourBevel(group.outer);
  const holesBevel = group.holes.map((h) => emitContourBevel(h));

  const frontCapGroup: RingGroup = { outer: outerBevel.frontCapRing, holes: holesBevel.map((h) => h.frontCapRing) };
  const backCapGroup: RingGroup = {
    outer: [...outerBevel.backCapRing].reverse(),
    holes: holesBevel.map((h) => [...h.backCapRing].reverse()),
  };
  addCap(builder, frontCapGroup, 0, { x: 0, y: 0, z: 1 }, FACE_FRONT);
  addCap(builder, backCapGroup, -depth, { x: 0, y: 0, z: -1 }, FACE_BACK);
}

/** OutlineGlyph[]（text の各文字、または shape 1 個）から押し出しメッシュを構築する（決定論）。 */
export function extrudeGeometry(glyphs: OutlineGlyph[], opts: ExtrudeOptions): MeshData {
  const builder = new MeshBuilder();
  for (const glyph of glyphs) {
    const groups = groupRingsByNesting(glyph.rings);
    for (const group of groups) extrudeGroup(group, opts, builder);
  }
  return builder.toMeshData();
}
