import type { BooleanOp, Frame, ObjectId, ShapeVertex, TimelineComposition } from "../core/schema";
import { newVertexId } from "../core/ids";
import { staticProp, vec3 } from "../core/props";
import { resolve } from "../runtime/resolve";
import { composeRings } from "../runtime/shapePathBoolean";
import type { MultiPolygon, Ring } from "polygon-clipping";

// §5.5d/§5.5e shape kind="merge" の Bake（Illustrator Expand 相当）。
// 「その場で固定」＝ mergeInputs（他レイヤー参照）を外し、Boolean 合成結果を独立した
// kind="path" の rings（複数リング・穴/分離図形対応, §5.5e）データへ変換する。
//
// AE の「Convert Expression to Keyframes」と同じ制約: 1つのパスプロパティは全キーフレームで
// 頂点数・リング数（トポロジー）を揃える必要がある。オブジェクトの inPoint..outPoint 区間で
// トポロジーが一度でも変わる場合、その区間を単一の連続アニメーションとしてベイクすることは
// できない（AE のマスクパスも同様の制約を持つ）— その場合は現在フレームの静止ベイクへ
// フォールバックする（ユーザー承認済みの既定挙動）。

export interface ShapeBakeResult {
  rings: ShapeVertex[][];
  /** 全区間をキーフレーム化できた場合のみ [inPoint, outPoint) を返す。フォールバック時は null。 */
  bakedFrameRange: [number, number] | null;
  /** フォールバック時のみ、理由を人間可読な文字列で返す。 */
  fallbackReason?: string;
}

function topologyOf(mp: MultiPolygon): number[] {
  const counts: number[] = [];
  for (const polygon of mp) for (const ring of polygon) counts.push(ring.length);
  return counts;
}

function topologyEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

function flattenRings(mp: MultiPolygon): Ring[] {
  const rings: Ring[] = [];
  for (const polygon of mp) for (const ring of polygon) rings.push(ring);
  return rings;
}

function composedRingsAtFrame(comp: TimelineComposition, objectId: ObjectId, frame: Frame): MultiPolygon {
  const scene = resolve(comp, frame);
  const obj = scene.objects.find((o) => o.id === objectId);
  const shapeComp = obj?.components.find((c) => c.type === "shape");
  const resolvedMergeRings = (shapeComp?.props["resolvedMergeRings"] as { op: BooleanOp; ring: Ring }[] | undefined) ?? [];
  return composeRings(resolvedMergeRings);
}

function ringsToStaticShapeVertices(rings: Ring[]): ShapeVertex[][] {
  return rings.map((ring) => ring.map(([x, y]) => ({ id: newVertexId(), pos: staticProp(vec3(x, y, 0)) })));
}

/**
 * kind="merge" shape を Bake する（純関数寄り — resolve() を繰り返し呼ぶだけで自身は
 * Math.random/Date.now/DOM に触れない。ID 採番のみ行うため呼び出しは編集コマンド文脈に限る）。
 */
export function bakeMergeShapeToPath(
  comp: TimelineComposition,
  objectId: ObjectId,
  inPoint: Frame,
  outPoint: Frame,
  currentFrame: Frame,
): ShapeBakeResult {
  const frames: Frame[] = [];
  for (let f = inPoint; f < outPoint; f++) frames.push(f);

  if (frames.length === 0) {
    const mp = composedRingsAtFrame(comp, objectId, currentFrame);
    return {
      rings: ringsToStaticShapeVertices(flattenRings(mp)),
      bakedFrameRange: null,
      fallbackReason: "オブジェクトの表示区間が空のため、現在フレームのみベイクしました",
    };
  }

  const polysByFrame = frames.map((f) => composedRingsAtFrame(comp, objectId, f));
  const topologies = polysByFrame.map(topologyOf);
  const stable = topologies.every((t) => topologyEqual(t, topologies[0]!));

  if (stable) {
    const ringVertexCounts = topologies[0]!;
    const rings: ShapeVertex[][] = ringVertexCounts.map((vertCount, ringIdx) => {
      const vertices: ShapeVertex[] = [];
      for (let v = 0; v < vertCount; v++) {
        const keyframes = frames.map((f, frameIdx) => {
          const ring = flattenRings(polysByFrame[frameIdx]!)[ringIdx]!;
          const [x, y] = ring[v]!;
          return { frame: f, value: vec3(x, y, 0), easing: { type: "hold" as const } };
        });
        vertices.push({ id: newVertexId(), pos: { value: keyframes[0]!.value, keyframes } });
      }
      return vertices;
    });
    return { rings, bakedFrameRange: [inPoint, outPoint - 1] };
  }

  // トポロジー不安定 → 現在フレームの静止ベイクへフォールバック。
  const mp = composedRingsAtFrame(comp, objectId, currentFrame);
  return {
    rings: ringsToStaticShapeVertices(flattenRings(mp)),
    bakedFrameRange: null,
    fallbackReason: `表示区間内で形状のトポロジー（穴・分離図形の数）が変化するため、区間全体のキーフレーム化はできません。現在フレーム（${currentFrame}）の静止形状のみベイクしました。`,
  };
}
