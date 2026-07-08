import { staticProp } from "../../core/props";
import { appendTreeEntry } from "../../core/projectTree";
import type { AssetEntry, Project, SceneObject } from "../../core/schema";
import { ensureSubjectExtractBin } from "./subjectExtractBin";

/**
 * 新規 Subject Extract レイヤーの初期 Preview Quality。packed alpha は原本のままだと
 * decode-bound（§16.2b）になり得るため、既定選択そのものを保守的な proxy tier にする
 * （"Original" を選んだ場合に黙って差し替えることはしない・2026-07 変更）。
 * split/unified は proxy tier の仕組みが無いため従来通り "original"。
 */
function initialFootageQuality(asset: AssetEntry): "original" | "low" {
  return asset.meta?.["alphaMode"] === "packed" ? "low" : "original";
}

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
        footageQuality: initialFootageQuality(input.asset),
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

export interface SubjectExtractAssetSize {
  width: number;
  height: number;
}

/**
 * 新規 asset.meta の width/height。ソース video asset の原寸を優先し、
 * 欠落・非数値・0 以下なら抽出結果の解像度へフォールバック。
 * 抽出レイヤーは常にソースと同じ大きさ・位置で表示される（§16.2）。
 */
export function resolveSubjectExtractAssetSize(
  sourceAssetMeta: Record<string, unknown> | undefined,
  extracted: SubjectExtractAssetSize,
): SubjectExtractAssetSize {
  const w = sourceAssetMeta?.["width"];
  const h = sourceAssetMeta?.["height"];
  if (
    typeof w === "number" && Number.isFinite(w) && w > 0 &&
    typeof h === "number" && Number.isFinite(h) && h > 0
  ) {
    return { width: w, height: h };
  }
  return { width: extracted.width, height: extracted.height };
}
