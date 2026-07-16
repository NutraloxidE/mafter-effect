import libtess from "libtess";
import type { Vec2 } from "./geom3dTypes";

/**
 * §5.1 OutlineProvider — 輪郭の nonzero winding 正規化（決定論・INV-1）。
 *
 * フォントのアウトラインは **nonzero winding rule** で塗られる前提で作られており、輪郭どうしが
 * 自由に重なってよい。実際 CJH グリフの多くは「画（stroke）ごとに独立した輪郭を重ねる」構成で、
 * 例えば Noto Sans JP の `日` は〈枠をシーム付き 1 輪郭で描いたもの〉+〈横棒 2 本〉の 3 輪郭が
 * 重なって出来ており、**穴（hole）は 1 つも無い**。Roboto の `A`/`B`/`8` のように欧文でも起きる
 * （フォント依存であって言語依存ではない）。
 *
 * 一方 earcut（`extrudeMesh.addCap`）が受け付けるのは「単純多角形 + 入れ子の穴」だけで、
 * 重なる輪郭は扱えない。また入れ子深度で穴を判定する `groupRingsByNesting` は巻き方向を捨てるため、
 * `日` の横棒（枠の内側にあるが実体）を穴と誤判定する。押し出し側（`addBand`/`insetRing`）も
 * 重なった輪郭をそのまま側面にするため、文字の内部に壁が生える。
 *
 * そこで押し出しパイプラインへ入れる前に、フォントと同じ nonzero rule で輪郭を再構築し、
 * **交差の無いリング列**（外周と真の穴のみ）へ正規化する。これにより下流
 * （`groupRingsByNesting` → earcut → bevel/band）は前提が満たされた入力だけを見る。
 *
 * libtess を使う理由: nonzero rule での **輪郭出力**（`GLU_TESS_BOUNDARY_ONLY`）が必要なため。
 * bevel の inset と側面 band はリングを必要とするので、三角形しか返さない tesselator では代替不可。
 * polygon-clipping（既存依存）は even-odd 系の boolean 演算のみで nonzero rule を表現できない。
 */

/** 数値誤差で潰れたリング（面積ほぼ 0）を落とす閾値（フォント座標系 px²）。 */
const MIN_RING_AREA = 1e-7;

function ringArea(ring: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * 重なり・シーム・自己交差を含みうる生の輪郭列を、nonzero winding rule で塗った領域と
 * **等価な**「交差の無いリング列」へ再構築する。塗り面積は保存される（glyph の見た目は不変）。
 *
 * tesselator が失敗した場合は入力をそのまま返す（描画を止めない・§expression 例外と同じ方針）。
 */
export function normalizeRingsNonzero(rings: Vec2[][]): Vec2[][] {
  if (rings.length === 0) return rings;

  const tess = new libtess.GluTesselator();
  const out: Vec2[][] = [];
  let current: Vec2[] = [];
  let failed = false;

  tess.gluTessCallback(libtess.gluEnum.GLU_TESS_BEGIN, (() => {
    current = [];
  }) as never);
  tess.gluTessCallback(libtess.gluEnum.GLU_TESS_VERTEX_DATA, ((data: [number, number, number]) => {
    current.push({ x: data[0], y: data[1] });
  }) as never);
  tess.gluTessCallback(libtess.gluEnum.GLU_TESS_END, (() => {
    if (current.length >= 3 && Math.abs(ringArea(current)) > MIN_RING_AREA) out.push(current);
  }) as never);
  // 輪郭の交差点で新頂点を作る（重なる画の合流部）。属性補間は不要なので座標だけ返す。
  tess.gluTessCallback(libtess.gluEnum.GLU_TESS_COMBINE, ((coords: [number, number, number]) =>
    [coords[0], coords[1], coords[2]]) as never);
  tess.gluTessCallback(libtess.gluEnum.GLU_TESS_ERROR, (() => {
    failed = true;
  }) as never);

  tess.gluTessProperty(libtess.gluEnum.GLU_TESS_WINDING_RULE, libtess.windingRule.GLU_TESS_WINDING_NONZERO);
  // 三角形ではなく輪郭を返させる（bevel inset と側面 band がリングを要求するため）。
  tess.gluTessProperty(libtess.gluEnum.GLU_TESS_BOUNDARY_ONLY, true);
  // グリフは XY 平面上にあるので法線を固定する（自動推定は縮退入力で不安定）。
  tess.gluTessNormal(0, 0, 1);

  tess.gluTessBeginPolygon(null);
  for (const ring of rings) {
    if (ring.length < 3) continue;
    tess.gluTessBeginContour();
    for (const p of ring) tess.gluTessVertex([p.x, p.y, 0], [p.x, p.y, 0]);
    tess.gluTessEndContour();
  }
  tess.gluTessEndPolygon();

  if (failed || out.length === 0) return rings;
  return out;
}
