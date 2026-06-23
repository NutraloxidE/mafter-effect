import JSZip from "jszip";
import { normalizePath, type FileSystem } from "./FileSystem";

// §11.1 / INV-4: zip 書き出し結果はフォルダ構成と一致する。
// FS を走査し同一パスで zip 化、import は逆。

export type ZipExportPhase = "list" | "read" | "pack";

export interface ZipExportProgress {
  phase: ZipExportPhase;
  current: number;
  total: number;
  message: string;
}

export type ZipProgressCallback = (p: ZipExportProgress) => void;

function shortPath(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/**
 * FS 全体（または dir 配下）を走査して zip(Uint8Array) を生成する。
 * エントリは path 昇順で追加し、決定論的なバイト列にするため日時を固定する。
 */
export async function exportZip(
  fs: FileSystem,
  dir = "",
  onProgress?: ZipProgressCallback,
): Promise<Uint8Array> {
  const zip = new JSZip();
  const paths = (await fs.list(dir)).sort();
  const total = paths.length;
  onProgress?.({
    phase: "list",
    current: total,
    total,
    message: total === 0 ? "ファイルなし" : `${total} 件のファイル`,
  });

  const fixedDate = new Date(Date.UTC(2000, 0, 1, 0, 0, 0, 0));
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!;
    onProgress?.({
      phase: "read",
      current: i + 1,
      total,
      message: shortPath(path),
    });
    const data = await fs.read(path);
    zip.file(path, data, { date: fixedDate });
  }

  onProgress?.({
    phase: "pack",
    current: 0,
    total: 100,
    message: "0%",
  });

  return zip.generateAsync(
    {
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    },
    (metadata) => {
      const pct = Math.round(metadata.percent);
      onProgress?.({
        phase: "pack",
        current: pct,
        total: 100,
        message: `${pct}%`,
      });
    },
  );
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
