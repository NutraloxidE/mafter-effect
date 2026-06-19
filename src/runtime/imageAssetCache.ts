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
  async loadFromProject(project: Project, fs: FileSystem): Promise<void> {
    for (const asset of project.assets) {
      if (asset.kind !== "image") continue;
      if (this.byPath.has(asset.path)) {
        const entry = this.byPath.get(asset.path)!;
        this.byId.set(asset.id, entry);
        continue;
      }
      try {
        const buf = await fs.read(asset.path);
        const mime =
          (typeof asset.meta?.mime === "string" ? asset.meta.mime : null) ??
          mimeFromPath(asset.path);
        const entry = await decodeImageEntry(buf, mime, asset.meta);
        this.byPath.set(asset.path, entry);
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
): Promise<ImageEntry> {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const metaSize = ImageAssetCache.sizeFromMeta(meta);
  const url = `data:${mime};base64,${bytesToBase64(buf)}`;

  if (metaSize) {
    return { url, size: metaSize };
  }

  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(new Blob([ab], { type: mime }));
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return { url, size };
    } catch {
      /* fall through */
    }
  }

  return { url, size: { width: 100, height: 100 } };
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
