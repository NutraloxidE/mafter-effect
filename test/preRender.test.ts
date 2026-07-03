import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { defaultTransform, staticProp } from "../src/core/props";
import { createBinInProject, orderedEntriesForParent, ROOT_TREE_KEY } from "../src/core/projectTree";
import type { AssetEntry, SceneObject, TimelineComposition } from "../src/core/schema";
import {
  applyPreRenderToProject,
  ensurePreRenderedBin,
  PRE_RENDERED_BIN_NAME,
  preRenderedAssetIds,
} from "../src/editor/preRender";

function solid(id: string, zOrder: number, locked?: boolean): SceneObject {
  return {
    id,
    name: id,
    parent: null,
    zOrder,
    enabled: true,
    locked,
    inPoint: 0,
    outPoint: 150,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [{ type: "solid", props: { color: "#f00", width: 100, height: 100 } }],
  };
}

describe("applyPreRenderToProject", () => {
  it("hides unlocked layers, keeps locked enabled, adds top video + asset in pre-rendered bin", () => {
    const project = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const compId = project.rootComposition;
    const comp = project.compositions.find((c) => c.id === compId) as TimelineComposition;
    const locked = solid("01LOCKED", 1, true);
    const unlocked = solid("01OPEN", 2);
    const alreadyHidden = { ...solid("01HIDDEN", 3), enabled: false };
    comp.objects = [locked, unlocked, alreadyHidden];

    const asset: AssetEntry = {
      id: "01ASSET",
      path: "assets/01ASSET.mp4",
      kind: "video",
      meta: { width: 1920, height: 1080, duration: 5, mime: "video/mp4" },
    };

    const after = applyPreRenderToProject(project, {
      compId,
      asset,
      layerId: "01PRERENDER",
      layerName: "Pre-render Main",
      range: [10, 50],
      preRenderedBinId: "01PRBIN",
    });

    const tl = after.compositions.find((c) => c.id === compId) as TimelineComposition;
    const byId = new Map(tl.objects.map((o) => [o.id, o]));

    expect(byId.get("01LOCKED")?.enabled).toBe(true);
    expect(byId.get("01LOCKED")?.locked).toBe(true);
    expect(byId.get("01OPEN")?.enabled).toBe(false);
    expect(byId.get("01HIDDEN")?.enabled).toBe(false);

    const video = byId.get("01PRERENDER");
    expect(video).toBeDefined();
    expect(video!.zOrder).toBe(4);
    expect(video!.inPoint).toBe(10);
    expect(video!.outPoint).toBe(50);
    expect(video!.enabled).toBe(true);
    expect(video!.components[0]?.type).toBe("video");
    expect(video!.components[0]?.props["asset"]).toBe("01ASSET");
    expect(video!.components[0]?.props["fit"]).toBe("fill");

    const stored = after.assets.find((a) => a.id === "01ASSET");
    expect(stored?.binId).toBe("01PRBIN");
    const bin = after.bins?.find((b) => b.id === "01PRBIN");
    expect(bin?.name).toBe(PRE_RENDERED_BIN_NAME);
    expect(bin?.parentId).toBe(null);
    expect(preRenderedAssetIds(after)).toEqual(["01ASSET"]);
    expect(orderedEntriesForParent(after, null).some((e) => e.id === "01ASSET")).toBe(false);
    expect(orderedEntriesForParent(after, null).some((e) => e.kind === "bin" && e.id === "01PRBIN")).toBe(true);
    expect(tl.objects).toHaveLength(4);
  });

  it("reuses existing pre-rendered bin and appends assets", () => {
    let project = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const compId = project.rootComposition;
    const comp = project.compositions.find((c) => c.id === compId) as TimelineComposition;
    comp.objects = [solid("01A", 1)];
    project = createBinInProject(project, "01EXISTING", PRE_RENDERED_BIN_NAME, null);

    const first = applyPreRenderToProject(project, {
      compId,
      asset: { id: "01A1", path: "assets/01A1.mp4", kind: "video", meta: {} },
      layerId: "01L1",
      layerName: "Pre-render 1",
      range: [0, 150],
      preRenderedBinId: "01UNUSED",
    });
    expect(first.bins?.some((b) => b.id === "01UNUSED")).toBe(false);
    expect(first.assets.find((a) => a.id === "01A1")?.binId).toBe("01EXISTING");

    const second = applyPreRenderToProject(first, {
      compId,
      asset: { id: "01A2", path: "assets/01A2.mp4", kind: "video", meta: {} },
      layerId: "01L2",
      layerName: "Pre-render 2",
      range: [0, 150],
      preRenderedBinId: "01UNUSED2",
    });
    expect(preRenderedAssetIds(second)).toEqual(["01A1", "01A2"]);
    expect(second.bins?.filter((b) => b.name === PRE_RENDERED_BIN_NAME)).toHaveLength(1);
  });

  it("uses full-comp range when range is full duration", () => {
    const project = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const compId = project.rootComposition;
    const comp = project.compositions.find((c) => c.id === compId) as TimelineComposition;
    comp.objects = [solid("01A", 1)];

    const asset: AssetEntry = {
      id: "01ASSET2",
      path: "assets/01ASSET2.webm",
      kind: "video",
      meta: {},
    };

    const after = applyPreRenderToProject(project, {
      compId,
      asset,
      layerId: "01PR2",
      layerName: "Pre-render",
      range: [0, 150],
      preRenderedBinId: "01PRBIN2",
    });
    const tl = after.compositions.find((c) => c.id === compId) as TimelineComposition;
    const video = tl.objects.find((o) => o.id === "01PR2")!;
    expect(video.inPoint).toBe(0);
    expect(video.outPoint).toBe(150);
    expect(tl.objects.find((o) => o.id === "01A")?.enabled).toBe(false);
  });
});

describe("ensurePreRenderedBin", () => {
  it("creates root bin when missing", () => {
    const project = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const { project: next, binId } = ensurePreRenderedBin(project, "01NEWBIN");
    expect(binId).toBe("01NEWBIN");
    expect(next.bins?.find((b) => b.id === "01NEWBIN")?.name).toBe(PRE_RENDERED_BIN_NAME);
    expect(next.treeOrder?.[ROOT_TREE_KEY]?.some((e) => e.id === "01NEWBIN")).toBe(true);
  });
});
