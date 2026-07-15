import type { Vec3 } from "../../core/schema";

/**
 * §5.5f 3D ジオメトリ拡張（geom3d）— text/shape 非破壊押し出し。
 * 本セッションの実装スコープ: depth + bevel + lambert 陰影 + トグルのみ（P1 コア）。
 * twist/bend/taper・GradientFill 面塗りは未実装（次フェーズ・doc/cloudplan/3d-text-extrusion-plan.md 参照）。
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** resolved props から読んだ 3D ジオメトリパラメータ（P1 スコープのみ）。 */
export interface Geom3DParams {
  enabled: boolean;
  depth: number;
  bevelSize: number;
  bevelSegments: number;
  curveQuality: "low" | "medium" | "high";
  shading: "none" | "lambert";
  lightDir: Vec3;
  ambient: number;
}

/**
 * text/shape のアウトラインを共通形へ正規化したもの（OutlineProvider 抽象、§5.1）。
 * rings は flatten 済みポリゴンで、配置（グリフの x/baseline 等）は座標へ焼き込み済み
 * （renderPreciseText の font.getPath 呼び出しと同じ規約）。
 * text は 1 グリフ = 1 要素、shape は輪郭 1 個 = 1 要素（穴は同じ要素内の複数 rings）。
 *
 * **不変条件**: rings は `normalizeRingsNonzero` を通過済み＝**互いに交差せず自己交差もしない**
 * （外周と真の穴のみ）。フォントの生アウトラインはこの条件を満たさない（nonzero winding rule 前提で
 * 画どうしが重なる）ため、生の輪郭を直接ここへ入れてはならない。下流の `groupRingsByNesting` /
 * earcut / bevel inset / 側面 band はすべてこの前提に依存する。
 */
export interface OutlineGlyph {
  rings: Vec2[][];
}

/**
 * 押し出しメッシュの頂点属性配列（インターリーブなし・parallel arrays）。
 * **P1 実装の簡略化（既知の設計判断・doc/cloudplan/3d-text-extrusion-plan.md §5.2 からの逸脱）**:
 * ベベルの XY オフセット（px）と Z 方向の比率を正しく釣り合わせるため、`depth`/`bevelSize` は
 * uniform ではなく **mesh 生成時に実座標として焼き込む**（front cap は常に local z=0、
 * back cap は z=-depth）。そのため depth/bevelSize の変更はメッシュキャッシュミス＝再生成を伴う
 * （twist/bend/taper 等の純変形 uniform のような「アニメ中 再生成ゼロ」は本パスでは未達成・
 * 次フェーズの性能最適化課題）。カメラ view/projection のみを GL 側 uniform で適用する。
 * faceGroup: 0=front, 1=back, 2=side, 3=bevel。
 */
export interface MeshData {
  positions: Float32Array; // xyz（ローカル実座標 px。front cap z=0 / back cap z=-depth）
  normals: Float32Array; // xyz（正規化済み）
  faceGroup: Uint8Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}
