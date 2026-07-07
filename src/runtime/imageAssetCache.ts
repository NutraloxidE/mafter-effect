import type { Project } from "../core/schema";
import { normalizePath, type FileSystem } from "../fs/FileSystem";
import { videoMimeFromPath } from "./videoAssetProbe";
import type { FootageQuality } from "./footageQuality";
import { isProxyTier } from "./footageQuality";
import { decodeVideoBlobUrl } from "./videoBlobDecode";

export interface ImageSize {
  width: number;
  height: number;
}

interface ImageEntry {
  url: string;
  size: ImageSize;
}

export interface ImageLoadOptions {
  /**
   * プレビュー専用: 画像の長辺がこのピクセル数に収まるよう縮小した data URL を生成する。
   * 未指定なら原寸 data URL（export / bundle 経路）。`getSize()` は常に原寸を返すため
   * CSS レイアウト・選択バウンディングボックス・export 一致（INV-2）は不変。
   */
  proxyMaxDim?: number;
  /**
   * §Phase3: 初期表示 comp が参照する asset を先に読み込むための優先集合
   * （`collectReferencedAssetIds` 参照）。**ロード順序だけ**に影響し、`byId`/`byPath` の
   * 最終内容・project.json 直列化とは無関係（INV 非影響）。
   */
  priorityAssetIds?: ReadonlySet<string>;
}

/** IndexedDbFs 固有の一括読み込み（他 FS には存在しない、duck-typed optional method）。 */
interface FsWithReadBatch {
  readBatch(paths: string[]): Promise<Map<string, Uint8Array>>;
}

function hasReadBatch(fs: FileSystem): fs is FileSystem & FsWithReadBatch {
  return typeof (fs as Partial<FsWithReadBatch>).readBatch === "function";
}

/** §Phase3: メインスレッドに Layout/Paint の隙間を与える（起動フリーズ防止）。 */
function yieldToFrame(): Promise<void> {
  return new Promise((r) =>
    typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => r()) : setTimeout(r, 0),
  );
}

const LOAD_BATCH_SIZE = 3;

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

/**
 * Phase 0 計測ハーネス（probe-preview-startup.mjs）専用の performance mark/measure。
 * `performance` 未対応環境（Node テスト等）では no-op。scene 解決値・挙動には一切影響しない（INV-1）。
 */
function markPreviewStartup(name: string): void {
  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    performance.mark(name);
  }
}

function measurePreviewStartup(name: string, start: string, end: string): void {
  if (typeof performance !== "undefined" && typeof performance.measure === "function") {
    try {
      performance.measure(name, start, end);
    } catch {
      /* marks missing (e.g. cleared) — ignore, probe tolerates absent measures */
    }
  }
}

let previewCacheRef: ImageAssetCache | null = null;

/** PreviewPanel がマウント時に登録。Footage 削除で blob URL を即解放する。 */
export function registerPreviewImageCache(cache: ImageAssetCache | null): void {
  previewCacheRef = cache;
}

export function evictPreviewMediaAsset(assetId: string): void {
  previewCacheRef?.evictAsset(assetId);
}

/**
 * §16.2b — PreviewPanel の imageCacheRef 以外（Inspector 等）から、evict 直後に明示リロードする
 * ための薄いラッパ。`byPath` キャッシュは既存 asset をヒットすると `loadProxiesFromFs` を
 * 再実行しないため、`ensureProxyTier` 完了「後」に `evictPreviewMediaAsset` → この関数、の順で
 * 呼ばないと新しい proxy が preview に反映されない（実機検証で確認済みのレース対策と同型）。
 */
export async function reloadPreviewMediaFromProject(
  project: Project,
  fs: FileSystem,
  options?: ImageLoadOptions,
): Promise<void> {
  await previewCacheRef?.loadFromProject(project, fs, options);
}

/** §16.2 split alpha — color + 別 WebM マスク（Chrome 等 VP9 alpha 非対応時）。 */
export function isSplitAlphaVideoMeta(meta: Record<string, unknown> | undefined): boolean {
  return (
    meta?.hasAlpha === true &&
    meta?.alphaMode === "split" &&
    typeof meta?.alphaPath === "string" &&
    meta.alphaPath.length > 0
  );
}

/** §2.2 packed alpha — color 直下に grayscale mask を上下パックした 1 本の動画。 */
export function isPackedAlphaVideoMeta(meta: Record<string, unknown> | undefined): boolean {
  return (
    meta?.hasAlpha === true &&
    meta?.alphaMode === "packed" &&
    meta?.packedLayout === "topBottom" &&
    typeof meta?.contentHeight === "number" &&
    meta.contentHeight > 0 &&
    typeof meta?.gutterPx === "number" &&
    meta.gutterPx >= 0
  );
}

/** packed asset meta から §2.2 の PackedAlphaLayout を取り出す（isPackedAlphaVideoMeta 済み前提）。 */
export function packedAlphaLayoutFromMeta(
  meta: Record<string, unknown> | undefined,
): { contentHeight: number; gutterPx: number } | null {
  if (!isPackedAlphaVideoMeta(meta)) return null;
  return { contentHeight: meta!.contentHeight as number, gutterPx: meta!.gutterPx as number };
}

/** asset 画像の data: URL / 動画の blob: URL と natural size キャッシュ。 */
export class ImageAssetCache {
  private readonly byId = new Map<string, ImageEntry>();
  private readonly byPath = new Map<string, ImageEntry>();
  private readonly blobUrls = new Set<string>();
  /** §16.2 split alpha 用 companion マスク video URL（assetId → url）。 */
  private readonly alphaUrlById = new Map<string, string>();
  /** §2.2 packed alpha レイアウト（assetId → layout・原本）。 */
  private readonly packedLayoutById = new Map<string, { contentHeight: number; gutterPx: number }>();
  // §11.4b assetId → proxy tier → entry。映像のみ（音声は常に原本）。
  private readonly proxyById = new Map<string, Map<string, ImageEntry>>();
  /**
   * §16.2b packed proxy — assetId → tier → 縮小後 layout。原本 packed proxy は content サイズが
   * 原本と異なる（縮小されている）ため、URL と同じ quality で必ず同時に引かないと合成 rect が破綻する
   * （getUrlForQuality と対で getPackedAlphaLayoutForQuality を使うこと）。
   */
  private readonly packedProxyLayoutById = new Map<string, Map<string, { contentHeight: number; gutterPx: number }>>();

  getUrl(assetId: string): string | null {
    return this.byId.get(assetId)?.url ?? null;
  }

  /**
   * §11.4b 画質ティアに応じた映像 URL。プロキシ tier かつ読み込み済みならプロキシ、
   * 無ければ原本（getUrl）へフォールバック（footagePlayback.resolveFootageVideoPath と同規則・INV-2）。
   */
  getUrlForQuality(assetId: string, quality: FootageQuality): string | null {
    if (isProxyTier(quality)) {
      const url = this.proxyById.get(assetId)?.get(quality)?.url;
      if (url) return url;
    }
    return this.getUrl(assetId);
  }

  getSize(assetId: string): ImageSize | null {
    return this.byId.get(assetId)?.size ?? null;
  }

  /** §16.2 split alpha companion マスク video の blob URL。 */
  getAlphaVideoUrl(assetId: string): string | null {
    return this.alphaUrlById.get(assetId) ?? null;
  }

  /** §2.2 packed alpha レイアウト（原本・無ければ null＝packed 資産ではない）。 */
  getPackedAlphaLayout(assetId: string): { contentHeight: number; gutterPx: number } | null {
    return this.packedLayoutById.get(assetId) ?? null;
  }

  /**
   * §16.2b — quality に対応する packed alpha レイアウトを返す。proxy tier かつ proxy layout が
   * 登録済みならその縮小 layout、それ以外（`original` / proxy 未生成）は原本 layout にフォールバック。
   * `getUrlForQuality(assetId, quality)` と必ず同じ quality で対にして呼ぶこと（URL と layout が
   * 別 quality だと合成 rect が videoWidth/Height を超えて破綻する）。
   */
  getPackedAlphaLayoutForQuality(
    assetId: string,
    quality: FootageQuality,
  ): { contentHeight: number; gutterPx: number } | null {
    if (isProxyTier(quality)) {
      const proxyLayout = this.packedProxyLayoutById.get(assetId)?.get(quality);
      if (proxyLayout) return proxyLayout;
    }
    return this.getPackedAlphaLayout(assetId);
  }

  /** import 時に確定した meta から size を返す（cache 未ロード時の bounds 用）。 */
  static sizeFromMeta(meta: Record<string, unknown> | undefined): ImageSize | null {
    if (!meta) return null;
    const w = meta.width;
    const h = meta.height;
    if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) {
      return { width: w, height: h };
    }
    return null;
  }

  /** project.assets の image / video を FS から読み込む。 */
  async loadFromProject(project: Project, fs: FileSystem, options?: ImageLoadOptions): Promise<void> {
    markPreviewStartup("mafter:loadFromProject:start");
    try {
      await this.loadFromProjectImpl(project, fs, options);
    } finally {
      markPreviewStartup("mafter:loadFromProject:end");
      measurePreviewStartup(
        "mafter:loadFromProject",
        "mafter:loadFromProject:start",
        "mafter:loadFromProject:end",
      );
    }
  }

  private async loadFromProjectImpl(
    project: Project,
    fs: FileSystem,
    options?: ImageLoadOptions,
  ): Promise<void> {
    const proxyMaxDim = options?.proxyMaxDim;
    const priority = options?.priorityAssetIds;
    // proxy 設定ごとに別キャッシュ（full-res と縮小版の取り違えを防ぐ）。
    const cacheKey = (path: string, kind: string) => `${kind}|${proxyMaxDim ?? "full"}|${path}`;

    const candidates = project.assets.filter((a) => a.kind === "image" || a.kind === "video");
    // §Phase3: 優先集合を安定ソートで先頭へ（元配列・byId/byPath の最終内容は不変・順序のみ変更）。
    const ordered = priority && priority.size > 0
      ? [
          ...candidates.filter((a) => priority.has(a.id)),
          ...candidates.filter((a) => !priority.has(a.id)),
        ]
      : candidates;

    for (let i = 0; i < ordered.length; i += LOAD_BATCH_SIZE) {
      const batch = ordered.slice(i, i + LOAD_BATCH_SIZE);
      await this.loadAssetBatch(batch, fs, proxyMaxDim, cacheKey);
      // 最終バッチの後は無駄な yield をしない。
      if (i + LOAD_BATCH_SIZE < ordered.length) await yieldToFrame();
    }
  }

  /** §Phase3: バッチ単位で読み込み（IndexedDbFs なら 1 tx の readBatch、他 FS は並列 fs.read）。 */
  private async loadAssetBatch(
    batch: Project["assets"],
    fs: FileSystem,
    proxyMaxDim: number | undefined,
    cacheKey: (path: string, kind: string) => string,
  ): Promise<void> {
    const toRead: { asset: Project["assets"][number]; ck: string }[] = [];
    for (const asset of batch) {
      if (asset.kind === "video") this.registerPackedLayoutIfPresent(asset.id, asset.meta);
      const ck = cacheKey(asset.path, asset.kind);
      if (this.byPath.has(ck)) {
        const entry = this.byPath.get(ck)!;
        this.byId.set(asset.id, entry);
        if (asset.kind === "video" && isSplitAlphaVideoMeta(asset.meta)) {
          await this.loadSplitAlphaFromFs(asset.id, asset.meta!.alphaPath as string, fs, asset.meta);
        }
        continue;
      }
      toRead.push({ asset, ck });
    }
    if (toRead.length === 0) return;

    let bufByPath: Map<string, Uint8Array>;
    if (hasReadBatch(fs)) {
      bufByPath = await fs.readBatch(toRead.map((t) => t.asset.path));
    } else {
      bufByPath = new Map();
      await Promise.all(
        toRead.map(async ({ asset }) => {
          try {
            bufByPath.set(normalizePath(asset.path), await fs.read(asset.path));
          } catch {
            /* leave missing — treated as unreadable below */
          }
        }),
      );
    }

    for (const { asset, ck } of toRead) {
      const buf = bufByPath.get(normalizePath(asset.path));
      if (!buf) continue; // skip unreadable asset（既存挙動と同一）
      try {
        const mime =
          (typeof asset.meta?.mime === "string" ? asset.meta.mime : null) ??
          (asset.kind === "video" ? videoMimeFromPath(asset.path) : mimeFromPath(asset.path));
        const entry = asset.kind === "video"
          ? await decodeVideoEntry(buf, mime, asset.meta)
          : await decodeImageEntry(buf, mime, asset.meta, proxyMaxDim);
        this.byPath.set(ck, entry);
        this.byId.set(asset.id, entry);
        if (entry.url.startsWith("blob:")) this.blobUrls.add(entry.url);
        if (asset.kind === "video" && isSplitAlphaVideoMeta(asset.meta)) {
          await this.loadSplitAlphaFromFs(asset.id, asset.meta!.alphaPath as string, fs, asset.meta);
        }
      } catch {
        /* skip unreadable asset */
      }
      // §11.4b video プロキシ（meta.proxies）も FS から読み込み proxyById に登録。
      if (asset.kind === "video") {
        await this.loadProxiesFromFs(asset.id, asset.meta, fs);
      }
    }
  }

  /** §11.4b meta.proxies の各 tier ファイルを FS から読み blob URL 化して登録する。 */
  private async loadProxiesFromFs(
    assetId: string,
    meta: Record<string, unknown> | undefined,
    fs: FileSystem,
  ): Promise<void> {
    const proxies = meta?.proxies;
    if (!proxies || typeof proxies !== "object") return;
    for (const [tier, raw] of Object.entries(proxies as Record<string, unknown>)) {
      const p = (raw ?? {}) as { path?: unknown; mime?: unknown };
      const path = typeof p.path === "string" ? p.path : null;
      if (!path) continue;
      const ck = `proxy|${path}`;
      let entry = this.byPath.get(ck);
      if (!entry) {
        try {
          const buf = await fs.read(path);
          const mime = typeof p.mime === "string" ? p.mime : videoMimeFromPath(path);
          entry = await decodeVideoEntry(buf, mime, meta);
          this.byPath.set(ck, entry);
          if (entry.url.startsWith("blob:")) this.blobUrls.add(entry.url);
        } catch {
          continue;
        }
      }
      this.registerProxyEntry(assetId, tier, entry);
      this.registerPackedProxyLayoutIfPresent(assetId, tier, raw);
    }
  }

  /**
   * §16.2b — meta.proxies[tier] に併記された packed proxy 自身の縮小 layout
   * （`{contentHeight, gutterPx}`）があれば packedProxyLayoutById に登録する（他は無視）。
   */
  private registerPackedProxyLayoutIfPresent(assetId: string, tier: string, raw: unknown): void {
    const p = (raw ?? {}) as { contentHeight?: unknown; gutterPx?: unknown };
    if (typeof p.contentHeight !== "number" || p.contentHeight <= 0) return;
    if (typeof p.gutterPx !== "number" || p.gutterPx < 0) return;
    let m = this.packedProxyLayoutById.get(assetId);
    if (!m) {
      m = new Map();
      this.packedProxyLayoutById.set(assetId, m);
    }
    m.set(tier, { contentHeight: p.contentHeight, gutterPx: p.gutterPx });
  }

  private registerProxyEntry(assetId: string, tier: string, entry: ImageEntry): void {
    let m = this.proxyById.get(assetId);
    if (!m) {
      m = new Map();
      this.proxyById.set(assetId, m);
    }
    m.set(tier, entry);
  }

  /** §2.2 packed alpha 資産なら packedLayoutById に登録する（他は無視）。 */
  private registerPackedLayoutIfPresent(assetId: string, meta: Record<string, unknown> | undefined): void {
    const layout = packedAlphaLayoutFromMeta(meta);
    if (layout) this.packedLayoutById.set(assetId, layout);
  }

  /** §16.2 split alpha companion を FS から blob URL 化。 */
  private async loadSplitAlphaFromFs(
    assetId: string,
    alphaPath: string,
    fs: FileSystem,
    meta: Record<string, unknown> | undefined,
  ): Promise<void> {
    const ck = `split-alpha|${alphaPath}`;
    let url = this.byPath.get(ck)?.url;
    if (!url) {
      try {
        const buf = await fs.read(alphaPath);
        const mime = videoMimeFromPath(alphaPath);
        const entry = await decodeVideoEntry(buf, mime, meta);
        this.byPath.set(ck, entry);
        url = entry.url;
        if (url.startsWith("blob:")) this.blobUrls.add(url);
      } catch {
        return;
      }
    }
    this.alphaUrlById.set(assetId, url);
  }

  /** video blob URL を解放しキャッシュから除去する（Footage 削除時）。 */
  evictAsset(assetId: string): void {
    const entry = this.byId.get(assetId);
    if (entry?.url.startsWith("blob:")) {
      URL.revokeObjectURL(entry.url);
      this.blobUrls.delete(entry.url);
    }
    this.byId.delete(assetId);
    for (const [path, e] of this.byPath) {
      if (e === entry) this.byPath.delete(path);
    }
    // §11.4b プロキシ blob も解放。
    const proxies = this.proxyById.get(assetId);
    if (proxies) {
      for (const pe of proxies.values()) {
        if (pe.url.startsWith("blob:")) {
          URL.revokeObjectURL(pe.url);
          this.blobUrls.delete(pe.url);
        }
        for (const [path, e] of this.byPath) {
          if (e === pe) this.byPath.delete(path);
        }
      }
      this.proxyById.delete(assetId);
    }
    const alphaUrl = this.alphaUrlById.get(assetId);
    if (alphaUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(alphaUrl);
      this.blobUrls.delete(alphaUrl);
      for (const [path, e] of this.byPath) {
        if (e.url === alphaUrl) this.byPath.delete(path);
      }
    }
    this.alphaUrlById.delete(assetId);
    this.packedLayoutById.delete(assetId);
    this.packedProxyLayoutById.delete(assetId);
  }

  /** §11.7 bundle player: 相対 URL で image / video を参照する。 */
  registerProjectUrls(project: Project, urlForPath: (path: string) => string): void {
    for (const asset of project.assets) {
      if (asset.kind !== "image" && asset.kind !== "video") continue;
      const size = ImageAssetCache.sizeFromMeta(asset.meta) ?? { width: 100, height: 100 };
      const url = urlForPath(asset.path);
      const entry = { url, size };
      this.byPath.set(asset.path, entry);
      this.byId.set(asset.id, entry);
      if (asset.kind === "video" && isSplitAlphaVideoMeta(asset.meta)) {
        const alphaPath = asset.meta!.alphaPath as string;
        this.alphaUrlById.set(asset.id, urlForPath(alphaPath));
      }
      if (asset.kind === "video") this.registerPackedLayoutIfPresent(asset.id, asset.meta);
      // §11.4b バンドルに含まれる proxy も quality URL として登録（getUrlForQuality 用）。
      this.forEachProxyMeta(asset, (tier, path, raw) => {
        this.registerProxyEntry(asset.id, tier, { url: urlForPath(path), size });
        this.registerPackedProxyLayoutIfPresent(asset.id, tier, raw);
      });
    }
  }

  /** §11.4b meta.proxies を (tier, path, rawEntry) で走査する共通ヘルパ。 */
  private forEachProxyMeta(
    asset: { meta?: Record<string, unknown> },
    cb: (tier: string, path: string, raw: unknown) => void,
  ): void {
    const proxies = asset.meta?.proxies;
    if (!proxies || typeof proxies !== "object") return;
    for (const [tier, raw] of Object.entries(proxies as Record<string, unknown>)) {
      const path = (raw as { path?: unknown })?.path;
      if (typeof path === "string") cb(tier, path, raw);
    }
  }

  /**
   * §11.7 bundle player の video のみ blob URL 化する。
   * HTTP URL 直参照だと `<video>` の再生/seek が HTTP byte-range (206) 対応サーバに依存し、
   * range 非対応のホスト（多くの静的ホスティング・`file://`）では buffer/seek できず stall = もっさり。
   * 素材を一度だけ fetch し全体を in-memory blob 化することで、preview（`decodeVideoEntry`）と
   * 同じ「ファイル全体がメモリにある」再生になり native play がなめらかになる（INV-2）。
   * 画像は単一 GET で十分なので対象外（base64/blob 化でメモリを膨らませない）。
   */
  async loadVideoBlobsFromUrls(
    project: Project,
    urlForPath: (path: string) => string,
  ): Promise<void> {
    for (const asset of project.assets) {
      if (asset.kind !== "video") continue;
      const blobify = async (path: string, register: (entry: ImageEntry) => void) => {
        try {
          const resp = await fetch(urlForPath(path));
          if (!resp.ok) return;
          const buf = new Uint8Array(await resp.arrayBuffer());
          const mime =
            (typeof asset.meta?.mime === "string" ? asset.meta.mime : null) ??
            videoMimeFromPath(path);
          const entry = await decodeVideoEntry(buf, mime, asset.meta);
          register(entry);
          this.blobUrls.add(entry.url);
        } catch {
          /* fetch 失敗時は registerProjectUrls の HTTP URL のままフォールバック */
        }
      };
      await blobify(asset.path, (entry) => {
        this.byPath.set(asset.path, entry);
        this.byId.set(asset.id, entry);
      });
      if (asset.kind === "video" && isSplitAlphaVideoMeta(asset.meta)) {
        const alphaPath = asset.meta!.alphaPath as string;
        await blobify(alphaPath, (entry) => {
          this.alphaUrlById.set(asset.id, entry.url);
        });
      }
      // §11.4b proxy も blob 化（HTTP range 非対応ホストでもなめらか再生・INV-2）。
      const proxyJobs: Promise<void>[] = [];
      this.forEachProxyMeta(asset, (tier, path) => {
        proxyJobs.push(blobify(path, (entry) => this.registerProxyEntry(asset.id, tier, entry)));
      });
      await Promise.all(proxyJobs);
    }
  }
}

export function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function decodeImageEntry(
  buf: Uint8Array,
  mime: string,
  meta: Record<string, unknown> | undefined,
  proxyMaxDim?: number,
): Promise<ImageEntry> {
  const canBitmap = typeof createImageBitmap === "function";
  // SVG はベクタなのでラスタ縮小しない（元々小さく、縮小は品質劣化のみ）。
  const isVector = mime === "image/svg+xml";

  let size = ImageAssetCache.sizeFromMeta(meta);
  let bitmap: ImageBitmap | null = null;
  if (canBitmap && (!size || (proxyMaxDim != null && !isVector))) {
    try {
      // Blob は Uint8Array ビューを直接コピーする（byteOffset/byteLength を尊重）ため
      // 手動 slice は不要（Phase 2a: preview-rendering-pipeline-optimization-plan）。
      // fs.read() は常に ArrayBuffer 裏付けの Uint8Array を返す（SharedArrayBuffer にはならない）。
      bitmap = await createImageBitmap(new Blob([buf as Uint8Array<ArrayBuffer>], { type: mime }));
    } catch {
      bitmap = null;
    }
  }
  if (!size) {
    size = bitmap
      ? { width: bitmap.width, height: bitmap.height }
      : { width: 100, height: 100 };
  }

  // プレビュー専用: 長辺が proxyMaxDim を超える画像を縮小した data URL に差し替える。
  // size（natural）は維持するので CSS / bounds / export 一致は不変。
  if (proxyMaxDim != null && !isVector && bitmap) {
    const longest = Math.max(size.width, size.height);
    if (longest > proxyMaxDim) {
      const s = proxyMaxDim / longest;
      const tw = Math.max(1, Math.round(size.width * s));
      const th = Math.max(1, Math.round(size.height * s));
      try {
        const canvas = document.createElement("canvas");
        canvas.width = tw;
        canvas.height = th;
        const cx = canvas.getContext("2d");
        if (cx) {
          cx.drawImage(bitmap, 0, 0, tw, th);
          // JPEG は不透明なので再エンコードも JPEG、それ以外は alpha 保持のため PNG。
          const outMime = mime === "image/jpeg" ? "image/jpeg" : "image/png";
          const url = outMime === "image/jpeg"
            ? canvas.toDataURL(outMime, 0.82)
            : canvas.toDataURL(outMime);
          bitmap.close();
          return { url, size };
        }
      } catch {
        /* fall through to full-res */
      }
    }
  }

  bitmap?.close();
  const url = `data:${mime};base64,${bytesToBase64(buf)}`;
  return { url, size };
}

/** import 時: File から natural size を取得（store 用）。 */
export async function probeImageFile(file: File): Promise<{ width: number; height: number; mime: string }> {
  const mime = file.type || mimeFromPath(file.name);
  const ab = await file.arrayBuffer();
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(new Blob([ab], { type: mime }));
    const result = { width: bitmap.width, height: bitmap.height, mime };
    bitmap.close();
    return result;
  }
  return { width: 100, height: 100, mime };
}

async function decodeVideoEntry(
  buf: Uint8Array,
  mime: string,
  meta: Record<string, unknown> | undefined,
): Promise<ImageEntry> {
  // Phase 2b（preview-rendering-pipeline-optimization-plan）: Blob 構築（slice 相当のコピー）を
  // Web Worker にオフロードし、URL.createObjectURL のみメインスレッドで行う
  // （videoBlobDecode.ts のコメント参照: Worker 発行の blob: URL は <video> から参照不可）。
  const url = await decodeVideoBlobUrl(buf, mime);
  const size = ImageAssetCache.sizeFromMeta(meta) ?? { width: 100, height: 100 };
  return { url, size };
}
