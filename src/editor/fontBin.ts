// §20.5 Project パネル上の font asset 置き場（純関数）。3D Extrude が自動で埋め込む ttf は
// ユーザーが意識して作った素材ではないため、ルート直下に並べず `fonts` フォルダへまとめる。
// 構成は §11.2b pre-render の `pre-rendered` フォルダと対称。

import { appendTreeEntry, createBinInProject, orderedEntriesForParent } from "../core/projectTree";
import type { AssetEntry, Project } from "../core/schema";

/** Project パネル上のフォントフォルダ名（ルート直下）。 */
export const FONTS_BIN_NAME = "fonts";

/** ルート直下の `fonts` bin を返す。無ければ作成する。 */
export function ensureFontsBin(
  project: Project,
  newBinId: string,
): { project: Project; binId: string } {
  const existing = (project.bins ?? []).find(
    (b) => b.name === FONTS_BIN_NAME && b.parentId === null,
  );
  if (existing) return { project, binId: existing.id };
  return {
    project: createBinInProject(project, newBinId, FONTS_BIN_NAME, null),
    binId: newBinId,
  };
}

/** font asset を `fonts` フォルダ配下に追加した project（純関数）。 */
export function addFontAssetToProject(
  project: Project,
  asset: AssetEntry,
  newBinId: string,
): Project {
  const { project: withBin, binId } = ensureFontsBin(project, newBinId);
  const placed: AssetEntry = { ...asset, binId };
  const withAsset: Project = {
    ...withBin,
    assets: [...withBin.assets, placed].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  return appendTreeEntry(withAsset, { kind: "asset", id: placed.id }, binId);
}

/**
 * `fonts` フォルダ導入前に取り込まれ、ルート直下に並んだままの font asset id。
 * ユーザーが自分で別フォルダへ動かしたフォントは対象外（binId を持つため）。
 */
export function strayFontAssetIds(project: Project): string[] {
  return project.assets.filter((a) => a.kind === "font" && !a.binId).map((a) => a.id);
}

/** ルート直下の font asset を `fonts` フォルダへ移した project（純関数）。 */
export function migrateFontAssetsToBin(project: Project, newBinId: string): Project {
  const strays = strayFontAssetIds(project);
  if (strays.length === 0) return project;

  const { project: withBin, binId } = ensureFontsBin(project, newBinId);
  const strayIds = new Set(strays);
  let p: Project = {
    ...withBin,
    assets: withBin.assets.map((a) => (strayIds.has(a.id) ? { ...a, binId } : a)),
  };
  for (const id of strays) {
    p = appendTreeEntry(p, { kind: "asset", id }, binId);
  }
  return p;
}

/** テスト用: `fonts` フォルダ内の asset id 一覧。 */
export function fontBinAssetIds(project: Project): string[] {
  const bin = (project.bins ?? []).find(
    (b) => b.name === FONTS_BIN_NAME && b.parentId === null,
  );
  if (!bin) return [];
  return orderedEntriesForParent(project, bin.id)
    .filter((e) => e.kind === "asset")
    .map((e) => e.id);
}
