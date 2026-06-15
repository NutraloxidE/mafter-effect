import JSZip from "jszip";
import { normalizePath, type FileSystem } from "./FileSystem";

// §11.1 / INV-4: zip 書き出し結果はフォルダ構成と一致する。
// FS を走査し同一パスで zip 化、import は逆。

/**
 * FS 全体（または dir 配下）を走査して zip(Uint8Array) を生成する。
 * エントリは path 昇順で追加し、決定論的なバイト列にするため日時を固定する。
 */
export async function exportZip(fs: FileSystem, dir = ""): Promise<Uint8Array> {
  const zip = new JSZip();
  const paths = (await fs.list(dir)).sort();
  // 固定日時で決定論化（INV-4 byte 等価のため）。
  const fixedDate = new Date(Date.UTC(2000, 0, 1, 0, 0, 0, 0));
  for (const path of paths) {
    const data = await fs.read(path);
    zip.file(path, data, { date: fixedDate });
  }
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
}

/**
 * zip を FS へ展開する。既存のパスは上書きする。
 * 空フォルダエントリは無視（フラット FS ではファイルのみが意味を持つ、INV-4）。
 */
export async function importZip(
  fs: FileSystem,
  data: Uint8Array | ArrayBuffer,
): Promise<void> {
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files).filter((e) => !e.dir);
  for (const entry of entries) {
    const bytes = await entry.async("uint8array");
    await fs.write(normalizePath(entry.name), bytes);
  }
}
