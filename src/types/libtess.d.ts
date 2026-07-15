// libtess（SGI GLU tesselator の移植）は .d.ts を同梱しない。実体は UMD（libtess.min.js）で
// `module.exports = libtess` の単一オブジェクトのみを持ち、named export は存在しない。
// polygon-clipping で踏んだ事故（named import が Rollup 本番ビルドだけ undefined に落ち、
// bundle export が実行時クラッシュ）と同型のため、default import + オブジェクトのメンバ、
// という「実際の UMD 形」を型として補う（src/types/polygon-clipping.d.ts の判断を踏襲）。
//
// 宣言するのは §5.1 の輪郭正規化（normalizeRingsNonzero）が実際に使う API のみ。
declare module "libtess" {
  /** gluTessVertex / VERTEX_DATA コールバックでやり取りする座標（[x, y, z]）。 */
  type TessCoords = [number, number, number];

  interface GluTesselator {
    gluTessCallback(which: number, cb: (...args: never[]) => unknown): void;
    gluTessProperty(which: number, value: number | boolean): void;
    /** 入力を平面とみなす法線を固定し、tesselator による自動推定（縮退時に不安定）を避ける。 */
    gluTessNormal(x: number, y: number, z: number): void;
    gluTessBeginPolygon(data: unknown): void;
    gluTessBeginContour(): void;
    gluTessVertex(coords: TessCoords, data: TessCoords): void;
    gluTessEndContour(): void;
    gluTessEndPolygon(): void;
  }

  interface LibtessApi {
    GluTesselator: new () => GluTesselator;
    gluEnum: {
      GLU_TESS_BEGIN: number;
      GLU_TESS_VERTEX_DATA: number;
      GLU_TESS_END: number;
      GLU_TESS_COMBINE: number;
      GLU_TESS_ERROR: number;
      GLU_TESS_WINDING_RULE: number;
      GLU_TESS_BOUNDARY_ONLY: number;
    };
    windingRule: {
      GLU_TESS_WINDING_ODD: number;
      GLU_TESS_WINDING_NONZERO: number;
      GLU_TESS_WINDING_POSITIVE: number;
      GLU_TESS_WINDING_NEGATIVE: number;
      GLU_TESS_WINDING_ABS_GEQ_TWO: number;
    };
  }

  const libtess: LibtessApi;
  export default libtess;
}
