import { buildPrecompFrameCacheKey, precompFrameCachePrefix } from "../cache/precompFrameKey";
import { compContentHash } from "../cache/compContentHash";
import type { TieredCacheStore } from "../cache/types";
import type { Project, TimelineComposition } from "../core/schema";
import type { FileSystem } from "../fs/FileSystem";
import {
  captureCompFramePng,
  createCompFrameCaptureContext,
  type CompFrameCaptureContext,
  type NestedCompRasterizer,
} from "../runtime/compFrameCapture";
import { compNeedsAutoPreviewCache } from "./previewCompAnalysis";

interface PrecompRasterConfig {
  project: Project;
  fs: FileSystem;
  store: TieredCacheStore;
  quality: "draft" | "precise";
  proxyScale: number;
}

interface CtxEntry {
  ctx: CompFrameCaptureContext;
  key: string;
}

/**
 * §28.11 — precomp（ラスター化対象のネスト comp）を comp 単位でオフスクリーン画像化し、
 * content hash 基準でキャッシュするサービス。ライブプレビュー・RAM Preview・export の
 * 各キャプチャ経路が同一の `rasterizer` を共有し、レンダリング一致（INV-2）を保つ。
 */
class PrecompRasterService {
  private config: PrecompRasterConfig | null = null;
  private ctxByComp = new Map<string, CtxEntry>();
  private blobUrls = new Map<string, string>();
  /** comp(A) がラスター化対象か（compNeedsAutoPreviewCache）の memo。 */
  private rasterTargetMemo = new Map<string, boolean>();
  onFrameCached?: () => void;

  /** DomRenderer / compFrameCapture へ注入する rasterizer。 */
  readonly rasterizer: NestedCompRasterizer = {
    isRasterized: (compId) => this.isRasterized(compId),
    getRaster: (compId, childFrame) => this.getRaster(compId, childFrame),
  };

  configure(config: PrecompRasterConfig | null): void {
    const prev = this.config;
    this.config = config;
    if (!config) {
      this.disposeAllCtx();
      this.revokeBlobUrls();
      this.rasterTargetMemo.clear();
      return;
    }
    // project が変わったら raster 対象判定とキャプチャ ctx を作り直す（content hash で
    // どのフレームを再ラスタするかは getRaster 側のキーで決まる）。
    if (!prev || prev.project !== config.project) {
      this.rasterTargetMemo.clear();
    }
  }

  private findComp(compId: string): TimelineComposition | null {
    const c = this.config?.project.compositions.find((x) => x.id === compId);
    return c && c.kind === "timeline" ? (c as TimelineComposition) : null;
  }

  isRasterized(compId: string): boolean {
    if (!this.config) return false;
    const memo = this.rasterTargetMemo.get(compId);
    if (memo !== undefined) return memo;
    const comp = this.findComp(compId);
    const result = comp ? compNeedsAutoPreviewCache(comp) : false;
    this.rasterTargetMemo.set(compId, result);
    return result;
  }

  async getRaster(compId: string, childFrame: number): Promise<string | null> {
    const cfg = this.config;
    if (!cfg) return null;
    const comp = this.findComp(compId);
    if (!comp || !this.isRasterized(compId)) return null;

    const contentHash = compContentHash(cfg.project, compId);
    const key = buildPrecompFrameCacheKey({ compId, childFrame, contentHash });

    const cachedUrl = this.blobUrls.get(key);
    if (cachedUrl) return cachedUrl;

    const existing = await cfg.store.get(key);
    if (existing) return this.toBlobUrl(key, existing);

    let ctx: CompFrameCaptureContext;
    try {
      ctx = await this.ensureCtx(compId, contentHash);
    } catch {
      return null;
    }
    // ctx 構築中に config が差し替わっていないか確認。
    if (this.config !== cfg) return null;
    try {
      const png = await captureCompFramePng(ctx, comp, childFrame);
      await cfg.store.put(key, png, {
        byteSize: png.byteLength,
        width: ctx.nw,
        height: ctx.nh,
        format: "png",
      });
      this.onFrameCached?.();
      return this.toBlobUrl(key, png);
    } catch {
      return null;
    }
  }

  private toBlobUrl(key: string, data: Uint8Array): string {
    const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: "image/png" }));
    this.blobUrls.set(key, url);
    return url;
  }

  private async ensureCtx(compId: string, contentHash: string): Promise<CompFrameCaptureContext> {
    const cfg = this.config!;
    const comp = this.findComp(compId)!;
    const proxyMaxDim = Math.max(comp.width, comp.height);
    const ctxKey = [compId, contentHash, cfg.quality, cfg.proxyScale, proxyMaxDim].join("|");
    const entry = this.ctxByComp.get(compId);
    if (entry && entry.key === ctxKey) return entry.ctx;
    if (entry) entry.ctx.dispose();
    // ネストされたラスター comp（comp(A) 内の comp(C) 等）も同一 rasterizer で再帰描画する。
    const ctx = await createCompFrameCaptureContext(
      cfg.project,
      compId,
      cfg.fs,
      { textQuality: cfg.quality, proxyScale: cfg.proxyScale, proxyMaxDim },
      this.rasterizer,
    );
    this.ctxByComp.set(compId, { ctx, key: ctxKey });
    return ctx;
  }

  /** comp(A) を編集したときなどに該当 comp のキャッシュを破棄。 */
  async invalidate(compId: string): Promise<void> {
    this.rasterTargetMemo.delete(compId);
    const entry = this.ctxByComp.get(compId);
    if (entry) {
      entry.ctx.dispose();
      this.ctxByComp.delete(compId);
    }
    const prefix = precompFrameCachePrefix(compId);
    await this.config?.store.clear(prefix);
    for (const k of [...this.blobUrls.keys()]) {
      if (k.startsWith(prefix)) {
        URL.revokeObjectURL(this.blobUrls.get(k)!);
        this.blobUrls.delete(k);
      }
    }
  }

  private disposeAllCtx(): void {
    for (const { ctx } of this.ctxByComp.values()) ctx.dispose();
    this.ctxByComp.clear();
  }

  private revokeBlobUrls(): void {
    for (const url of this.blobUrls.values()) URL.revokeObjectURL(url);
    this.blobUrls.clear();
  }

  dispose(): void {
    this.disposeAllCtx();
    this.revokeBlobUrls();
    this.rasterTargetMemo.clear();
    this.config = null;
  }
}

export const precompRasterService = new PrecompRasterService();
