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
import { LAYER_FRAME_CACHE_PREFIX, parseLayerFrameKey } from "../cache/layerFrameKey";
import { PRECOMP_FRAME_CACHE_PREFIX, parsePrecompFrameKey } from "../cache/precompFrameKey";

type CachedFramesListener = (frames: Set<number>) => void;
/** objectId → そのレイヤーのキャッシュ済み local frame 集合（§28.10）。 */
type CachedLayerFramesListener = (layers: Map<string, Set<number>>) => void;
/** compId → その comp のキャッシュ済み childFrame 集合（§28.11 precomp）。 */
type CachedPrecompFramesListener = (comps: Map<string, Set<number>>) => void;

/** §28 Preview + Timeline 共有のキャッシュサービス。 */
class PreviewCacheService {
  private store: TieredCacheStore | null = null;
  private controller: RamPreviewController | null = null;
  private frameRenderCache: FrameRenderCache | null = null;
  private listeners = new Set<CachedFramesListener>();
  private layerListeners = new Set<CachedLayerFramesListener>();
  private precompListeners = new Set<CachedPrecompFramesListener>();
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

  /** §28.10: per-layer キャッシュ済み local frame マップを購読。 */
  subscribeLayerFrames(listener: CachedLayerFramesListener): () => void {
    this.layerListeners.add(listener);
    void this.notifyCachedLayerFrames();
    return () => this.layerListeners.delete(listener);
  }

  /** §28.10: objectId → キャッシュ済み local frame 集合。 */
  async listCachedLayerFrames(): Promise<Map<string, Set<number>>> {
    const result = new Map<string, Set<number>>();
    if (!this.store) return result;
    const keys = await this.store.listKeys(LAYER_FRAME_CACHE_PREFIX);
    for (const key of keys) {
      const parsed = parseLayerFrameKey(key);
      if (!parsed) continue;
      let set = result.get(parsed.objectId);
      if (!set) {
        set = new Set<number>();
        result.set(parsed.objectId, set);
      }
      set.add(parsed.localFrame);
    }
    return result;
  }

  /** §28.11: precomp キャッシュ済み childFrame マップを購読。 */
  subscribePrecompFrames(listener: CachedPrecompFramesListener): () => void {
    this.precompListeners.add(listener);
    void this.notifyCachedPrecompFrames();
    return () => this.precompListeners.delete(listener);
  }

  /** §28.11: compId → キャッシュ済み childFrame 集合。 */
  async listCachedPrecompFrames(): Promise<Map<string, Set<number>>> {
    const result = new Map<string, Set<number>>();
    if (!this.store) return result;
    const keys = await this.store.listKeys(PRECOMP_FRAME_CACHE_PREFIX);
    for (const key of keys) {
      const parsed = parsePrecompFrameKey(key);
      if (!parsed) continue;
      let set = result.get(parsed.compId);
      if (!set) {
        set = new Set<number>();
        result.set(parsed.compId, set);
      }
      set.add(parsed.childFrame);
    }
    return result;
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
      void this.notifyCachedLayerFrames();
      void this.notifyCachedPrecompFrames();
    }, 400);
  }

  private async notifyCachedFrames(): Promise<void> {
    const frames = await this.listCachedFrames();
    for (const l of this.listeners) l(frames);
  }

  private async notifyCachedLayerFrames(): Promise<void> {
    if (this.layerListeners.size === 0) return;
    const layers = await this.listCachedLayerFrames();
    for (const l of this.layerListeners) l(layers);
  }

  private async notifyCachedPrecompFrames(): Promise<void> {
    if (this.precompListeners.size === 0) return;
    const comps = await this.listCachedPrecompFrames();
    for (const l of this.precompListeners) l(comps);
  }

  dispose(): void {
    if (this.pollId !== null) window.clearInterval(this.pollId);
    this.pollId = null;
    this.controller?.dispose();
    this.controller = null;
    this.store = null;
    this.frameRenderCache = null;
    this.listeners.clear();
    this.layerListeners.clear();
    this.precompListeners.clear();
  }
}

export const previewCacheService = new PreviewCacheService();

export { compFrameCachePrefix };
