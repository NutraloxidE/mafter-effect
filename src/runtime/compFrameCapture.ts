// §28 / §11.2 — オフスクリーン comp フレームのラスタ化（exporter と RAM Preview 共有）。

import { compositionDir } from "../core/paths";
import type { HtmlComposition, Project, RGBA, TimelineComposition } from "../core/schema";
import type { FileSystem } from "../fs/FileSystem";
import { DomRenderer } from "./DomRenderer";
import { FontOutlineCache } from "./fontOutlineCache";
import { ImageAssetCache } from "./imageAssetCache";
import { ExpressionEngine } from "./expressionEngine";
import { HtmlCompPlayer } from "./htmlComp";
import { ModuleLoader } from "./moduleLoader";
import { resolve, type ExpressionEvaluator } from "./resolve";
import { compositeExportFrame } from "./exportComposite";
import { canvasToPngBytes } from "./pngEncode";

export interface CompFrameCaptureContext {
  renderer: DomRenderer;
  evaluator: ExpressionEvaluator | undefined;
  container: HTMLElement;
  nw: number;
  nh: number;
  dispose: () => void;
}

/**
 * §28.11 — ラスター化対象のネスト comp を comp 単位で画像化する rasterizer。
 * DomRenderer がネスト comp 描画時に参照する。`isRasterized` が真の comp は Phase-1
 * のライブ再解決ではなく `getRaster` の画像（blob URL）で描く。
 */
export interface NestedCompRasterizer {
  isRasterized(compId: string): boolean;
  getRaster(compId: string, childFrame: number): Promise<string | null>;
}

export interface CompFrameCaptureOptions {
  textQuality: "draft" | "precise";
  proxyScale?: number;
  /**
   * プレビュー専用: 画像アセットを長辺 proxyMaxDim まで縮小して読み込む。
   * 未指定なら原寸（RAM Preview は指定、bundle bake は full-res のため未指定）。
   */
  proxyMaxDim?: number;
}

function rgbaToHex(c: RGBA): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function compBackground(comp: TimelineComposition): string {
  // 未設定背景 = 透明。ネスト comp は親の上に透過合成される（§5.6）。
  return comp.background ? rgbaToHex(comp.background) : "transparent";
}

function nextTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * オフスクリーン DomRenderer を構築する。呼び出し側は `dispose()` 必須。
 */
export async function createCompFrameCaptureContext(
  project: Project,
  compId: string,
  fs: FileSystem,
  options: CompFrameCaptureOptions,
  nestedCompRasterizer?: NestedCompRasterizer,
): Promise<CompFrameCaptureContext> {
  const comp = project.compositions.find((c) => c.id === compId);
  if (!comp || comp.kind !== "timeline") {
    throw new Error("Timeline composition not found: " + compId);
  }
  const tlComp = comp as TimelineComposition;
  const htmlComps = project.compositions.filter(
    (c): c is HtmlComposition => c.kind === "html",
  );
  const timelineComps = project.compositions.filter(
    (c): c is TimelineComposition => c.kind === "timeline" && c.id !== compId,
  );

  const scale = options.proxyScale ?? 1;
  const nw = Math.max(1, Math.round(tlComp.width * scale));
  const nh = Math.max(1, Math.round(tlComp.height * scale));

  const container = document.createElement("div");
  container.style.cssText = `position:fixed;left:-${nw + 20}px;top:0;width:${nw}px;height:${nh}px;overflow:hidden;z-index:-99999;pointer-events:none;`;
  document.body.appendChild(container);

  const loader = new ModuleLoader(fs);
  const engine = new ExpressionEngine(loader);
  const htmlLoader = new ModuleLoader(fs);
  const player = new HtmlCompPlayer(htmlLoader);
  const renderer = new DomRenderer();
  renderer.setHtmlPlayer(player);
  // §27.4 / §28.11 — このコンテキストは foreignObject で静止画化される経路（RAM Preview /
  // precomp raster cache / bundle bake）専用。backdrop-filter は foreignObject で焼けないため、
  // exporter.ts と同様に Live 調整を exportComposite.ts のオフDOM z 順コンポジタで背面 master に焼く。
  renderer.setPreviewRenderOptions({ exportCompositeMode: true, exportVideoStep: true });
  const fontCache = new FontOutlineCache();
  const imageCache = new ImageAssetCache();
  await Promise.all([
    fontCache.loadFromProject(project, fs),
    imageCache.loadFromProject(project, fs, { proxyMaxDim: options.proxyMaxDim }),
  ]);
  renderer.setFontCache(fontCache);
  renderer.setImageCache(imageCache);
  renderer.setTextQuality(options.textQuality);
  renderer.mount(container, tlComp);
  renderer.resize(nw, nh);
  renderer.setHtmlComps(new Map(htmlComps.map((c) => [c.id, c])));
  renderer.setTimelineComps(new Map(timelineComps.map((c) => [c.id, c])));
  if (nestedCompRasterizer) renderer.setNestedCompRasterizer(nestedCompRasterizer);

  let evaluator: ExpressionEvaluator | undefined;
  await Promise.all([
    engine.prepare(tlComp).then(() => {
      evaluator = engine.makeEvaluator(tlComp);
    }),
    // §23.3c 補完: 深い階層（depth 2+）の live ネスト comp も expression を評価できるよう、
    // 捕捉対象以外の timeline comp 用 evaluator も用意して renderNestedComp へ注入する。
    Promise.all(timelineComps.map((c) => engine.prepare(c))).then(() => {
      renderer.setCompEvaluators(new Map(timelineComps.map((c) => [c.id, engine.makeEvaluator(c)])));
    }),
    player.prepare(htmlComps, (id) => `${compositionDir(id)}/script.js`),
  ]);

  return {
    renderer,
    evaluator,
    container,
    nw,
    nh,
    dispose: () => {
      renderer.dispose();
      container.remove();
    },
  };
}

/** 1 フレームを PNG バイト列にラスタ化する。 */
export async function captureCompFramePng(
  ctx: CompFrameCaptureContext,
  comp: TimelineComposition,
  frame: number,
): Promise<Uint8Array> {
  ctx.renderer.renderFrame(resolve(comp, frame, { expressions: ctx.evaluator }), frame);
  // レイヤ直付け raster の完了のみ待つ。調整合成は compositeExportFrame が行う。
  await ctx.renderer.flushRasterEffects();
  await ctx.renderer.flushVideoFrames();
  await nextTick();
  const bg = compBackground(comp);
  const canvas = await compositeExportFrame(ctx.renderer, ctx.nw, ctx.nh, ctx.nw, ctx.nh, bg);
  return canvasToPngBytes(canvas);
}
