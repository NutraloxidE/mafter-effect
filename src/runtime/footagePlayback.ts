// §11.4b — footage の映像/音声パス解決（純関数）。
// 映像 path は footageQuality に依存（プロキシ切替）、音声 path は quality 非依存で常に原本。
// すべて asset.meta（freeform・§5 非変更）から読む。

import type { FootageQuality } from "./footageQuality";
import { isProxyTier, normalizeFootageQuality } from "./footageQuality";
import type { Project } from "../core/schema";

/** path 解決に必要な asset の最小形（AssetEntry 互換。テスト用に narrow）。 */
export interface FootagePathAsset {
  path: string;
  meta?: Record<string, unknown>;
}

/** asset.meta.proxies の 1 エントリ（§11.4b）。 */
export interface ProxyMetaEntry {
  path: string;
  mime?: string;
  width?: number;
  height?: number;
}

export type FootageKind = "native" | "animated-raster";

/** asset.meta.footageKind を読む。未記録は native 扱い（実写/通常動画）。 */
export function footageKindOf(asset: FootagePathAsset): FootageKind {
  return asset.meta?.footageKind === "animated-raster" ? "animated-raster" : "native";
}

/** 原本（オリジナル）映像/音声の path。raster は meta.originalPath、native は meta.originalPath ?? path。 */
export function resolveOriginalPath(asset: FootagePathAsset): string {
  const orig = asset.meta?.originalPath;
  return typeof orig === "string" && orig !== "" ? orig : asset.path;
}

function readProxies(asset: FootagePathAsset): Record<string, ProxyMetaEntry> {
  const p = asset.meta?.proxies;
  return p && typeof p === "object" ? (p as Record<string, ProxyMetaEntry>) : {};
}

/** 指定 tier のプロキシ meta（無ければ null）。`original` は常に null。 */
export function getProxyEntry(asset: FootagePathAsset, quality: FootageQuality): ProxyMetaEntry | null {
  if (!isProxyTier(quality)) return null;
  const entry = readProxies(asset)[quality];
  return entry && typeof entry.path === "string" ? entry : null;
}

/**
 * DomRenderer / export がデコードする映像ファイル path。
 * 要求 tier のプロキシが無ければ原本へフォールバック（INV-2: 全経路同一規則）。
 */
export function resolveFootageVideoPath(asset: FootagePathAsset, quality: FootageQuality): string {
  const proxy = getProxyEntry(asset, quality);
  return proxy ? proxy.path : resolveOriginalPath(asset);
}

/**
 * 内蔵音声の path。quality 非依存で常に原本。
 * animated-raster（WebP/GIF）は音声トラックを持たないため null。
 */
export function resolveFootageAudioPath(asset: FootagePathAsset): string | null {
  if (footageKindOf(asset) === "animated-raster") return null;
  return resolveOriginalPath(asset);
}

export interface ProxyJob {
  assetId: string;
  quality: FootageQuality;
}

/**
 * §11.4b export 前に生成保証すべき (assetId, proxy tier) の集合（純関数）。
 * 全 timeline comp の enabled video レイヤーから proxy tier 指定を集める（重複排除）。
 */
export function collectExportProxyJobs(project: Project): ProxyJob[] {
  const seen = new Set<string>();
  const jobs: ProxyJob[] = [];
  for (const comp of project.compositions) {
    if (comp.kind !== "timeline") continue;
    for (const obj of comp.objects) {
      for (const cmp of obj.components) {
        if (cmp.type !== "video") continue;
        const assetId = cmp.props["asset"];
        if (typeof assetId !== "string" || assetId === "") continue;
        const quality = normalizeFootageQuality(cmp.props["footageQuality"]);
        if (!isProxyTier(quality)) continue;
        const key = `${assetId}|${quality}`;
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push({ assetId, quality });
      }
    }
  }
  return jobs;
}
