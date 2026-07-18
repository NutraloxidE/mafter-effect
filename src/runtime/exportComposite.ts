// §27.4 / §27.4.1 — mp4 / png / precomp raster 用のオフDOM・ステートレス合成。
//
// 旧 export 経路（DomRenderer の forceAdjustmentRaster bake）は live DOM を毎フレーム破壊的に
// 操作（visibility トグル + raster overlay + フレーム間 raster 使い回し）していたため、非同期競合で
// 前フレームの状態が混入して「ちらつき」を生んだ。本モジュールは live render DOM を一切変更せず、
// z 昇順に累積 master canvas を組み、調整レイヤー到達点で master（= 確定済み背面ピクセル）に
// effect chain を適用する。毎フレーム fresh に組むためフレーム間状態が無く、原理的にちらつかない。
//
// §6.5b カメラ: perspective / perspective-origin は **root** に、preserve-3d も root に付く。preview では
// 全レイヤがこの perspective root の子なので、3D 層は perspective 射影され、2D 層（z=0）は無影響になる。
// よってレイヤを root から切り離して個別 capture すると 3D 層の perspective が落ちて「カメラが効いて
// いない」フレームが混入する（＝カメラのちらつき）。これを避けるため、各レイヤを **root と同じ
// perspective / perspective-origin を持つラッパ div** に入れて capture する。実測で root 一括 capture と
// 一致（同一 std）し、2D 層には無影響（perspective は 2D transform を変えない）。
//
// §23.3d / §27.4.1 軸1 ネスト comp: foreignObject ラスタ化は `backdrop-filter` を落とすため、ネスト
// comp 内の調整レイヤーは親の単一 capture では消える。そこで「調整 / CSS blend を含むネスト comp」は
// 子 comp 自身の座標系で同じ z 順コンポジタに**再帰的に**掛けて1枚の画像へ確定（precomp = 1枚・
// non-collapse）してから親レイヤーへ置く。renderNestedComp は export 時、調整 div に backdrop-filter を
// 立てず exportChain をレイヤメタ（__exportLayer）として付与し、コンテナに __nestedComposite を付ける。
// 調整も blend も無いネスト comp は従来どおり親の単一 capture に含める（3D 文脈保持の高速経路）。

import { captureElementToCanvas, flattenShadow, inlineExportMedia, svgToDataUrl } from "./rasterCapture";
import { type FilterRegion } from "./effectRaster";
import { Canvas2DCompositor } from "./compositor/Canvas2DCompositor";
import { WebGl2Compositor, canUseWebGl2Compositor } from "./compositor/WebGL2Compositor";
import { isGpuCompositorEnabled } from "./compositor/gpuCompositorFlag";
import { isGpuEffectSupported } from "./compositor/gpuEffectRegistry";
import { globalPluginRegistry } from "./pluginRegistry";
import type { ResolvedEffect } from "./resolved";
import type { BlendMode } from "../core/schema";

const XHTML = "http://www.w3.org/1999/xhtml";

/** ネスト comp コンテナに付与する属性。`"1"` = 子内に調整 / CSS blend があり再帰合成が必要。 */
export const NESTED_COMPOSITE_ATTR = "data-nested-composite";

/** §27.4 調整レイヤーの解決済み effect chain（exportComposite が背面 master に適用する）。 */
export interface ExportChain {
  /** raster section より前の CSS/SVG filter token（`url(#id)` 含む）。 */
  preFilterStr: string;
  preSvgFilters: { id: string; primitives: string }[];
  /** raster section より後の CSS/SVG filter token。 */
  postFilterStr: string;
  postSvgFilters: { id: string; primitives: string }[];
  /** raster 実行 effect（pixelSorter / 完全 displacement 等）。Live 調整では空。 */
  rasterChain: { effect: ResolvedEffect; def: NonNullable<ReturnType<typeof globalPluginRegistry.getEffectDef>> }[];
  region: FilterRegion;
  /** ctx.frame（raster chain の決定論評価に使用）。 */
  frame: number;
}

/** §27.4.1 z 順合成用のレイヤ記述。 */
export interface ExportLayer {
  div: HTMLElement;
  blendMode: BlendMode;
  isAdjustment: boolean;
  /** 調整レイヤーのみ非 null。 */
  exportChain: ExportChain | null;
}

/** §23.3d ネスト comp コンテナのメタ（renderNestedComp が export 時に付与）。 */
export interface NestedCompositeMeta {
  /** true = 子内に調整 / CSS blend（または再帰的に持つ子）があり、子を1枚へ確定する必要がある。 */
  needsComposite: boolean;
  perspective: string;
  perspectiveOrigin: string;
  width: number;
  height: number;
  /** 子 comp 背景（"transparent" or rgba(...)）。 */
  background: string;
}

/** export 合成のため DomRenderer / renderNestedComp が DOM 要素に付与するメタ。 */
export interface ExportTaggedElement extends HTMLElement {
  __exportLayer?: ExportLayer;
  __nestedComposite?: NestedCompositeMeta;
}

/** getExportLayers / hasAdjustmentLayers / hasCssBlendLayers / hasNestedComposite を備えた最小レンダラ面。 */
export interface ExportCompositeSource {
  getRoot(): HTMLElement | null;
  getExportLayers(): ExportLayer[];
  hasAdjustmentLayers(): boolean;
  hasCssBlendLayers(): boolean;
  /** 現フレームに「再帰合成が必要なネスト comp」があるか（高速経路を外す判定）。 */
  hasNestedComposite(): boolean;
  /** 現フレームに threeD レイヤーがあるか（高速経路を外す判定）。 */
  hasThreeDContent(): boolean;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** cloned レイヤを perspective ラッパ + foreignObject SVG 経由で 1 枚 canvas にラスタ化する。 */
async function rasterizeClonedLayer(
  cloned: HTMLElement,
  perspective: string,
  perspectiveOrigin: string,
  nw: number,
  nh: number,
): Promise<HTMLCanvasElement> {
  const inner = new XMLSerializer().serializeToString(cloned);
  const content = perspective
    ? `<div xmlns="${XHTML}" style="position:absolute;top:0;left:0;width:${nw}px;height:${nh}px;`
      + `perspective:${perspective};perspective-origin:${perspectiveOrigin}">${inner}</div>`
    : inner;
  const svgStr = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${nw}" height="${nh}">`,
    `<foreignObject x="0" y="0" width="${nw}" height="${nh}">`,
    content,
    `</foreignObject>`,
    `</svg>`,
  ].join("");
  const img = new Image();
  img.src = svgToDataUrl(svgStr);
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("export layer rasterization failed"));
  });
  const canvas = makeCanvas(nw, nh);
  canvas.getContext("2d")!.drawImage(img, 0, 0);
  return canvas;
}

/**
 * レイヤ div を root と同じ perspective context のラッパに入れて 1 枚 capture する（transparent 背景）。
 * `perspective` が空（カメラ無し）ならラッパ無しで素の capture。3D 層は perspective で射影され、
 * 2D 層（z=0 transform）は無影響。canvas ビットマップは live の layer div から inline（クローンは空のため）。
 */
export async function captureLayerWithPerspective(
  layerDiv: HTMLElement,
  perspective: string,
  perspectiveOrigin: string,
  nw: number,
  nh: number,
): Promise<HTMLCanvasElement> {
  const cloned = flattenShadow(layerDiv) as HTMLElement;
  cloned.setAttribute("xmlns", XHTML);
  await inlineExportMedia(cloned, layerDiv);
  // §5.4f: トラックマットは fillHost 内の destination-in/out（マット子を含む）。
  // クローンにマット子が入っていれば isolation 内 blend が foreignObject で焼ける。
  return rasterizeClonedLayer(cloned, perspective, perspectiveOrigin, nw, nh);
}

/** root 直下から見て「他の composite コンテナに含まれない」最外殻の composite コンテナだけを返す。 */
function outermostComposites(root: HTMLElement): ExportTaggedElement[] {
  const all = [...root.querySelectorAll(`[${NESTED_COMPOSITE_ATTR}="1"]`)] as ExportTaggedElement[];
  return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
}

/** ネスト comp コンテナ直下の __exportLayer 子を z 昇順で返す。 */
function readContainerLayers(container: HTMLElement): ExportLayer[] {
  const layers: { layer: ExportLayer; z: number }[] = [];
  for (const child of [...container.children] as HTMLElement[]) {
    const meta = (child as ExportTaggedElement).__exportLayer;
    if (!meta) continue;
    layers.push({ layer: meta, z: Number(child.style.zIndex) || 0 });
  }
  layers.sort((a, b) => a.z - b.z);
  return layers.map((l) => l.layer);
}

/**
 * §23.3d / §27.4.1 軸1 — ネスト comp コンテナを子 comp 自身の座標系で1枚へ確定する（再帰）。
 * 子内の調整は背面 master へ焼かれ、子レイヤの blend / 深い子 comp も解決される。
 */
async function compositeContainer(
  container: HTMLElement,
  meta: NestedCompositeMeta,
): Promise<HTMLCanvasElement> {
  const nw = Math.max(1, Math.round(meta.width));
  const nh = Math.max(1, Math.round(meta.height));
  const compositor = new Canvas2DCompositor(nw, nh, meta.background);
  for (const layer of readContainerLayers(container)) {
    if (layer.isAdjustment) {
      if (layer.exportChain) await compositor.applyAdjustment(layer.exportChain, nw, nh);
      continue;
    }
    const sub = await captureLayerNode(layer.div, meta.perspective, meta.perspectiveOrigin, nw, nh);
    compositor.drawLayer(sub, layer.blendMode);
  }
  return compositor.finish();
}

/**
 * 通常レイヤを capture する。レイヤ subtree に「再帰合成が必要なネスト comp」があれば、
 * そのコンテナを子座標系で先に確定 → クローン側でコンテナ中身を確定画像 <img> に差し替えてから
 * capture する（live DOM 非破壊・ステートレス）。無ければ従来の perspective capture。
 */
async function captureLayerNode(
  layerDiv: HTMLElement,
  perspective: string,
  perspectiveOrigin: string,
  nw: number,
  nh: number,
): Promise<HTMLCanvasElement> {
  const liveComposites = outermostComposites(layerDiv);
  if (liveComposites.length === 0) {
    return captureLayerWithPerspective(layerDiv, perspective, perspectiveOrigin, nw, nh);
  }

  const cloned = flattenShadow(layerDiv) as HTMLElement;
  cloned.setAttribute("xmlns", XHTML);
  // 先に live canvas を inline（クローンと live は同一構造なので index 整合）。差し替えは後。
  await inlineExportMedia(cloned, layerDiv);

  // live ↔ clone の composite コンテナを document order で対応付け（同一構造なので index 一致）。
  const liveAll = [...layerDiv.querySelectorAll(`[${NESTED_COMPOSITE_ATTR}="1"]`)] as ExportTaggedElement[];
  const cloneAll = [...cloned.querySelectorAll(`[${NESTED_COMPOSITE_ATTR}="1"]`)] as HTMLElement[];
  for (let i = 0; i < liveAll.length; i++) {
    const lc = liveAll[i]!;
    if (!liveComposites.includes(lc)) continue; // 最外殻のみ（内側は compositeContainer の再帰で解決）
    const cmeta = lc.__nestedComposite;
    const cloneContainer = cloneAll[i];
    if (!cmeta || !cloneContainer) continue;
    const sub = await compositeContainer(lc, cmeta);
    const img = document.createElement("img");
    img.setAttribute("src", sub.toDataURL("image/png"));
    img.setAttribute("width", String(Math.max(1, Math.round(cmeta.width))));
    img.setAttribute("height", String(Math.max(1, Math.round(cmeta.height))));
    img.setAttribute("style", "position:absolute;top:0;left:0;width:100%;height:100%;object-fit:fill");
    cloneContainer.replaceChildren(img);
  }

  return rasterizeClonedLayer(cloned, perspective, perspectiveOrigin, nw, nh);
}

/**
 * 1 フレームを comp ネイティブ解像度 (nw×nh) で合成し、必要なら (w×h) へスケールした canvas を返す。
 *
 * - 調整レイヤーも CSS blend も「再帰合成が必要なネスト comp」も無ければ単一ショット root capture
 *   （最速・3D 深度 / perspective 完全保持）。
 * - それ以外は z 昇順に各レイヤを perspective ラッパ付きで個別 capture → master へ blend 合成、
 *   調整レイヤー到達点で master（= 確定背面）に effect chain を適用。ネスト comp 内の調整は
 *   captureLayerNode が子座標系で再帰的に確定する。live DOM 非破壊・ステートレス。
 */
export async function compositeExportFrame(
  src: ExportCompositeSource,
  nw: number,
  nh: number,
  w: number,
  h: number,
  bg: string,
): Promise<HTMLCanvasElement> {
  const root = src.getRoot();
  if (!root) throw new Error("compositeExportFrame: no root");

  // 高速経路: 調整 / blend / 再帰合成 / threeD が無いフレームは root を 1 枚 capture。
  // threeD は per-layer perspective capture が必要（root 一括 foreignObject は 3D を潰す）。
  if (
    !src.hasAdjustmentLayers()
    && !src.hasCssBlendLayers()
    && !src.hasNestedComposite()
    && !src.hasThreeDContent()
  ) {
    return captureElementToCanvas(root, nw, nh, bg, w, h);
  }

  const perspective = root.style.perspective;
  const perspectiveOrigin = root.style.perspectiveOrigin || "50% 50%";
  const layers = src.getExportLayers();

  // §Phase 2/3a/4 GPU 経路（flag ON かつ WebGL2 対応時のみ）:
  //   - normal blend: fixed-function 高速パス（Phase 2）
  //   - 非 normal 15 blend: ping-pong shader パス（Phase 3a）
  //   - adjustment: chain が GPU 可能（CSS/SVG filter 無し + rasterChain 全 effect に GPU pass あり・
  //     現状 mosaic のみ）なフレームのみ GPU（Phase 4）。それ以外の adjustment は丸ごと Canvas2D（CPU bridge）。
  // GPU 対象フレームは capture を先に集めてから合成するので、GL 失敗時は同じ capture/op 列で Canvas2D へ
  // 無コスト fallback できる（再 capture 不要）。matte は capture 段で焼込済（責務外）。
  const gpuEligible =
    isGpuCompositorEnabled()
    && canUseWebGl2Compositor()
    && layers.every((l) => !l.isAdjustment || (l.exportChain != null && isGpuAdjustmentChain(l.exportChain)));

  let master: HTMLCanvasElement;
  if (gpuEligible) {
    const ops: GpuOp[] = [];
    for (const layer of layers) {
      if (layer.isAdjustment) {
        if (layer.exportChain) ops.push({ kind: "adjust", chain: layer.exportChain });
        continue;
      }
      ops.push({
        kind: "draw",
        canvas: await captureLayerNode(layer.div, perspective, perspectiveOrigin, nw, nh),
        blendMode: layer.blendMode,
      });
    }
    master = await compositeGpuOps(ops, nw, nh, bg);
  } else {
    const compositor = new Canvas2DCompositor(nw, nh, bg);
    for (const layer of layers) {
      if (layer.isAdjustment) {
        if (layer.exportChain) await compositor.applyAdjustment(layer.exportChain, nw, nh);
        continue;
      }
      const sub = await captureLayerNode(layer.div, perspective, perspectiveOrigin, nw, nh);
      compositor.drawLayer(sub, layer.blendMode);
    }
    master = compositor.finish();
  }

  if (w === nw && h === nh) return master;
  const scaled = makeCanvas(w, h);
  scaled.getContext("2d")!.drawImage(master, 0, 0, w, h);
  return scaled;
}

/** z 順の GPU 合成オペレーション（capture 済みレイヤ描画 or 調整 chain 適用）。 */
type GpuOp =
  | { kind: "draw"; canvas: HTMLCanvasElement; blendMode: BlendMode }
  | { kind: "adjust"; chain: ExportChain };

/**
 * adjustment の effect chain が GPU で実行可能か。CSS/SVG filter（pre/post）を持たず、rasterChain の
 * 全 effect に GPU pass がある（現状 mosaic のみ）場合に true（§7 案A・chain 単位で全落ち or 全 GPU）。
 * rasterChain が空（純 CSS filter 調整など）は false → CPU へ（GPU 化しても無意味）。
 */
function isGpuAdjustmentChain(chain: ExportChain): boolean {
  if (chain.preFilterStr || chain.postFilterStr) return false;
  if (chain.rasterChain.length === 0) return false;
  return chain.rasterChain.every((e) => isGpuEffectSupported(e.effect.type));
}

/**
 * z 順 op 列を 1 枚へ GPU 合成する。全 op が normal draw なら Phase 2 の fixed-function 高速パス、
 * 非 normal blend / adjustment を含めば ping-pong パス（Phase 3a/4）。GL 失敗時は同じ op 列で
 * Canvas2D へ fallback する（挙動は許容差内一致・parity harness で検証）。
 */
async function compositeGpuOps(
  ops: GpuOp[],
  nw: number,
  nh: number,
  bg: string,
): Promise<HTMLCanvasElement> {
  const hasAdjust = ops.some((o) => o.kind === "adjust");
  const allNormalDraw = !hasAdjust && ops.every((o) => o.kind === "draw" && o.blendMode === "normal");
  try {
    const gl = new WebGl2Compositor(nw, nh, bg);
    if (allNormalDraw) {
      for (const o of ops) if (o.kind === "draw") gl.drawLayer(o.canvas, "normal");
    } else {
      for (const o of ops) {
        if (o.kind === "draw") gl.drawLayerBlend(o.canvas, o.blendMode);
        else await gl.applyAdjustment(o.chain, nw, nh);
      }
    }
    return gl.finish();
  } catch {
    WebGl2Compositor.releaseLock();
    const cpu = new Canvas2DCompositor(nw, nh, bg);
    for (const o of ops) {
      if (o.kind === "draw") cpu.drawLayer(o.canvas, o.blendMode);
      else await cpu.applyAdjustment(o.chain, nw, nh);
    }
    return cpu.finish();
  }
}
