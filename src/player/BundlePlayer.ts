import { compositionDir } from "../core/paths";
import type { TimelineComposition } from "../core/schema";
import type { FileSystem } from "../fs/FileSystem";
import { registerBuiltinComponents } from "../runtime/builtinComponents";
import { registerBuiltinEffects } from "../runtime/builtinEffects";
import { DomRenderer } from "../runtime/DomRenderer";
import { ExpressionEngine } from "../runtime/expressionEngine";
import { FontOutlineCache } from "../runtime/fontOutlineCache";
import { HtmlCompPlayer } from "../runtime/htmlComp";
import { ImageAssetCache } from "../runtime/imageAssetCache";
import { ModuleLoader } from "../runtime/moduleLoader";
import { resolve, type ExpressionEvaluator } from "../runtime/resolve";
import type { BundleBootConfig } from "../runtime/bundleTypes";
import { htmlCompositionsInProject, timelineCompositionsInProject } from "../runtime/bundleCollect";
import { BundleAudioClock, hasAudioLayers } from "./BundleAudioClock";
import { assetUrlForBundle, buildBundleFs } from "./BundleFs";
import { applyFitTransform } from "./bundleFit";

/** §11.7 web bundle player — runtime + 音声クロックの薄いラッパ。 */
export class BundlePlayer {
  private readonly manifest: BundleBootConfig["manifest"];
  private readonly fs: FileSystem;
  private readonly renderer = new DomRenderer();
  private readonly fontCache = new FontOutlineCache();
  private readonly imageCache = new ImageAssetCache();
  private readonly loader: ModuleLoader;
  private readonly htmlLoader: ModuleLoader;
  private readonly htmlPlayer: HtmlCompPlayer;
  private readonly engine: ExpressionEngine;
  private evaluator: ExpressionEvaluator | undefined;
  private audioClock: BundleAudioClock | null = null;
  private comp: TimelineComposition | null = null;
  private currentFrame = 0;
  private playing = false;
  private rafId: number | null = null;
  private lastRafMs: number | null = null;
  private viewportEl: HTMLDivElement | null = null;
  private stageEl: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly config: BundleBootConfig) {
    this.manifest = config.manifest;
    this.fs = buildBundleFs(this.manifest);
    this.loader = new ModuleLoader(this.fs);
    this.htmlLoader = new ModuleLoader(this.fs);
    this.htmlPlayer = new HtmlCompPlayer(this.htmlLoader);
    this.engine = new ExpressionEngine(this.loader);
  }

  async start(): Promise<void> {
    registerBuiltinComponents();
    registerBuiltinEffects();

    const project = this.manifest.project;
    const comp = project.compositions.find(
      (c) => c.id === this.manifest.compId && c.kind === "timeline",
    ) as TimelineComposition | undefined;
    if (!comp) throw new Error("Bundle comp not found: " + this.manifest.compId);
    this.comp = comp;

    const htmlIds = new Set(
      project.compositions.filter((c) => c.kind === "html").map((c) => c.id),
    );
    const timelineIds = new Set(
      project.compositions.filter((c) => c.kind === "timeline").map((c) => c.id),
    );
    const htmlComps = htmlCompositionsInProject(project, htmlIds);
    const timelineComps = timelineCompositionsInProject(project, timelineIds).filter(
      (c) => c.id !== comp.id,
    );

    const urlForPath = (path: string) => assetUrlForBundle(this.manifest, path);
    await this.fontCache.loadFromProject(project, this.fs);
    this.imageCache.registerProjectUrls(project, urlForPath);
    await this.loadBundleFonts(project, urlForPath);

    this.renderer.setHtmlPlayer(this.htmlPlayer);
    this.renderer.setFontCache(this.fontCache);
    this.renderer.setImageCache(this.imageCache);
    this.renderer.setTextQuality(this.manifest.textRenderMode);
    this.renderer.setPreviewRenderOptions({});

    const { viewport, stage } = this.setupViewport(this.config.stage, comp);
    this.viewportEl = viewport;
    this.stageEl = stage;
    this.renderer.mount(stage, comp);
    this.renderer.resize(comp.width, comp.height);
    this.applyViewportFit();
    this.resizeObserver = new ResizeObserver(() => this.applyViewportFit());
    this.resizeObserver.observe(this.config.stage);

    this.renderer.setHtmlComps(new Map(htmlComps.map((c) => [c.id, c])));
    this.renderer.setTimelineComps(new Map(timelineComps.map((c) => [c.id, c])));

    await this.engine.prepare(comp);
    this.evaluator = this.engine.makeEvaluator(comp);
    await this.htmlPlayer.prepare(htmlComps, (id) => `${compositionDir(id)}/script.js`);

    const [rangeStart] = this.manifest.range;
    this.currentFrame = rangeStart;
    this.renderFrame(this.currentFrame);

    const hasAudio = hasAudioLayers(project, comp);
    if (hasAudio) {
      this.audioClock = new BundleAudioClock(
        this.manifest.fps,
        this.manifest.range[0],
        this.manifest.range[1],
        urlForPath,
        this.manifest.loop,
      );
      await this.audioClock.prepare(project, comp);
      this.audioClock.setFrameCallback((f) => {
        this.currentFrame = f;
        this.renderFrame(f);
      });
      this.audioClock.setEndedCallback(() => {
        this.playing = false;
      });
      this.audioClock.play(rangeStart);
      this.playing = true;
    } else {
      this.play(rangeStart);
    }
  }

  private async loadBundleFonts(
    project: typeof this.manifest.project,
    urlForPath: (path: string) => string,
  ): Promise<void> {
    for (const asset of project.assets) {
      if (asset.kind !== "font") continue;
      const family =
        typeof asset.meta?.family === "string"
          ? asset.meta.family
          : asset.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? asset.id;
      try {
        const face = new FontFace(family, `url(${urlForPath(asset.path)})`);
        await face.load();
        document.fonts.add(face);
      } catch {
        /* skip */
      }
    }
  }

  play(fromFrame?: number): void {
    if (this.audioClock) {
      this.audioClock.play(fromFrame ?? this.currentFrame);
      this.playing = true;
      return;
    }
    this.playing = true;
    this.lastRafMs = null;
    const start = fromFrame ?? this.currentFrame;
    this.currentFrame = start;
    const tick = (now: number) => {
      if (!this.playing || !this.comp) return;
      if (this.lastRafMs === null) {
        this.lastRafMs = now;
        this.rafId = requestAnimationFrame(tick);
        return;
      }
      const msPerFrame = 1000 / this.manifest.fps;
      const elapsed = now - this.lastRafMs;
      const advance = Math.floor(elapsed / msPerFrame);
      if (advance > 0) {
        this.lastRafMs = now - (elapsed % msPerFrame);
        const next = this.currentFrame + advance;
        const [, rangeEnd] = this.manifest.range;
        const lastFrame = rangeEnd - 1;
        if (next >= rangeEnd) {
          if (this.manifest.loop) {
            this.currentFrame = this.manifest.range[0];
          } else {
            this.playing = false;
            this.currentFrame = lastFrame;
            this.renderFrame(this.currentFrame);
            return;
          }
        } else {
          this.currentFrame = next;
        }
        this.renderFrame(this.currentFrame);
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  pause(): void {
    this.playing = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.audioClock?.pause();
  }

  dispose(): void {
    this.pause();
    this.audioClock?.dispose();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.renderer.dispose();
    this.htmlPlayer.dispose();
    if (this.viewportEl) {
      this.viewportEl.remove();
      this.viewportEl = null;
      this.stageEl = null;
    }
  }

  /** Preview §25.1 相当: ビューポート内に comp 全体をフィット表示。 */
  private setupViewport(
    host: HTMLElement,
    comp: TimelineComposition,
  ): { viewport: HTMLDivElement; stage: HTMLDivElement } {
    host.style.position = "relative";
    host.style.width = "100%";
    host.style.height = "100%";
    host.style.overflow = "hidden";

    const viewport = document.createElement("div");
    viewport.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;";

    const stage = document.createElement("div");
    stage.style.cssText = "position:absolute;left:0;top:0;overflow:hidden;";
    if (comp.background) {
      const c = comp.background;
      stage.style.background = `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;
    } else {
      stage.style.background = "#000";
    }

    viewport.appendChild(stage);
    host.appendChild(viewport);
    return { viewport, stage };
  }

  private applyViewportFit(): void {
    if (!this.stageEl || !this.comp) return;
    const host = this.config.stage;
    const vw = host.clientWidth;
    const vh = host.clientHeight;
    if (vw <= 0 || vh <= 0) return;
    applyFitTransform(this.stageEl, vw, vh, this.comp.width, this.comp.height);
  }

  private renderFrame(frame: number): void {
    if (!this.comp) return;
    const scene = resolve(this.comp, frame, { expressions: this.evaluator });
    this.renderer.renderFrame(scene, frame);
    void this.renderer.flushRasterEffects();
  }
}

export async function bootBundlePlayer(config: BundleBootConfig): Promise<BundlePlayer> {
  const player = new BundlePlayer(config);
  await player.start();
  return player;
}

declare global {
  interface Window {
    MafterPlayer?: {
      boot: (config: BundleBootConfig) => Promise<BundlePlayer>;
    };
  }
}

if (typeof window !== "undefined") {
  window.MafterPlayer = { boot: bootBundlePlayer };
}
