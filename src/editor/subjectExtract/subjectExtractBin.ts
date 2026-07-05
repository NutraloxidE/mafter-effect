import {
  createBinInProject,
  orderedEntriesForParent,
} from "../../core/projectTree";
import type { Project } from "../../core/schema";

/** Project パネル上の親フォルダ名。 */
export const ASSETS_BIN_NAME = "Assets";
/** Subject Extract 成果物フォルダ名（Assets 配下）。 */
export const SUBJECT_EXTRACT_BIN_NAME = "VideoSubjectExtract";

function findRootBinByName(project: Project, name: string) {
  return (project.bins ?? []).find((b) => b.name === name && b.parentId === null);
}

function findChildBinByName(project: Project, parentId: string, name: string) {
  return (project.bins ?? []).find((b) => b.name === name && b.parentId === parentId);
}

/** Assets → VideoSubjectExtract を返す。無ければ親子とも作成。 */
export function ensureSubjectExtractBin(
  project: Project,
  newAssetsBinId: string,
  newExtractBinId: string,
): { project: Project; binId: string } {
  let p = project;
  let assetsBin = findRootBinByName(p, ASSETS_BIN_NAME);
  if (!assetsBin) {
    p = createBinInProject(p, newAssetsBinId, ASSETS_BIN_NAME, null);
    assetsBin = findRootBinByName(p, ASSETS_BIN_NAME)!;
  }
  let extractBin = findChildBinByName(p, assetsBin.id, SUBJECT_EXTRACT_BIN_NAME);
  if (!extractBin) {
    p = createBinInProject(p, newExtractBinId, SUBJECT_EXTRACT_BIN_NAME, assetsBin.id);
    extractBin = findChildBinByName(p, assetsBin.id, SUBJECT_EXTRACT_BIN_NAME)!;
  }
  return { project: p, binId: extractBin.id };
}

/** テスト用: VideoSubjectExtract フォルダ内の asset id 一覧。 */
export function subjectExtractAssetIds(project: Project): string[] {
  const assetsBin = findRootBinByName(project, ASSETS_BIN_NAME);
  if (!assetsBin) return [];
  const extractBin = findChildBinByName(project, assetsBin.id, SUBJECT_EXTRACT_BIN_NAME);
  if (!extractBin) return [];
  return orderedEntriesForParent(project, extractBin.id)
    .filter((e) => e.kind === "asset")
    .map((e) => e.id);
}
