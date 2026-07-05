import { staticProp } from "../../core/props";
import { appendTreeEntry } from "../../core/projectTree";
import type { AssetEntry, Project, SceneObject } from "../../core/schema";
import { ensureSubjectExtractBin } from "./subjectExtractBin";

export type SubjectExtractTarget = "person";

export interface SubjectExtractApplyInput {
  compId: string;
  sourceLayer: SceneObject;
  asset: AssetEntry;
  layerId: string;
  layerName: string;
  assetsBinId: string;
  extractBinId: string;
  target: SubjectExtractTarget;
}

/** ソース video 直上に切り抜き video レイヤー + asset を Assets/VideoSubjectExtract へ。 */
export function applySubjectExtractToProject(
  project: Project,
  input: SubjectExtractApplyInput,
): Project {
  const comp = project.compositions.find((c) => c.id === input.compId);
  if (!comp || comp.kind !== "timeline") {
    throw new Error("Timeline composition not found: " + input.compId);
  }
  const source = input.sourceLayer;
  const videoComp = source.components.find((c) => c.type === "video");
  const fit = typeof videoComp?.props["fit"] === "string" ? videoComp.props["fit"] : "contain";

  const layer: SceneObject = {
    id: input.layerId,
    name: input.layerName,
    parent: source.parent,
    zOrder: source.zOrder + 0.5,
    enabled: true,
    inPoint: source.inPoint,
    outPoint: source.outPoint,
    transform: structuredClone(source.transform),
    opacity: structuredClone(source.opacity),
    components: [{
      type: "video",
      props: {
        asset: input.asset.id,
        fit,
        trimStart: 0,
        gain: staticProp(1),
        footageQuality: "original",
      },
    }],
  };

  const { project: withBin, binId } = ensureSubjectExtractBin(
    project,
    input.assetsBinId,
    input.extractBinId,
  );
  const asset: AssetEntry = { ...input.asset, binId };

  const withLayers: Project = {
    ...withBin,
    assets: [...withBin.assets, asset].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
    compositions: withBin.compositions.map((c) =>
      c.id === input.compId && c.kind === "timeline"
        ? { ...c, objects: [...c.objects, layer] }
        : c,
    ),
  };
  return appendTreeEntry(withLayers, { kind: "asset", id: asset.id }, binId);
}

/** レイヤー名 suffix（v1: Person）。 */
export function subjectExtractLayerName(sourceName: string, target: SubjectExtractTarget): string {
  const label = target === "person" ? "Person" : target;
  return `${sourceName} — ${label}`;
}
