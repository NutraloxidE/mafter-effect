import type { Font } from "opentype.js";
import type { RGBA } from "../../core/schema";
import { parseTextProps } from "../textRender";
import { curveQualitySegments } from "./geom3dParams";
import { extrudeGeometry } from "./extrudeMesh";
import { releaseGeom3DGl, renderGeom3D } from "./geom3dGl";
import { getCachedMesh } from "./geom3dMeshCache";
import { textToOutlineGlyphs } from "./outlineProvider";
import type { Geom3DParams } from "./geom3dTypes";
import { multiply, normalMatrix, translation, type Mat4 } from "../mat4";

/** DOM 上で geom3d canvas を識別するクラス（entry 削除時の GL 解放クエリ用・§entry-removal）。 */
export const GEOM3D_CANVAS_CLASS = "mafter-geom3d-canvas";

// メッシュの字形は「要求した weight」ではなく「実際に使えた face」で決まる。asset フォントは
// 非同期ロードのため、要求 weight のアウトラインが未ロードの間は近傍 face で描画されうる。
// 要求 weight をキーにするとその暫定メッシュが本来の weight のキーで焼き付き、後からフォントが
// 届いても永久にキャッシュヒットしてしまう（= weight 変更が 3D に反映されない）。
const fontIds = new WeakMap<Font, number>();
let nextFontId = 1;

/** 実際に使われた Font インスタンスの安定 ID。face が差し替われば必ずキャッシュミスさせる。 */
function fontIdentity(font: Font): number {
  let id = fontIds.get(font);
  if (id === undefined) {
    id = nextFontId++;
    fontIds.set(font, id);
  }
  return id;
}

/** §5.5f-1 group canvas も同じ規約で作る（DomRenderer が host 単位でプールする）。 */
export function createGeom3DCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.className = GEOM3D_CANVAS_CLASS;
  canvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
  return canvas;
}

function ensureCanvas(el: HTMLElement): HTMLCanvasElement {
  let canvas = el.querySelector(`canvas.${GEOM3D_CANVAS_CLASS}`) as HTMLCanvasElement | null;
  if (!canvas) {
    // 2D（draft span / precise svg）の残置を掃除してから canvas を追加する
    // （renderPreciseText が draft→precise で行う textContent="" 全消去と同じ規約）。
    el.textContent = "";
    canvas = createGeom3DCanvas();
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
 * §5.5f 3D-extrude text に必要なカメラ/world/comp サイズ。DomRenderer の applyObject 呼び出し元が
 * 毎フレーム渡す（this.cameraPre・this.cameraFov は renderFrame で per-frame 更新済み）。
 */
export interface Geom3DCameraContext {
  /** §6.5b cameraPre = translate(cx,cy,P)·view。カメラ無し comp では null。 */
  cameraPre: Mat4 | null;
  /** cameraPre とペアの垂直画角（度）。cameraPre が null のときは無視される。 */
  fov: number | null;
  /** このオブジェクトの worldTransform（parent chain 込み・§4 座標系合成順）。 */
  world: Mat4;
  compW: number;
  compH: number;
  /**
   * §5.5f-1 canvas 共有: このレイヤーのメッシュを描く group canvas。null/未指定なら
   * 従来どおり `el` 内に per-layer canvas を確保する（geomShareCanvas=false の終端レイヤー）。
   */
  canvas?: HTMLCanvasElement | null;
  /** `canvas` 指定時のみ意味を持つ。true = この el が canvas の宿主。false = member（el は空にする）。 */
  isHost?: boolean;
  /**
   * このフレームで既に clear 済みの canvas 集合（呼び出し側がフレーム頭で作り直す）。
   * グループで最初に描いたメンバーだけが clear し、以降は depth buffer ごと追記する。
   */
  clearedCanvases?: Set<HTMLCanvasElement> | null;
}

/**
 * comp ピクセル空間 → clip 空間の投影行列（camera 有り）。DomRenderer.setupCameraRig の
 * `translate(cx,cy,P)·view` と CSS `perspective:${P}px` を数式的に再現し、CSS 3D リグと
 * 厳密に一致する投影を GL 側で行う（§6.5b の中立性: camera 無し・回転無し・depth=0 で 2D と一致、
 * を「実カメラで動いても一致し続ける」よう一般化したもの）。
 * 導出: Q = cameraPre·world·p = (Vx+cx, Vy+cy, Vz+P) とすると、CSS の perspective-origin
 * 中心透視除算は screen = center + (Q-center)·P/(P-Vz) を与える（P=focalP）。
 * これを NDC (screen→[-1,1]、Y反転込み) に変換し、Q の同次線形写像として解いた結果が下記行列。
 */
function perspectivePixelMvp(compW: number, compH: number, focalP: number): Mat4 {
  return [
    (2 * focalP) / compW, 0, 0, 0,
    0, (-2 * focalP) / compH, 0, 0,
    0, 0, -1, -1,
    -focalP, focalP, focalP, 2 * focalP,
  ];
}

/** camera 無し comp 用の正射影（CSS 側も perspective 無し＝z を無視した平面表示に一致）。 */
function orthoPixelMvp(compW: number, compH: number): Mat4 {
  return [
    2 / compW, 0, 0, 0,
    0, -2 / compH, 0, 0,
    0, 0, -1 / 10000, 0,
    -1, 1, 0, 1,
  ];
}

/**
 * §5.5f text の 3D 押し出し描画。system フォント（アウトライン抽出不可）のときは false を返し、
 * 呼び出し側が既存 2D 描画へフォールバックする（§26.4.1 と同じ制約）。
 *
 * P2 再設計: 固定内蔵カメラで焼いた平面を CSS matrix3d で傾ける近似をやめ、GL に
 * `mvp = Proj·cameraPre·worldTransform` を渡して実メッシュを投影する（呼び出し側が親 div の
 * CSS 3D transform を打ち消している前提）。canvas は comp 全域を devicePixelRatio 解像度で覆う
 * （AABB 最適化は将来課題・plan 補足参照）。
 */
export function applyGeom3DText(
  el: HTMLElement,
  props: Record<string, unknown>,
  font: Font | null,
  geom: Geom3DParams,
  camera: Geom3DCameraContext,
): boolean {
  if (!font) return false;
  const p = parseTextProps(props);
  const segments = curveQualitySegments(geom.curveQuality);
  const outline = textToOutlineGlyphs(
    { text: p.text, size: p.size, tracking: p.tracking, leading: p.leading, align: p.align, boxWidth: p.boxWidth, boxHeight: p.boxHeight },
    font,
    segments,
  );
  if (!outline) return false;

  // §5.5f-1 共有時、canvas は host レイヤーの el だけが宿す。member の el は空にして何も描かない
  // （ピクセルは host の div の z-index に出る — チェーンは連続する描画レイヤーに限られるため合成順は保たれる）。
  let canvas: HTMLCanvasElement;
  if (camera.canvas) {
    canvas = camera.canvas;
    if (camera.isHost) {
      if (canvas.parentElement !== el) {
        el.textContent = ""; // 2D（draft span / precise svg）の残置を掃除してから canvas を載せる
        el.appendChild(canvas);
      }
    } else if (el.firstChild) {
      el.textContent = "";
    }
  } else {
    canvas = ensureCanvas(el);
  }

  // el 自体は comp 原点に固定（親 div の CSS 3D transform は呼び出し側が打ち消す）。
  // 投影は GL 側の mvp が一手に担うため、el/canvas はスクリーン空間 2D 配置のみでよい。
  el.style.left = "0px";
  el.style.top = "0px";
  el.style.width = `${camera.compW}px`;
  el.style.height = `${camera.compH}px`;
  el.style.overflow = "visible";
  el.style.transform = "";

  const dpr = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const w = Math.max(1, Math.ceil(camera.compW));
  const h = Math.max(1, Math.ceil(camera.compH));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;

  // fontIdentity が字形の正体（family×weight×italic の解決結果）を表すため、要求 weight は
  // キーに含めない — 含めると未ロード時の暫定メッシュを本来の weight で焼き付けてしまう。
  const meshKey = [
    p.text, p.size, p.tracking, p.leading, p.align, p.boxWidth, p.boxHeight,
    fontIdentity(font),
    geom.depth, geom.bevelSize, geom.bevelStyle, geom.bevelSegments, geom.curveQuality,
  ].join("|");
  const mesh = getCachedMesh(meshKey, () =>
    extrudeGeometry(outline.glyphs, {
      depth: geom.depth,
      bevelSize: geom.bevelSize,
      bevelStyle: geom.bevelStyle,
      bevelSegments: geom.bevelSegments,
    }),
  );

  // outline のグリフ座標は content bbox 基準（font.getPath に -bounds.minX 済み）。
  // object のローカル原点（= worldTransform が仮定する座標系）へ戻すには (minX, minY) を足し戻す
  // ＝ 旧実装が div の left/top=minX/minY で行っていたのと同じ補正を world 側の平行移動で行う。
  const localOffset = translation(outline.minX, outline.minY, 0);
  const meshWorld = multiply(camera.world, localOffset);

  let mvp: Mat4;
  if (camera.cameraPre && camera.fov !== null) {
    const focalP = camera.compH / 2 / Math.tan((camera.fov * Math.PI) / 360);
    const proj = perspectivePixelMvp(camera.compW, camera.compH, focalP);
    mvp = multiply(proj, multiply(camera.cameraPre, meshWorld));
  } else {
    mvp = multiply(orthoPixelMvp(camera.compW, camera.compH), meshWorld);
  }

  const color = p.color ?? DEFAULT_RGBA;
  // clear の消費は「実際に描けたとき」だけ行う（フォント未ロード等で false 復帰したメンバーが
  // clear 権を持ち逃げすると、次のメンバーが前フレームの残像の上に描いてしまう）。
  const clear = !camera.clearedCanvases?.has(canvas);
  const drawn = renderGeom3D(canvas, mesh, {
    mvp,
    normalMatrix: normalMatrix(meshWorld),
    baseColor: [color.r, color.g, color.b, color.a],
    lightDirWorld: [geom.lightDir.x, geom.lightDir.y, geom.lightDir.z],
    ambient: geom.ambient,
    clear,
  });
  if (!drawn) return false;
  camera.clearedCanvases?.add(canvas);
  return true;
}
