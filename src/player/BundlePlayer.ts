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
import { collectVideoClipsFromComp } from "../runtime/videoLookaheadWarmup";
import { runPreviewPlaybackLoop } from "../runtime/previewPlaybackLoop";
import {
  computePlaybackSyncState,
  filterPrimaryVideoSamples,
  holdThresholdsForFps,
  initialPlaybackSyncState,
  type PlaybackSyncState,
} from "../runtime/playbackVideoSync";

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
  private stopLoop: (() => void) | null = null;
  /** §11.4 双方向同期（no-audio 経路）— editor Preview パネルと同じ判定関数を使う。 */
  private syncState: PlaybackSyncState = initialPlaybackSyncState();
  private viewportEl: HTMLDivElement | null = null;
  private stageEl: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private autoplayUnlock: (() => void) | null = null;

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
    // video のみ blob URL 化（HTTP range 非対応サーバでの stall = もっさり回避・preview と同一再生）。
    await this.imageCache.loadVideoBlobsFromUrls(project, urlForPath);
    await this.loadBundleFonts(project, urlForPath);
    await this.loadBuiltinFonts(urlForPath);

    this.renderer.setHtmlPlayer(this.htmlPlayer);
    this.renderer.setFontCache(this.fontCache);
    this.renderer.setImageCache(this.imageCache);
    this.renderer.setTextQuality(this.manifest.textRenderMode);
    // §11.7 autoplay ブロック回避: 初回ユーザー操作までは video を muted のまま再生を進める
    // （unmute 付き play() は autoplay ポリシーで拒否され currentTime が凍結するため）。
    // installAutoplayUnlock() が最初のジェスチャーで false に切り替える。
    this.renderer.setPreviewRenderOptions({ muteVideoPlayback: true });

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
    this.renderer.setVideoLookaheadClips(collectVideoClipsFromComp(comp));

    await this.engine.prepare(comp);
    this.evaluator = this.engine.makeEvaluator(comp);
    // §23.3b: ネスト comp の expression も評価する（renderNestedComp は自前で resolve するため）。
    await Promise.all(timelineComps.map((c) => this.engine.prepare(c)));
    this.renderer.setCompEvaluators(
      new Map(timelineComps.map((c) => [c.id, this.engine.makeEvaluator(c)])),
    );
    await this.htmlPlayer.prepare(htmlComps, (id) => `${compositionDir(id)}/script.js`);

    const [rangeStart] = this.manifest.range;
    this.currentFrame = rangeStart;
    this.renderFrame(this.currentFrame);

    // §11.4: Play barrier — primed キャッシュを信用せず実要素を現フレームへ再同期してから再生。
    await this.renderer.syncMountedVideosForPlay(this.manifest.fps).catch(() => false);

    const hasAudio = hasAudioLayers(project, comp);
    if (hasAudio) {
      this.audioClock = new BundleAudioClock(
        this.manifest.fps,
        this.manifest.range[0],
        this.manifest.range[1],
        urlForPath,
        this.manifest.loop,
        {
          // §11.4 preview と同じ双方向同期（split-alpha companion は primary から除外済み）。
          getVideoClockSamples: () => filterPrimaryVideoSamples(this.renderer.sampleMountedVideoClocks()),
          onPlaybackSyncState: (s) => this.renderer.setPlaybackPauseForSync(s.pauseVideo),
        },
      );
      await this.audioClock.prepare(project, comp);
      this.audioClock.setFrameCallback((f) => {
        this.currentFrame = f;
        this.renderFrame(f);
      });
      this.audioClock.setEndedCallback(() => {
        this.playing = false;
        this.renderer.setPreviewRenderOptions({ previewVideoPlayback: false });
      });
      this.audioClock.play(rangeStart);
      this.playing = true;
      this.renderer.setPreviewRenderOptions({ previewVideoPlayback: true });
    } else {
      this.play(rangeStart);
    }

    // §11.4: ブラウザは「ユーザー操作なしの音声付き自動再生」を禁止するため、boot 時の
    // play() は拒否されうる（音が出ない・動画は無音で進む）。最初の任意操作（クリック/キー/
    // タップ）で音声+内蔵音声を確実に開始する。完全無操作の音声自動再生はブラウザ仕様上不可。
    this.installAutoplayUnlock();
  }

  /**
   * autoplay ブロック時の救済: window の最初のユーザー操作（pointerdown / keydown / touchstart）で
   * 音声レイヤーと video 内蔵音声を現在の再生位置から鳴らす。スペースバー限定ではなく任意操作で効く。
   * once 相当（最初の 1 回で listener を撤去）。ユーザー操作後はブラウザ制限が解除され、
   * 以降のレンダリングループ内 video.play() も成功する。
   */
  private installAutoplayUnlock(): void {
    if (this.autoplayUnlock || typeof window === "undefined") return;
    const types = ["pointerdown", "keydown", "touchstart"] as const;
    const handler = (): void => {
      if (this.playing) {
        // 音声レイヤー: pause 中（autoplay 拒否）の要素を現在位置から再生（tick は二重化しない）。
        this.audioClock?.unlock();
        // video 内蔵音声: ユーザー操作のコールスタック内で再描画 → syncVideoElementTime が
        // アンミュート play() を呼ぶ（この文脈なら play が許可される）。muteVideoPlayback を
        // 解除して初めて実際に unmute される（それまでは muted のまま無音再生が進んでいた）。
        this.renderer.setPreviewRenderOptions({ previewVideoPlayback: true, muteVideoPlayback: false });
        this.renderFrame(this.currentFrame);
      }
      this.removeAutoplayUnlock();
    };
    this.autoplayUnlock = () => {
      for (const t of types) window.removeEventListener(t, handler, true);
    };
    for (const t of types) window.addEventListener(t, handler, { capture: true, passive: true });
  }

  private removeAutoplayUnlock(): void {
    this.autoplayUnlock?.();
    this.autoplayUnlock = null;
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

  /** §26.3.2 zip 同梱の built-in フォントを family×weight で登録する。 */
  private async loadBuiltinFonts(urlForPath: (path: string) => string): Promise<void> {
    for (const f of this.manifest.builtinFonts ?? []) {
      try {
        const face = new FontFace(f.family, `url(${urlForPath(f.path)})`, {
          weight: String(f.weight),
        });
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
      this.renderer.setPreviewRenderOptions({ previewVideoPlayback: true });
      return;
    }
    this.playing = true;
    this.renderer.setPreviewRenderOptions({ previewVideoPlayback: true });
    this.syncState = initialPlaybackSyncState();
    this.stopLoop?.();
    const start = fromFrame ?? this.currentFrame;
    this.currentFrame = start;
    const [, rangeEnd] = this.manifest.range;
    this.stopLoop = runPreviewPlaybackLoop({
      fps: this.manifest.fps,
      loopStart: this.manifest.range[0],
      loopEnd: rangeEnd,
      loop: this.manifest.loop,
      initialFrame: start,
      renderFrame: (f) => this.renderFrame(f),
      onFrameChange: (f) => {
        this.currentFrame = f;
      },
      onPlaybackEnd: () => {
        this.playing = false;
      },
      // §11.4 preview と同じ双方向同期: 映像遅れでタイムライン全体を hold / 先行で video を pause。
      shouldHold: () => this.applyPlaybackSync(),
    });
  }

  /**
   * §11.4 双方向同期（no-audio 経路）: editor Preview パネルの applyPlaybackSync と同型。
   * サンプルは split-alpha companion 除外済みの primary のみで判定する。
   */
  private applyPlaybackSync(): boolean {
    this.syncState = computePlaybackSyncState(
      this.syncState,
      filterPrimaryVideoSamples(this.renderer.sampleMountedVideoClocks()),
      holdThresholdsForFps(this.manifest.fps),
      performance.now(),
    );
    this.renderer.setPlaybackPauseForSync(this.syncState.pauseVideo);
    return this.syncState.holdTimeline;
  }

  pause(): void {
    this.playing = false;
    this.renderer.setPreviewRenderOptions({ previewVideoPlayback: false });
    this.stopLoop?.();
    this.stopLoop = null;
    this.syncState = initialPlaybackSyncState();
    this.audioClock?.pause();
  }

  dispose(): void {
    this.pause();
    this.removeAutoplayUnlock();
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
    }
    // 未設定 = 透明。background を設定せず、ホストページの地が透けるようにする（§5.6）。

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
