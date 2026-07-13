import type { Font } from "opentype.js";
import type { RGBA } from "../../core/schema";
import { parseTextProps } from "../textRender";
import { curveQualitySegments } from "./geom3dParams";
import { extrudeGeometry } from "./extrudeMesh";
import { releaseGeom3DGl, renderGeom3D } from "./geom3dGl";
import { getCachedMesh } from "./geom3dMeshCache";
import { textToOutlineGlyphs } from "./outlineProvider";
import type { Geom3DParams } from "./geom3dTypes";

/** DOM 上で geom3d canvas を識別するクラス（entry 削除時の GL 解放クエリ用・§entry-removal）。 */
export const GEOM3D_CANVAS_CLASS = "mafter-geom3d-canvas";

function ensureCanvas(el: HTMLElement): HTMLCanvasElement {
  let canvas = el.querySelector(`canvas.${GEOM3D_CANVAS_CLASS}`) as HTMLCanvasElement | null;
  if (!canvas) {
    // 2D（draft span / precise svg）の残置を掃除してから canvas を追加する
    // （renderPreciseText が draft→precise で行う textContent="" 全消去と同じ規約）。
    el.textContent = "";
    canvas = document.createElement("canvas");
    canvas.className = GEOM3D_CANVAS_CLASS;
    canvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
    el.appendChild(canvas);
  }
  return canvas;
}

/** 3D OFF へ戻すとき（または他コンポーネント型へ切替時）に canvas と GL リソースを掃除する。 */
export function clearGeom3DCanvas(el: HTMLElement): void {
  const canvas = el.querySelector(`canvas.${GEOM3D_CANVAS_CLASS}`) as HTMLCanvasElement | null;
  if (canvas) {
    releaseGeom3DGl(canvas);
    canvas.remove();
  }
}

const DEFAULT_RGBA: RGBA = { r: 1, g: 1, b: 1, a: 1 };

/**
 * §5.5f text の 3D 押し出し描画。system フォント（アウトライン抽出不可）のときは false を返し、
 * 呼び出し側が既存 2D 描画へフォールバックする（§26.4.1 と同じ制約）。
 */
export function applyGeom3DText(el: HTMLElement, props: Record<string, unknown>, font: Font | null, geom: Geom3DParams): boolean {
  if (!font) return false;
  const p = parseTextProps(props);
  const segments = curveQualitySegments(geom.curveQuality);
  const outline = textToOutlineGlyphs(
    { text: p.text, size: p.size, tracking: p.tracking, leading: p.leading, align: p.align, boxWidth: p.boxWidth, boxHeight: p.boxHeight },
    font,
    segments,
  );
  if (!outline) return false;

  const canvas = ensureCanvas(el);
  el.style.left = `${outline.minX}px`;
  el.style.top = `${outline.minY}px`;
  el.style.width = `${outline.width}px`;
  el.style.height = `${outline.height}px`;
  el.style.overflow = "visible";
  el.style.transform = "";

  const w = Math.max(1, Math.ceil(outline.width));
  const h = Math.max(1, Math.ceil(outline.height));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  const meshKey = [
    p.text, p.size, p.tracking, p.leading, p.align, p.boxWidth, p.boxHeight,
    typeof props["font"] === "string" ? props["font"] : "",
    geom.depth, geom.bevelSize, geom.bevelSegments, geom.curveQuality,
  ].join("|");
  const mesh = getCachedMesh(meshKey, () =>
    extrudeGeometry(outline.glyphs, { depth: geom.depth, bevelSize: geom.bevelSize, bevelSegments: geom.bevelSegments }),
  );

  const color = p.color ?? DEFAULT_RGBA;
  renderGeom3D(canvas, mesh, {
    width: w,
    height: h,
    baseColor: [color.r, color.g, color.b, color.a],
    lightDir: [geom.lightDir.x, geom.lightDir.y, geom.lightDir.z],
    ambient: geom.ambient,
  });
  return true;
}
