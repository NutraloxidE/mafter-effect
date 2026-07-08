import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { defaultTransform, staticProp } from "../src/core/props";
import {
  applySubjectExtractToProject,
  resolveSubjectExtractAssetSize,
  subjectExtractLayerName,
} from "../src/editor/subjectExtract/applySubjectExtract";
import {
  ASSETS_BIN_NAME,
  SUBJECT_EXTRACT_BIN_NAME,
  ensureSubjectExtractBin,
  subjectExtractAssetIds,
} from "../src/editor/subjectExtract/subjectExtractBin";
import type { AssetEntry, Project, SceneObject, TimelineComposition } from "../src/core/schema";

function projectWithObjects(objects: SceneObject[]): Project {
  const project = createProject({ now: "2026-07-05T00:00:00.000Z" });
  const compId = project.rootComposition;
  return {
    ...project,
    compositions: project.compositions.map((c) =>
      c.id === compId && c.kind === "timeline" ? { ...c, objects } : c,
    ),
  };
}

describe("ensureSubjectExtractBin", () => {
  it("creates Assets/VideoSubjectExtract nested bins", () => {
    const { project, binId } = ensureSubjectExtractBin(projectWithObjects([]), "BINASSETS01", "BINEXTR01");
    const assetsBin = project.bins!.find((b) => b.name === ASSETS_BIN_NAME && b.parentId === null);
    const extractBin = project.bins!.find((b) => b.name === SUBJECT_EXTRACT_BIN_NAME);
    expect(assetsBin).toBeDefined();
    expect(extractBin?.parentId).toBe(assetsBin!.id);
    expect(binId).toBe(extractBin!.id);
  });

  it("reuses existing bins", () => {
    const first = ensureSubjectExtractBin(projectWithObjects([]), "BINASSETS01", "BINEXTR01");
    const second = ensureSubjectExtractBin(first.project, "BINASSETS02", "BINEXTR02");
    expect(second.binId).toBe(first.binId);
    expect(second.project.bins!.length).toBe(first.project.bins!.length);
  });
});

describe("resolveSubjectExtractAssetSize", () => {
  const extracted = { width: 640, height: 360 };

  it("prefers the source asset's native size when valid", () => {
    expect(resolveSubjectExtractAssetSize({ width: 1920, height: 1080 }, extracted)).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it("falls back to extracted size when source meta is undefined", () => {
    expect(resolveSubjectExtractAssetSize(undefined, extracted)).toEqual(extracted);
  });

  it("falls back to extracted size when source meta is missing width/height", () => {
    expect(resolveSubjectExtractAssetSize({}, extracted)).toEqual(extracted);
  });

  it("falls back to extracted size when source width/height is zero or negative", () => {
    expect(resolveSubjectExtractAssetSize({ width: 0, height: 1080 }, extracted)).toEqual(extracted);
    expect(resolveSubjectExtractAssetSize({ width: 1920, height: -1 }, extracted)).toEqual(extracted);
  });

  it("falls back to extracted size when source width/height is not a finite number", () => {
    expect(resolveSubjectExtractAssetSize({ width: "1920", height: 1080 }, extracted)).toEqual(extracted);
    expect(resolveSubjectExtractAssetSize({ width: NaN, height: 1080 }, extracted)).toEqual(extracted);
    expect(resolveSubjectExtractAssetSize({ width: Infinity, height: 1080 }, extracted)).toEqual(extracted);
  });
});

describe("applySubjectExtractToProject", () => {
  const source: SceneObject = {
    id: "OBJSRC01",
    name: "Footage",
    parent: null,
    zOrder: 2,
    enabled: true,
    inPoint: 0,
    outPoint: 60,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [{ type: "video", props: { asset: "ASTSRC01", fit: "contain", trimStart: 0 } }],
  };

  const asset: AssetEntry = {
    id: "ASTNEW01",
    path: "assets/ASTNEW01.webm",
    kind: "video",
    meta: { hasAlpha: true },
  };

  it("adds layer above source with zOrder + 0.5", () => {
    const base = projectWithObjects([source]);
    const compId = base.rootComposition;
    const after = applySubjectExtractToProject(base, {
      compId,
      sourceLayer: source,
      asset,
      layerId: "OBJNEW01",
      layerName: "Footage — Person",
      assetsBinId: "BINASSETS01",
      extractBinId: "BINEXTR01",
      target: "person",
    });
    const comp = after.compositions[0] as TimelineComposition;
    const newLayer = comp.objects.find((o) => o.id === "OBJNEW01");
    expect(newLayer?.zOrder).toBe(2.5);
    expect(newLayer?.inPoint).toBe(0);
    expect(newLayer?.outPoint).toBe(60);
    expect(comp.objects).toHaveLength(2);
  });

  it("places asset in VideoSubjectExtract bin", () => {
    const base = projectWithObjects([source]);
    const compId = base.rootComposition;
    const after = applySubjectExtractToProject(base, {
      compId,
      sourceLayer: source,
      asset,
      layerId: "OBJNEW01",
      layerName: subjectExtractLayerName("Footage", "person"),
      assetsBinId: "BINASSETS01",
      extractBinId: "BINEXTR01",
      target: "person",
    });
    expect(subjectExtractAssetIds(after)).toContain("ASTNEW01");
    const stored = after.assets.find((a) => a.id === "ASTNEW01");
    expect(stored?.binId).toBeDefined();
  });

  it("initializes footageQuality to 'low' for packed alpha assets (decode-bound avoidance, §16.2b 2026-07 change)", () => {
    const base = projectWithObjects([source]);
    const packedAsset: AssetEntry = { ...asset, meta: { hasAlpha: true, alphaMode: "packed" } };
    const after = applySubjectExtractToProject(base, {
      compId: base.rootComposition,
      sourceLayer: source,
      asset: packedAsset,
      layerId: "OBJNEW01",
      layerName: "Footage — Person",
      assetsBinId: "BINASSETS01",
      extractBinId: "BINEXTR01",
      target: "person",
    });
    const comp = after.compositions[0] as TimelineComposition;
    const newLayer = comp.objects.find((o) => o.id === "OBJNEW01");
    expect(newLayer?.components[0]?.props["footageQuality"]).toBe("low");
  });

  it("keeps footageQuality at 'original' for split/unified assets (no proxy tier system)", () => {
    const base = projectWithObjects([source]);
    const after = applySubjectExtractToProject(base, {
      compId: base.rootComposition,
      sourceLayer: source,
      asset,
      layerId: "OBJNEW01",
      layerName: "Footage — Person",
      assetsBinId: "BINASSETS01",
      extractBinId: "BINEXTR01",
      target: "person",
    });
    const comp = after.compositions[0] as TimelineComposition;
    const newLayer = comp.objects.find((o) => o.id === "OBJNEW01");
    expect(newLayer?.components[0]?.props["footageQuality"]).toBe("original");
  });
});
