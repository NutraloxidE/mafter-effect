import { buildCompFrameCacheKey, compFrameCachePrefix } from "../cache/compFrameKey";
import { FrameCacheQueue } from "../cache/frameCacheQueue";
import type { TieredCacheStore } from "../cache/types";
import { DefaultTieredCacheStore } from "../cache/tieredCacheStore";
import type { Project, TimelineComposition } from "../core/schema";
import type { FileSystem } from "../fs/FileSystem";
import type { ResolutionProxy } from "./previewViewer";
import {
  captureCompFramePng,
  createCompFrameCaptureContext,
  type CompFrameCaptureContext,
} from "../runtime/compFrameCapture";
import {
  RealtimeDetector,
  shouldForceNonRealtime,
} from "./realtimeDetector";
import { compNeedsAutoPreviewCache } from "./previewCompAnalysis";
import { precompRasterService } from "./precompRasterService";
import type { PreviewCacheSettings } from "./previewCacheSettings";
import type { WorkArea } from "./workAreaStorage";
import type { RemotePreviewRequest } from "../swarm/cache/distributedPreviewCache";
import type { SwarmRenderResult } from "../swarm/core/types";

export type PreviewCacheDisplayStatus =
  | { kind: "idle" }
  | { kind: "off" }
  | { kind: "realtime" }
  | { kind: "cached"; hitRate: number; autoCache?: boolean }
  | { kind: "building"; progress: number; autoCache?: boolean };

export interface RamPreviewConfig {
  project: Project;
  comp: TimelineComposition;
  projectRevision: number;
  quality: "draft" | "precise";
  proxy: ResolutionProxy;
  proxyScale: number;
  workArea: WorkArea;
}

export type RemotePreviewRenderer = (request: RemotePreviewRequest) => Promise<SwarmRenderResult | null>;

export class RamPreviewController {
  private config: RamPreviewConfig | null = null;
  private settings: PreviewCacheSettings;
  private detector = new RealtimeDetector();
  private captureCtx: CompFrameCaptureContext | null = null;
  private captureCtxKey = "";
  private buildProgress = 0;
  private buildTotal = 0;
  private buildRange: { start: number; end: number } | null = null;
  private playbackHits = 0;
  private playbackAttempts = 0;
  private blobUrlCache = new Map<string, string>();
  private localCaptureChain: Promise<void> = Promise.resolve();
  /** Rolling cost of one local frame, used to size how long a worker may keep a frame. */
  private localFrameMs = 0;
  private readonly frameQueue = new FrameCacheQueue();
  /** §28.4 — 再生中は bake 休止（読み取りのみ）。 */
  private playbackActive = false;
  /** §28.9 session 限定 Auto Preview Cache。 */
  private autoCacheSession = false;
  onFrameCached?: () => void;
  private remoteRenderer: RemotePreviewRenderer | null = null;

  constructor(
    private store: TieredCacheStore,
    private fs: FileSystem,
    settings: PreviewCacheSettings,
  ) {
    this.settings = settings;
  }

  setRemoteRenderer(renderer: RemotePreviewRenderer | null, remoteCapacity = 0): void {
    this.remoteRenderer = renderer;
    // Local capture stays serial (one CPU); remote frames may overlap, one per connected worker.
    this.frameQueue.setConcurrency(renderer ? 1 + Math.max(0, remoteCapacity) : 1);
  }

  updateSettings(settings: PreviewCacheSettings): void {
    const wasEnabled = this.settings.enabled;
    this.settings = settings;
    if (!settings.enabled) {
      this.autoCacheSession = false;
    }
    if (this.store instanceof DefaultTieredCacheStore) {
      this.store.setMaxRamBytes(settings.maxRamMB * 1024 * 1024);
      this.store.setDiskEnabled(settings.enableDiskCache);
    }
    if (wasEnabled && !settings.enabled) {
      this.abortBuild();
    }
  }

  updateConfig(config: RamPreviewConfig | null, workArea?: WorkArea): void {
    if (!config) {
      this.config = null;
      this.abortBuild();
      this.revokeBlobUrls();
      return;
    }
    const merged: RamPreviewConfig = workArea
      ? { ...config, workArea }
      : config;

    const prev = this.config;
    const compChanged = !prev || merged.comp.id !== prev.comp.id;
    const qualityChanged = !prev || merged.quality !== prev.quality;
    const proxyChanged = !prev || merged.proxy !== prev.proxy;
    const revisionChanged = !prev || merged.projectRevision !== prev.projectRevision;
    const workAreaChanged = !prev
      || merged.workArea.inPoint !== prev.workArea.inPoint
      || merged.workArea.outPoint !== prev.workArea.outPoint;

    if (compChanged && prev) {
      void this.invalidateComp(prev.comp.id);
    }
    if (revisionChanged && prev && merged.comp.id === prev.comp.id) {
      void this.invalidateComp(merged.comp.id);
      this.revokeBlobUrls();
      this.abortBuild();
    }

    if (compChanged || qualityChanged || proxyChanged) {
      this.detector.reset();
    }
    this.detector.setForcedNonRealtime(
      shouldForceNonRealtime(merged.quality, merged.proxy, merged.comp),
    );

    this.config = merged;
    if (compChanged || qualityChanged || proxyChanged || workAreaChanged) {
      this.abortBuild();
    }
  }

  getCompCachePrefix(): string | null {
    if (!this.config) return null;
    return compFrameCachePrefix(this.config.comp.id);
  }

  getBuildRange(): { start: number; end: number } {
    if (!this.config) return { start: 0, end: 0 };
    const { inPoint, outPoint } = this.config.workArea;
    return { start: inPoint, end: Math.max(inPoint + 1, outPoint) };
  }

  onProjectRevisionChange(_revision: number): void {
    /* handled via updateConfig */
  }

  /** §28.9 — 重い comp 再生開始時に session 限定で Caching を有効化。 */
  setAutoCacheSession(active: boolean): void {
    this.autoCacheSession = active;
  }

  isAutoCacheSession(): boolean {
    return this.autoCacheSession;
  }

  recordLiveRenderMs(ms: number): void {
    this.detector.recordRenderMs(ms);
  }

  isRealtimeCapable(): boolean {
    if (!this.config || !this.settings.enabled) return true;
    if (shouldForceNonRealtime(this.config.quality, this.config.proxy, this.config.comp)) {
      return false;
    }
    return this.detector.isRealtimeCapable(this.config.comp.fps);
  }

  shouldUseCacheForPlayback(): boolean {
    return this.shouldPreferCacheDisplay();
  }

  shouldPreferCacheDisplay(): boolean {
    if (!this.settings.enabled || !this.config) return false;
    if (this.autoCacheSession && compNeedsAutoPreviewCache(this.config.comp)) {
      return true;
    }
    if (shouldForceNonRealtime(this.config.quality, this.config.proxy, this.config.comp)) {
      return true;
    }
    if (!this.detector.hasEnoughSamples()) return false;
    return !this.detector.isRealtimeCapable(this.config.comp.fps);
  }

  /**
   * §28.4 — 再生中の overlay はワークエリア build 完了後のみ。
   * 未完了時は live（bake と競合させない・hit/miss フリッカー回避）。
   */
  shouldPreferCacheOverlay(isPlaying: boolean): boolean {
    if (!this.shouldPreferCacheDisplay()) return false;
    if (!isPlaying) return true;
    return this.isWorkAreaBuildComplete();
  }

  /** ワークエリア全フレームが bake 済みか（progress 完了）。 */
  isWorkAreaBuildComplete(): boolean {
    return this.buildTotal > 0 && this.buildProgress >= this.buildTotal;
  }

  /**
   * §28.4 — 再生中はキャッシュ書き込みを pause。停止後に pump / build 再開。
   */
  setPlaybackActive(playing: boolean): void {
    if (this.playbackActive === playing) return;
    this.playbackActive = playing;
    this.frameQueue.setPaused(playing);
    if (!playing) {
      if (this.frameQueue.pendingCount() > 0) {
        this.pumpCacheQueue();
      } else if (!this.isWorkAreaBuildComplete()) {
        this.startBackgroundBuildIfNeeded();
      }
    }
  }

  isPlaybackActive(): boolean {
    return this.playbackActive;
  }

  /** スクラブで live 表示したフレームを最優先でキャッシュ。 */
  cacheScrubbedFrame(frame: number): void {
    this.enqueueFrame(frame, "scrub");
  }

  /** 再生中ミスフレームをキャッシュ（background より優先）。再生中は no-op。 */
  cachePlaybackFrame(frame: number): void {
    this.enqueueFrame(frame, "playback");
  }

  private enqueueFrame(frame: number, priority: "scrub" | "playback" | "background"): void {
    if (!this.settings.enabled || !this.config) return;
    // §28.4 pauses baking during playback so it cannot steal CPU from live rendering. Remote
    // workers do not compete for it, so they may keep filling the cache while playback runs.
    if (this.playbackActive && !this.remoteRenderer) return;
    this.frameQueue.enqueue(frame, priority);
    this.pumpCacheQueue();
  }

  /**
   * Stores a remote frame that arrived after its deadline. The revision guard keeps a frame from
   * an older project state out of the cache; a late frame for the current state is still correct.
   */
  async acceptLateRemoteFrame(renderRevision: string, frame: number, png: Uint8Array, width: number, height: number): Promise<void> {
    if (!this.settings.enabled || !this.config) return;
    if (renderRevision !== `project-revision-${this.config.projectRevision}`) return;
    const key = this.frameCacheKey(frame);
    if (!key || await this.store.get(key)) return;
    await this.store.put(key, png, { byteSize: png.byteLength, width, height, format: "png" });
    this.onFrameCached?.();
  }

  frameCacheKey(frame: number): string | null {
    if (!this.config) return null;
    const pw = Math.max(1, Math.round(this.config.comp.width * this.config.proxyScale));
    const ph = Math.max(1, Math.round(this.config.comp.height * this.config.proxyScale));
    return buildCompFrameCacheKey({
      compId: this.config.comp.id,
      frame,
      projectRevision: this.config.projectRevision,
      quality: this.config.quality,
      proxy: this.config.proxy,
      width: pw,
      height: ph,
    });
  }

  async getCachedBlobUrl(frame: number): Promise<string | null> {
    const key = this.frameCacheKey(frame);
    if (!key) return null;
    const cached = this.blobUrlCache.get(key);
    if (cached) return cached;
    const data = await this.store.get(key);
    if (!data) return null;
    const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: "image/png" }));
    this.blobUrlCache.set(key, url);
    return url;
  }

  notePlaybackFrame(hit: boolean): void {
    this.playbackAttempts += 1;
    if (hit) this.playbackHits += 1;
  }

  getDisplayStatus(isPlaying: boolean): PreviewCacheDisplayStatus {
    const autoCache = this.autoCacheSession;
    if (!this.settings.enabled) return { kind: "off" };
    if (!this.config) return { kind: "idle" };
    if (this.buildTotal > 0 && this.buildProgress < this.buildTotal) {
      return { kind: "building", progress: this.buildProgress / this.buildTotal, autoCache };
    }
    if (this.frameQueue.pendingCount() > 0 && !this.isRealtimeCapable()) {
      const denom = Math.max(1, this.buildTotal || this.frameQueue.pendingCount());
      return { kind: "building", progress: this.buildProgress / denom, autoCache };
    }
    if (isPlaying && this.shouldUseCacheForPlayback() && this.playbackAttempts > 0) {
      return { kind: "cached", hitRate: this.playbackHits / this.playbackAttempts, autoCache };
    }
    if (this.isRealtimeCapable() && this.detector.hasEnoughSamples()) {
      return { kind: "realtime" };
    }
    return { kind: "idle" };
  }

  startBackgroundBuildIfNeeded(): void {
    if (!this.settings.enabled || !this.config) return;
    if (this.playbackActive && !this.remoteRenderer) return;
    // A realtime-capable comp needs no local cache, but building it on idle workers is free for
    // the host and makes later scrubbing instant.
    if (this.isRealtimeCapable() && !this.remoteRenderer) return;
    const { start, end } = this.getBuildRange();
    const total = Math.max(0, end - start);
    if (total === 0) return;
    // 既に同一レンジで進行中なら再 enqueue しない（progress 二重加算を避ける）。
    if (
      this.buildRange
      && this.buildRange.start === start
      && this.buildRange.end === end
      && this.buildTotal === total
      && (this.frameQueue.pendingCount() > 0 || this.buildProgress >= this.buildTotal)
    ) {
      this.pumpCacheQueue();
      return;
    }
    this.buildRange = { start, end };
    this.buildTotal = total;
    this.frameQueue.enqueueRange(start, end, "background");
    this.pumpCacheQueue();
  }

  abortBuild(): void {
    this.frameQueue.abort();
    this.buildProgress = 0;
    this.buildTotal = 0;
    this.buildRange = null;
    void this.disposeCaptureCtx();
  }

  async invalidateComp(compId: string): Promise<void> {
    await this.store.clear(compFrameCachePrefix(compId));
    for (const key of [...this.blobUrlCache.keys()]) {
      if (key.startsWith(compFrameCachePrefix(compId))) {
        URL.revokeObjectURL(this.blobUrlCache.get(key)!);
        this.blobUrlCache.delete(key);
      }
    }
  }

  dispose(): void {
    this.abortBuild();
    this.revokeBlobUrls();
  }

  private revokeBlobUrls(): void {
    for (const url of this.blobUrlCache.values()) URL.revokeObjectURL(url);
    this.blobUrlCache.clear();
    this.playbackHits = 0;
    this.playbackAttempts = 0;
  }

  private pumpCacheQueue(): void {
    if (this.playbackActive && !this.remoteRenderer) return;
    this.frameQueue.pump((frame, gen) => this.processCacheFrame(frame, gen));
  }

  private async processCacheFrame(frame: number, gen: number): Promise<void> {
    if (!this.settings.enabled || !this.config || gen !== this.frameQueue.getGeneration()) return;
    const key = this.frameCacheKey(frame);
    if (!key) return;

    const existing = await this.store.get(key);
    if (!this.settings.enabled || gen !== this.frameQueue.getGeneration()) return;
    if (existing) {
      this.bumpBuildProgress(frame);
      return;
    }

    if (this.remoteRenderer) {
      try {
        const remote = await this.remoteRenderer({
          // A worker is at best a few times faster than this host, so allow several local frame
          // costs before giving up; a fixed short deadline discards heavy frames every time.
          timeoutMs: this.localFrameMs > 0 ? this.localFrameMs * 4 : 0,
          project: this.config.project,
          comp: this.config.comp,
          projectRevision: this.config.projectRevision,
          frame,
          quality: this.config.quality,
          proxy: this.config.proxy,
          width: Math.max(1, Math.round(this.config.comp.width * this.config.proxyScale)),
          height: Math.max(1, Math.round(this.config.comp.height * this.config.proxyScale)),
        });
        if (remote && gen === this.frameQueue.getGeneration()) {
          const text = atob(remote.bytesBase64);
          const png = new Uint8Array(text.length);
          for (let i = 0; i < text.length; i += 1) png[i] = text.charCodeAt(i);
          await this.store.put(key, png, {
            byteSize: png.byteLength,
            width: remote.width,
            height: remote.height,
            format: "png",
          });
          this.onFrameCached?.();
          this.bumpBuildProgress(frame);
          return;
        }
      } catch {
        /* remote workers are optional; the local capture below remains authoritative */
      }
    }

    // Falling through to a local capture during playback would reintroduce exactly the CPU
    // contention §28.4 avoids; remote-only baking is the point of continuing here.
    if (this.playbackActive) return;

    // With remote pumping the queue runs several frames at once; local captures share one
    // capture context and must not overlap.
    const previous = this.localCaptureChain;
    let release = (): void => {};
    this.localCaptureChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await this.captureFrameLocally(frame, gen, key);
    } finally {
      release();
    }
  }

  private async captureFrameLocally(frame: number, gen: number, key: string): Promise<void> {
    if (!this.settings.enabled || !this.config || gen !== this.frameQueue.getGeneration()) return;
    let ctx: CompFrameCaptureContext | null;
    try {
      ctx = await this.ensureCaptureCtx();
    } catch {
      return;
    }
    if (!this.settings.enabled || !ctx || gen !== this.frameQueue.getGeneration()) return;

    const pw = ctx.nw;
    const ph = ctx.nh;
    try {
      const startedAt = performance.now();
      const png = await captureCompFramePng(ctx, this.config.comp, frame);
      const elapsed = performance.now() - startedAt;
      this.localFrameMs = this.localFrameMs === 0 ? elapsed : this.localFrameMs + 0.25 * (elapsed - this.localFrameMs);
      if (gen !== this.frameQueue.getGeneration()) return;
      await this.store.put(key, png, {
        byteSize: png.byteLength,
        width: pw,
        height: ph,
        format: "png",
      });
      this.onFrameCached?.();
      this.bumpBuildProgress(frame);
    } catch {
      /* skip failed frame */
    }
  }

  private bumpBuildProgress(frame: number): void {
    if (!this.buildRange) return;
    if (frame >= this.buildRange.start && frame < this.buildRange.end) {
      this.buildProgress = Math.min(this.buildTotal, this.buildProgress + 1);
    }
  }

  private async ensureCaptureCtx(): Promise<CompFrameCaptureContext | null> {
    if (!this.config) return null;
    // プレビュー専用: 画像アセットを comp 解像度（長辺）まで縮小して
    // foreignObject キャプチャの直列化/再デコードコストを抑える。export は別経路で full-res。
    const proxyMaxDim = Math.max(this.config.comp.width, this.config.comp.height);
    const key = [
      this.config.comp.id,
      this.config.projectRevision,
      this.config.quality,
      this.config.proxy,
      proxyMaxDim,
    ].join("|");
    if (this.captureCtx && this.captureCtxKey === key) return this.captureCtx;
    await this.disposeCaptureCtx();
    this.captureCtx = await createCompFrameCaptureContext(
      this.config.project,
      this.config.comp.id,
      this.fs,
      // キャッシュ PNG は live preview との parity を優先し、常に precise テキストで焼く。
      { textQuality: "precise", proxyScale: this.config.proxyScale, proxyMaxDim },
      // §28.11 — comp 全体キャッシュもライブと同じ rasterizer でネスト comp を焼き、一致させる。
      precompRasterService.rasterizer,
    );
    this.captureCtxKey = key;
    return this.captureCtx;
  }

  private async disposeCaptureCtx(): Promise<void> {
    this.captureCtx?.dispose();
    this.captureCtx = null;
    this.captureCtxKey = "";
  }
}
