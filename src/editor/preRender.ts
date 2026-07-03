// §11.2b Pre-render — project への適用（純関数）。FS 書き込みは呼び出し側。

import { defaultTransform, staticProp } from "../core/props";
import {
  appendTreeEntry,
  createBinInProject,
  orderedEntriesForParent,
} from "../core/projectTree";
import type { AssetEntry, Project, SceneObject, TimelineComposition } from "../core/schema";
import { unlockedVisibilityPatches } from "./layerLock";

/** Project パネル上の Pre-render 成果物フォルダ名（ルート直下）。 */
export const PRE_RENDERED_BIN_NAME = "pre-rendered";

export interface PreRenderApplyInput {
  compId: string;
  asset: AssetEntry;
  layerId: string;
  layerName: string;
  /** export range → 新 video レイヤーの in/out。 */
  range: [number, number];
  /**
   * `pre-rendered` フォルダが未作成のとき使う bin id。
   * 既存フォルダがある場合は無視される（純関数のため呼び出し側が採番）。
   */
  preRenderedBinId: string;
}

/** ルート直下の `pre-rendered` bin を返す。無ければ作成する。 */
export function ensurePreRenderedBin(
  project: Project,
  newBinId: string,
): { project: Project; binId: string } {
  const existing = (project.bins ?? []).find(
    (b) => b.name === PRE_RENDERED_BIN_NAME && b.parentId === null,
  );
  if (existing) return { project, binId: existing.id };
  return {
    project: createBinInProject(project, newBinId, PRE_RENDERED_BIN_NAME, null),
    binId: newBinId,
  };
}

/** 未ロック非表示 + asset を pre-rendered フォルダへ + 最上段 video レイヤー。1 command 用の after project。 */
export function applyPreRenderToProject(project: Project, input: PreRenderApplyInput): Project {
  const comp = project.compositions.find((c) => c.id === input.compId);
  if (!comp || comp.kind !== "timeline") {
    throw new Error("Timeline composition not found: " + input.compId);
  }
  const tl = comp as TimelineComposition;
  const [startFrame, endFrame] = input.range;
  const inPoint = Math.max(0, Math.min(startFrame, endFrame));
  const outPoint = Math.max(inPoint + 1, Math.max(startFrame, endFrame));

  const hidePatches = unlockedVisibilityPatches(tl.objects, false);
  const hideById = new Map(hidePatches.map((p) => [p.id, p.patch]));

  const zOrder = nextZOrder(tl.objects);
  const layer: SceneObject = {
    id: input.layerId,
    name: input.layerName,
    parent: null,
    zOrder,
    enabled: true,
    inPoint,
    outPoint,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [{
      type: "video",
      props: {
        asset: input.asset.id,
        fit: "fill",
        trimStart: 0,
        gain: staticProp(1),
        footageQuality: "original",
      },
    }],
  };

  const objects = [
    ...tl.objects.map((o) => {
      const patch = hideById.get(o.id);
      return patch ? { ...o, ...patch } : o;
    }),
    layer,
  ];

  const { project: withBin, binId } = ensurePreRenderedBin(project, input.preRenderedBinId);
  const asset: AssetEntry = { ...input.asset, binId };

  const withLayers: Project = {
    ...withBin,
    assets: [...withBin.assets, asset].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
    compositions: withBin.compositions.map((c) =>
      c.id === input.compId && c.kind === "timeline" ? { ...c, objects } : c,
    ),
  };
  return appendTreeEntry(withLayers, { kind: "asset", id: asset.id }, binId);
}

/** テスト用: pre-rendered フォルダ内の asset id 一覧。 */
export function preRenderedAssetIds(project: Project): string[] {
  const bin = (project.bins ?? []).find(
    (b) => b.name === PRE_RENDERED_BIN_NAME && b.parentId === null,
  );
  if (!bin) return [];
  return orderedEntriesForParent(project, bin.id)
    .filter((e) => e.kind === "asset")
    .map((e) => e.id);
}

function nextZOrder(objects: SceneObject[]): number {
  if (objects.length === 0) return 1;
  return Math.max(...objects.map((o) => o.zOrder)) + 1;
}
