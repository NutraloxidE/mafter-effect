import type { Project } from "../core/schema";
import type { FileSystem } from "../fs/FileSystem";

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
}

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

/** asset 画像の data: URL と natural size キャッシュ（export taint 回避のため blob: は使わない）。 */
export class ImageAssetCache {
  private readonly byId = new Map<string, ImageEntry>();
  private readonly byPath = new Map<string, ImageEntry>();

  getUrl(assetId: string): string | null {
    return this.byId.get(assetId)?.url ?? null;
  }

  getSize(assetId: string): ImageSize | null {
    return this.byId.get(assetId)?.size ?? null;
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

  /** project.assets の image を FS から読み込む。 */
  async loadFromProject(project: Project, fs: FileSystem, options?: ImageLoadOptions): Promise<void> {
    const proxyMaxDim = options?.proxyMaxDim;
    // proxy 設定ごとに別キャッシュ（full-res と縮小版の取り違えを防ぐ）。
    const cacheKey = (path: string) => `${proxyMaxDim ?? "full"}|${path}`;
    for (const asset of project.assets) {
      if (asset.kind !== "image") continue;
      const ck = cacheKey(asset.path);
      if (this.byPath.has(ck)) {
        const entry = this.byPath.get(ck)!;
        this.byId.set(asset.id, entry);
        continue;
      }
      try {
        const buf = await fs.read(asset.path);
        const mime =
          (typeof asset.meta?.mime === "string" ? asset.meta.mime : null) ??
          mimeFromPath(asset.path);
        const entry = await decodeImageEntry(buf, mime, asset.meta, proxyMaxDim);
        this.byPath.set(ck, entry);
        this.byId.set(asset.id, entry);
      } catch {
        /* skip unreadable image */
      }
    }
  }

  /** §11.7 bundle player: 相対 URL で image / video を参照する。 */
  registerProjectUrls(project: Project, urlForPath: (path: string) => string): void {
    for (const asset of project.assets) {
      if (asset.kind !== "image" && asset.kind !== "video") continue;
      const url = urlForPath(asset.path);
      const size = ImageAssetCache.sizeFromMeta(asset.meta) ?? { width: 100, height: 100 };
      const entry = { url, size };
      this.byPath.set(asset.path, entry);
      this.byId.set(asset.id, entry);
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
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const canBitmap = typeof createImageBitmap === "function";
  // SVG はベクタなのでラスタ縮小しない（元々小さく、縮小は品質劣化のみ）。
  const isVector = mime === "image/svg+xml";

  let size = ImageAssetCache.sizeFromMeta(meta);
  let bitmap: ImageBitmap | null = null;
  if (canBitmap && (!size || (proxyMaxDim != null && !isVector))) {
    try {
      bitmap = await createImageBitmap(new Blob([ab], { type: mime }));
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
