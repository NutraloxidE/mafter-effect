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
import type { PreviewCacheSettings } from "./previewCacheSettings";
import type { WorkArea } from "./workAreaStorage";

export type PreviewCacheDisplayStatus =
  | { kind: "idle" }
  | { kind: "off" }
  | { kind: "realtime" }
  | { kind: "cached"; hitRate: number }
  | { kind: "building"; progress: number };

export interface RamPreviewConfig {
  project: Project;
  comp: TimelineComposition;
  projectRevision: number;
  quality: "draft" | "precise";
  proxy: ResolutionProxy;
  proxyScale: number;
  workArea: WorkArea;
}

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
  private readonly frameQueue = new FrameCacheQueue();
  onFrameCached?: () => void;

  constructor(
    private store: TieredCacheStore,
    private fs: FileSystem,
    settings: PreviewCacheSettings,
  ) {
    this.settings = settings;
  }

  updateSettings(settings: PreviewCacheSettings): void {
    const wasEnabled = this.settings.enabled;
    this.settings = settings;
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
    if (shouldForceNonRealtime(this.config.quality, this.config.proxy, this.config.comp)) {
      return true;
    }
    if (!this.detector.hasEnoughSamples()) return false;
    return !this.detector.isRealtimeCapable(this.config.comp.fps);
  }

  /** スクラブで live 表示したフレームを最優先でキャッシュ。 */
  cacheScrubbedFrame(frame: number): void {
    this.enqueueFrame(frame, "scrub");
  }

  /** 再生中ミスフレームをキャッシュ（background より優先）。 */
  cachePlaybackFrame(frame: number): void {
    this.enqueueFrame(frame, "playback");
  }

  private enqueueFrame(frame: number, priority: "scrub" | "playback" | "background"): void {
    if (!this.settings.enabled || !this.config) return;
    this.frameQueue.enqueue(frame, priority);
    this.pumpCacheQueue();
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
    if (!this.settings.enabled) return { kind: "off" };
    if (!this.config) return { kind: "idle" };
    if (this.buildTotal > 0 && this.buildProgress < this.buildTotal) {
      return { kind: "building", progress: this.buildProgress / this.buildTotal };
    }
    if (this.frameQueue.pendingCount() > 0 && !this.isRealtimeCapable()) {
      const denom = Math.max(1, this.buildTotal || this.frameQueue.pendingCount());
      return { kind: "building", progress: this.buildProgress / denom };
    }
    if (isPlaying && this.shouldUseCacheForPlayback() && this.playbackAttempts > 0) {
      return { kind: "cached", hitRate: this.playbackHits / this.playbackAttempts };
    }
    if (this.isRealtimeCapable() && this.detector.hasEnoughSamples()) {
      return { kind: "realtime" };
    }
    return { kind: "idle" };
  }

  startBackgroundBuildIfNeeded(): void {
    if (!this.settings.enabled || !this.config) return;
    if (this.isRealtimeCapable()) return;
    const { start, end } = this.getBuildRange();
    const total = Math.max(0, end - start);
    if (total === 0) return;
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
      const png = await captureCompFramePng(ctx, this.config.comp, frame);
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
      { textQuality: this.config.quality, proxyScale: this.config.proxyScale, proxyMaxDim },
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
