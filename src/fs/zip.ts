import JSZip from "jszip";
import { normalizePath, type FileSystem } from "./FileSystem";
import type { Project } from "../core/schema";
import { serializeProject } from "../core/serialize";
import { PROJECT_JSON } from "../core/paths";
import { resolveOriginalPath } from "../runtime/footagePlayback";

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

/** §11.4b project 内の全 proxy ファイル path（zip から除外する対象）を集める。 */
export function collectProxyPaths(project: Project): Set<string> {
  const out = new Set<string>();
  for (const asset of project.assets) {
    const proxies = asset.meta?.proxies;
    if (!proxies || typeof proxies !== "object") continue;
    for (const raw of Object.values(proxies as Record<string, unknown>)) {
      const p = (raw as { path?: unknown })?.path;
      if (typeof p === "string") out.add(p);
    }
  }
  return out;
}

/**
 * §11.4b zip 用に project を正規化（純関数）。
 * - video asset の `path` を原本（originalPath ?? path）へ戻す。
 * - `meta.proxies` / `meta.originalPath` を省く（プロキシは再 open / 初回参照で lazy 再生成）。
 * - レイヤーの `footageQuality` prop は保持（再 import 後も画質指定を維持し ensureProxyTier が走る）。
 */
export function normalizeProjectForZip(project: Project): Project {
  return {
    ...project,
    assets: project.assets.map((a) => {
      if (a.kind !== "video") return a;
      const meta = { ...(a.meta ?? {}) };
      delete (meta as Record<string, unknown>).proxies;
      delete (meta as Record<string, unknown>).originalPath;
      return { ...a, path: resolveOriginalPath(a), meta };
    }),
  };
}

/**
 * §11.4b project zip 書き出し（原本のみ）。FS を走査しつつ:
 * - proxy ファイルを除外
 * - project.json は正規化版（原本 path・proxies 省略）に差し替え
 * IndexedDbFs 上の編集用 project.json / proxy は変更しない。
 */
export async function exportProjectZip(
  fs: FileSystem,
  project: Project,
  dir = "",
  onProgress?: ZipProgressCallback,
): Promise<Uint8Array> {
  const zip = new JSZip();
  const excluded = collectProxyPaths(project);
  const normalizedJson = serializeProject(normalizeProjectForZip(project));
  const allPaths = (await fs.list(dir)).sort();
  const paths = allPaths.filter((p) => !excluded.has(p));
  const total = paths.length;
  onProgress?.({ phase: "list", current: total, total, message: `${total} 件のファイル` });

  const fixedDate = new Date(Date.UTC(2000, 0, 1, 0, 0, 0, 0));
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!;
    onProgress?.({ phase: "read", current: i + 1, total, message: shortPath(path) });
    if (path === PROJECT_JSON) {
      zip.file(path, normalizedJson, { date: fixedDate });
      continue;
    }
    const data = await fs.read(path);
    zip.file(path, data, { date: fixedDate });
  }
  // project.json が FS 走査に含まれない場合も必ず正規化版を入れる。
  if (!paths.includes(PROJECT_JSON)) {
    zip.file(PROJECT_JSON, normalizedJson, { date: fixedDate });
  }

  onProgress?.({ phase: "pack", current: 0, total: 100, message: "0%" });
  return zip.generateAsync(
    { type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } },
    (metadata) => {
      const pct = Math.round(metadata.percent);
      onProgress?.({ phase: "pack", current: pct, total: 100, message: `${pct}%` });
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
