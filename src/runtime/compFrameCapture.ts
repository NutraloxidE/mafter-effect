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
import { captureElementToCanvas } from "./rasterCapture";
import { canvasToPngBytes } from "./pngEncode";

export interface CompFrameCaptureContext {
  renderer: DomRenderer;
  evaluator: ExpressionEvaluator | undefined;
  container: HTMLElement;
  nw: number;
  nh: number;
  dispose: () => void;
}

export interface CompFrameCaptureOptions {
  textQuality: "draft" | "precise";
  proxyScale?: number;
}

function rgbaToHex(c: RGBA): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function compBackground(comp: TimelineComposition): string {
  return comp.background ? rgbaToHex(comp.background) : "#000000";
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
  const fontCache = new FontOutlineCache();
  const imageCache = new ImageAssetCache();
  await Promise.all([
    fontCache.loadFromProject(project, fs),
    imageCache.loadFromProject(project, fs),
  ]);
  renderer.setFontCache(fontCache);
  renderer.setImageCache(imageCache);
  renderer.setTextQuality(options.textQuality);
  renderer.mount(container, tlComp);
  renderer.resize(nw, nh);
  renderer.setHtmlComps(new Map(htmlComps.map((c) => [c.id, c])));
  renderer.setTimelineComps(new Map(timelineComps.map((c) => [c.id, c])));

  let evaluator: ExpressionEvaluator | undefined;
  await Promise.all([
    engine.prepare(tlComp).then(() => {
      evaluator = engine.makeEvaluator(tlComp);
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
  await ctx.renderer.flushRasterEffects();
  await nextTick();
  const bg = compBackground(comp);
  const canvas = await captureElementToCanvas(
    ctx.renderer.getRoot()!,
    ctx.nw,
    ctx.nh,
    bg,
    ctx.nw,
    ctx.nh,
  );
  return canvasToPngBytes(canvas);
}
