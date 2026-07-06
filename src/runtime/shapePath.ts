import type { Vec3 } from "../core/schema";

// §5.5c shape kind="path" 描画用の純関数（INV-1）。resolve() 済みの値のみ扱う。

export interface ResolvedShapeVertex {
  id: string;
  pos: Vec3;
  inTangent?: Vec3;
  outTangent?: Vec3;
}

/**
 * 頂点配列（パス順）から閉じた SVG `<path d>` 文字列を組み立てる。
 * tangent は頂点位置からの相対オフセット（AE 風ハンドル）。前後どちらの頂点にも
 * tangent が無い区間は直線（L）、片方でもあれば 3 次ベジェ（C）で結ぶ。
 * 最終頂点→先頭頂点も同様に結んで閉じる（塗り面として扱うため）。
 */
export function buildShapePathD(vertices: ResolvedShapeVertex[]): string {
  if (vertices.length < 2) return "";
  const n = vertices.length;
  const pt = (v: Vec3) => `${v.x},${v.y}`;
  const add = (base: Vec3, delta: Vec3 | undefined): Vec3 =>
    delta ? { x: base.x + delta.x, y: base.y + delta.y, z: base.z } : base;

  let d = `M ${pt(vertices[0]!.pos)}`;
  for (let i = 0; i < n; i++) {
    const from = vertices[i]!;
    const to = vertices[(i + 1) % n]!;
    if (!from.outTangent && !to.inTangent) {
      d += ` L ${pt(to.pos)}`;
    } else {
      const c1 = add(from.pos, from.outTangent);
      const c2 = add(to.pos, to.inTangent);
      d += ` C ${pt(c1)} ${pt(c2)} ${pt(to.pos)}`;
    }
  }
  return `${d} Z`;
}

/**
 * §5.5e 複数リング（穴・分離図形）を SVG `<path d>` へまとめる。各リングは buildShapePathD と
 * 同じ規則（ベジェ厳密保持）。呼び出し側は fill-rule="evenodd" を必ずセットすること
 * （リングの入れ子/重なりが穴として正しく描画されるのは evenodd 前提のため）。
 */
export function buildMultiRingPathD(rings: ResolvedShapeVertex[][]): string {
  return rings
    .map((ring) => buildShapePathD(ring))
    .filter((d) => d.length > 0)
    .join(" ");
}
