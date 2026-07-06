// §11.7 Folder bundle export — index.html + player.js + project/assets ZIP。

import JSZip from "jszip";
import { pluginDir, PROJECT_JSON } from "../core/paths";
import { canonicalizeProject, serializeProject } from "../core/serialize";
import type { ExportConfig, Project, TimelineComposition } from "../core/schema";
import type { FileSystem } from "../fs/FileSystem";
import { applyBundleBake } from "./bundleBake";
import { collectBundleDependencies } from "./bundleCollect";
import { injectBuiltinExpressionPresetScripts } from "./builtinExpressionPresetScripts";
import {
  BUILTIN_FONT_DIR,
  findBuiltinFontByFamily,
  fontUsesFamily,
  nearestBuiltinWeight,
} from "./builtinFonts";
import { PLAYER_FRESHNESS_MARKER, type BundleBuiltinFont, type BundleManifest } from "./bundleTypes";
import type { ProgressCallback } from "./exporter";
import { publicAssetUrl } from "./publicAssetUrl";

export interface BundleExportResult {
  blob: Blob;
  format: "html-bundle";
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function loadPlayerScript(): Promise<string> {
  let text: string | undefined;
  try {
    const resp = await fetch(publicAssetUrl("player.js"));
    if (resp.ok) text = await resp.text();
  } catch {
    /* fall through */
  }
  if (text === undefined) {
    throw new Error(
      "player.js not found. Run npm run build:player and ensure public/player.js exists.",
    );
  }
  // 再ビルド忘れガード（dev のみ）: 古い player.js を zip に埋めて
  // 「動画は出るが expression preset 等の新機能だけ効かない」事故を export 前に止める。
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  if (env?.DEV && !text.includes(PLAYER_FRESHNESS_MARKER)) {
    throw new Error(
      `public/player.js is stale (missing "${PLAYER_FRESHNESS_MARKER}"). ` +
        "Run: npm run build:player",
    );
  }
  return text;
}

function buildIndexHtml(compName: string, manifestJson: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(compName)}</title>
  <style>
    html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
    #mafter-stage { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
  </style>
</head>
<body>
  <div id="mafter-stage"></div>
  <script type="application/json" id="mafter-bundle-manifest">${manifestJson}</script>
  <script src="./player.js"></script>
</body>
</html>
`;
}

async function collectTextAndBinary(
  fs: FileSystem,
  textPaths: Set<string>,
  binaryPaths: Set<string>,
  livePluginIds: Set<string>,
): Promise<{ textFiles: Record<string, string>; binaries: Map<string, Uint8Array>; blobs: Record<string, string> }> {
  const textFiles: Record<string, string> = {};
  const binaries = new Map<string, Uint8Array>();
  const blobs: Record<string, string> = {};

  for (const path of textPaths) {
    if (path === PROJECT_JSON) continue;
    try {
      if (await fs.exists(path)) {
        textFiles[path] = await fs.readText(path);
      }
    } catch {
      /* skip */
    }
  }

  for (const pluginId of livePluginIds) {
    const dir = pluginDir(pluginId);
    try {
      const files = await fs.list(dir);
      for (const p of files) {
        if (p.endsWith(".js") || p.endsWith(".json")) {
          try {
            textFiles[p] = await fs.readText(p);
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  for (const path of binaryPaths) {
    try {
      if (!(await fs.exists(path))) continue;
      const data = await fs.read(path);
      binaries.set(path, data);
      if (path.includes("/font") || path.match(/\.(woff2?|ttf|otf)$/i)) {
        blobs[path] = bytesToBase64(data);
      }
    } catch {
      /* skip */
    }
  }

  return { textFiles, binaries, blobs };
}

function staticPropValue(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "value" in raw && "keyframes" in raw) {
    return (raw as { value: unknown }).value;
  }
  return raw;
}

/** §26.3.2 project 内の text レイヤーが使う built-in family×weight を列挙する。 */
function collectBuiltinFontUsage(project: Project): BundleBuiltinFont[] {
  const seen = new Map<string, BundleBuiltinFont>();
  for (const comp of project.compositions) {
    if (comp.kind !== "timeline") continue;
    for (const obj of comp.objects) {
      for (const c of obj.components) {
        if (c.type !== "text") continue;
        const font = staticPropValue(c.props["font"]);
        if (typeof font !== "string") continue;
        const family = font.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
        const def = fontUsesFamily(font, family) ? findBuiltinFontByFamily(family) : undefined;
        if (!def) continue;
        const wRaw = staticPropValue(c.props["weight"]);
        const weight = Number(wRaw);
        const w = nearestBuiltinWeight(def, Number.isFinite(weight) ? weight : 400);
        const path = `${BUILTIN_FONT_DIR}/${w.file}`;
        if (!seen.has(path)) {
          seen.set(path, { family: def.family, weight: w.weight, path });
        }
      }
    }
  }
  return [...seen.values()];
}

async function fetchBuiltinFontBytes(path: string): Promise<Uint8Array | null> {
  try {
    const resp = await fetch(publicAssetUrl(path));
    if (!resp.ok) return null;
    return new Uint8Array(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

export async function exportBundle(
  project: Project,
  compId: string,
  fs: FileSystem,
  config: ExportConfig,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<BundleExportResult> {
  const comp = project.compositions.find((c) => c.id === compId);
  if (!comp || comp.kind !== "timeline") {
    throw new Error("Timeline composition not found: " + compId);
  }
  const tlComp = comp as TimelineComposition;

  onProgress({ phase: "prepare", frame: 0, totalFrames: 1, message: "Collecting bundle dependencies…" });
  checkAbort(signal);

  const deps = collectBundleDependencies(project, compId);
  let bundleProject = canonicalizeProject(project);

  const bakeResult = await applyBundleBake(
    bundleProject,
    deps.timelineCompIds,
    config,
    fs,
    onProgress,
    signal,
  );
  bundleProject = bakeResult.project;

  for (const [path] of bakeResult.binaryFiles) {
    deps.binaryPaths.add(path);
  }

  const collected = await collectTextAndBinary(fs, deps.textPaths, deps.binaryPaths, deps.livePluginIds);
  injectBuiltinExpressionPresetScripts(bundleProject, collected.textFiles);

  // §26.3.2 使用された built-in フォントを public/fonts から取得し zip 同梱する。
  const builtinFontUse = collectBuiltinFontUsage(bundleProject);
  const builtinFontBytes = new Map<string, Uint8Array>();
  const builtinFonts: BundleBuiltinFont[] = [];
  for (const f of builtinFontUse) {
    const bytes = await fetchBuiltinFontBytes(f.path);
    if (!bytes) continue;
    builtinFontBytes.set(f.path, bytes);
    builtinFonts.push(f);
  }

  const manifest: BundleManifest = {
    compId,
    fps: config.fps,
    range: config.range,
    loop: config.bundleLoop !== false,
    textRenderMode: config.textRenderMode ?? "precise",
    assetBase: ".",
    project: bundleProject,
    textFiles: collected.textFiles,
    blobs: collected.blobs,
    builtinFonts,
  };

  const manifestJson = JSON.stringify(manifest).replace(/</g, "\\u003c");
  const projectJson = serializeProject(bundleProject);
  const playerJs = await loadPlayerScript();
  const indexHtml = buildIndexHtml(tlComp.name, manifestJson);

  onProgress({ phase: "pack", frame: 0, totalFrames: 1, message: "Packaging ZIP…" });
  checkAbort(signal);

  const zip = new JSZip();
  const fixedDate = new Date(Date.UTC(2000, 0, 1, 0, 0, 0, 0));
  zip.file("index.html", indexHtml, { date: fixedDate });
  zip.file("player.js", playerJs, { date: fixedDate });
  zip.file("project.json", projectJson, { date: fixedDate });
  zip.file("bundle-manifest.json", JSON.stringify(manifest, null, 2) + "\n", { date: fixedDate });

  for (const [path, data] of collected.binaries) {
    zip.file(path, data, { date: fixedDate });
  }
  for (const [path, data] of bakeResult.binaryFiles) {
    zip.file(path, data, { date: fixedDate });
  }
  for (const [path, data] of builtinFontBytes) {
    zip.file(path, data, { date: fixedDate });
  }

  const paths = Object.keys(zip.files).sort();
  const blob = await zip.generateAsync({ type: "blob" });
  onProgress({
    phase: "done",
    frame: paths.length,
    totalFrames: paths.length,
    message: `Bundle ready (${paths.length} files)`,
  });

  return { blob, format: "html-bundle" };
}
