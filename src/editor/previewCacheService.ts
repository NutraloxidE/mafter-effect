import { parseCompFrameFromKey } from "../cache/compFrameKey";
import { compFrameCachePrefix } from "../cache/compFrameKey";
import { DefaultTieredCacheStore } from "../cache/tieredCacheStore";
import type { TieredCacheStore } from "../cache/types";
import { PreviewCacheDb } from "../fs/PreviewCacheDb";
import type { FileSystem } from "../fs/FileSystem";
import {
  RamPreviewController,
  type RamPreviewConfig,
} from "./ramPreview";
import {
  loadPreviewCacheSettings,
  type PreviewCacheSettings,
} from "./previewCacheSettings";
import type { WorkArea } from "./workAreaStorage";
import { TieredFrameRenderCache } from "../runtime/tieredFrameRenderCache";
import type { FrameRenderCache } from "../runtime/frameRenderCache";

type CachedFramesListener = (frames: Set<number>) => void;

/** §28 Preview + Timeline 共有のキャッシュサービス。 */
class PreviewCacheService {
  private store: TieredCacheStore | null = null;
  private controller: RamPreviewController | null = null;
  private frameRenderCache: FrameRenderCache | null = null;
  private listeners = new Set<CachedFramesListener>();
  private pollId: number | null = null;

  init(fs: FileSystem, settings: PreviewCacheSettings = loadPreviewCacheSettings()): void {
    if (this.store) return;
    const disk = new PreviewCacheDb();
    this.store = new DefaultTieredCacheStore({
      maxRamBytes: settings.maxRamMB * 1024 * 1024,
      diskEnabled: settings.enableDiskCache,
      disk,
    });
    this.controller = new RamPreviewController(this.store, fs, settings);
    this.controller.onFrameCached = () => void this.notifyCachedFrames();
    this.frameRenderCache = new TieredFrameRenderCache(this.store);
    this.startPolling();
  }

  getStore(): TieredCacheStore | null {
    return this.store;
  }

  getController(): RamPreviewController | null {
    return this.controller;
  }

  getFrameRenderCache(): FrameRenderCache | null {
    return this.frameRenderCache;
  }

  updateSettings(settings: PreviewCacheSettings): void {
    this.controller?.updateSettings(settings);
    if (this.store instanceof DefaultTieredCacheStore) {
      this.store.setMaxRamBytes(settings.maxRamMB * 1024 * 1024);
      this.store.setDiskEnabled(settings.enableDiskCache);
    }
  }

  updateConfig(config: RamPreviewConfig | null, workArea?: WorkArea): void {
    this.controller?.updateConfig(config, workArea);
    void this.notifyCachedFrames();
  }

  async clearAll(): Promise<void> {
    await this.store?.clear();
    void this.notifyCachedFrames();
  }

  subscribe(listener: CachedFramesListener): () => void {
    this.listeners.add(listener);
    void this.notifyCachedFrames();
    return () => this.listeners.delete(listener);
  }

  async listCachedFrames(): Promise<Set<number>> {
    if (!this.store || !this.controller) return new Set();
    const prefix = this.controller.getCompCachePrefix();
    if (!prefix) return new Set();
    const keys = await this.store.listKeys(prefix);
    const frames = new Set<number>();
    for (const key of keys) {
      const f = parseCompFrameFromKey(key);
      if (f !== null) frames.add(f);
    }
    return frames;
  }

  private startPolling(): void {
    if (this.pollId !== null) return;
    this.pollId = window.setInterval(() => {
      void this.notifyCachedFrames();
    }, 400);
  }

  private async notifyCachedFrames(): Promise<void> {
    const frames = await this.listCachedFrames();
    for (const l of this.listeners) l(frames);
  }

  dispose(): void {
    if (this.pollId !== null) window.clearInterval(this.pollId);
    this.pollId = null;
    this.controller?.dispose();
    this.controller = null;
    this.store = null;
    this.frameRenderCache = null;
    this.listeners.clear();
  }
}

export const previewCacheService = new PreviewCacheService();

export { compFrameCachePrefix };
