// polygon-clipping の同梱 .d.ts は named export（union/intersection/xor/difference）を宣言しているが、
// 実際の ESM ビルド（dist/polygon-clipping.esm.js）は `export { index as default }` のみで
// named export を持たない。Vite dev / vitest（Node の CJS 相互運用）では named import でも動くが、
// player.js の本番 Rollup ビルドでは「'union' is not exported」警告と共に undefined に落ちる
// （bundle export で Boolean shape が実行時クラッシュする重大なサイレント破損）。
// default import + 実体は default オブジェクトのメソッド、という「実際の ESM 形」を型として補う。
declare module "polygon-clipping" {
  interface PolygonClippingApi {
    union(geom: Polygon | MultiPolygon, ...geoms: (Polygon | MultiPolygon)[]): MultiPolygon;
    intersection(geom: Polygon | MultiPolygon, ...geoms: (Polygon | MultiPolygon)[]): MultiPolygon;
    xor(geom: Polygon | MultiPolygon, ...geoms: (Polygon | MultiPolygon)[]): MultiPolygon;
    difference(subjectGeom: Polygon | MultiPolygon, ...clipGeoms: (Polygon | MultiPolygon)[]): MultiPolygon;
  }
  const polygonClippingDefault: PolygonClippingApi;
  export default polygonClippingDefault;
}
