import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";
import { newAssetId } from "../src/core/ids";
import type { AssetEntry, TimelineComposition } from "../src/core/schema";
import { useEditorStore } from "../src/editor/store";

function addAsset(entry: Omit<AssetEntry, "id"> & { id?: string }): AssetEntry {
  const asset: AssetEntry = { id: entry.id ?? newAssetId(), ...entry };
  const project = useEditorStore.getState().project!;
  useEditorStore.setState({
    project: { ...project, assets: [...project.assets, asset] },
  });
  return asset;
}

describe("addCompositionFromAsset", () => {
  beforeEach(() => {
    useEditorStore.getState().newProject();
  });

  it("creates a comp sized to an image asset with default duration", () => {
    const asset = addAsset({ path: "assets/x.png", kind: "image", meta: { width: 640, height: 480 } });
    const compId = useEditorStore.getState().addCompositionFromAsset(asset.id);
    expect(compId).not.toBeNull();
    const comp = useEditorStore.getState().project!.compositions.find((c) => c.id === compId) as TimelineComposition;
    expect(comp.width).toBe(640);
    expect(comp.height).toBe(480);
    expect(comp.fps).toBe(30);
    expect(comp.duration).toBe(150);
    expect(comp.objects).toHaveLength(1);
    expect(comp.objects[0]?.components[0]?.type).toBe("image");
    expect(comp.objects[0]?.components[0]?.props["asset"]).toBe(asset.id);
    expect(useEditorStore.getState().currentCompId).toBe(compId);
    expect(useEditorStore.getState().selectedObjectIds).toEqual([comp.objects[0]?.id]);
  });

  it("creates a comp sized and timed to a video asset", () => {
    const asset = addAsset({
      path: "assets/clip.mp4",
      kind: "video",
      meta: { width: 3840, height: 2160, duration: 4.2 },
    });
    const compId = useEditorStore.getState().addCompositionFromAsset(asset.id);
    const comp = useEditorStore.getState().project!.compositions.find((c) => c.id === compId) as TimelineComposition;
    expect(comp.width).toBe(3840);
    expect(comp.height).toBe(2160);
    expect(comp.duration).toBe(Math.round(4.2 * 30));
    expect(comp.name).toBe("clip");
    expect(comp.objects[0]?.components[0]?.type).toBe("video");
  });

  it("falls back to a default duration when video meta.duration is missing or invalid", () => {
    const asset = addAsset({ path: "assets/clip2.mp4", kind: "video", meta: { width: 1280, height: 720 } });
    const compId = useEditorStore.getState().addCompositionFromAsset(asset.id);
    const comp = useEditorStore.getState().project!.compositions.find((c) => c.id === compId) as TimelineComposition;
    expect(comp.duration).toBe(150);

    const asset2 = addAsset({
      path: "assets/clip3.mp4",
      kind: "video",
      meta: { width: 1280, height: 720, duration: -1 },
    });
    const compId2 = useEditorStore.getState().addCompositionFromAsset(asset2.id);
    const comp2 = useEditorStore.getState().project!.compositions.find((c) => c.id === compId2) as TimelineComposition;
    expect(comp2.duration).toBe(150);
  });

  it("falls back to 1920x1080 when meta.width/height are missing", () => {
    const asset = addAsset({ path: "assets/noMeta.png", kind: "image" });
    const compId = useEditorStore.getState().addCompositionFromAsset(asset.id);
    const comp = useEditorStore.getState().project!.compositions.find((c) => c.id === compId) as TimelineComposition;
    expect(comp.width).toBe(1920);
    expect(comp.height).toBe(1080);
  });

  it("returns null and creates nothing for non-image/video asset kinds", () => {
    const audio = addAsset({ path: "assets/a.mp3", kind: "audio", meta: { duration: 3 } });
    const before = useEditorStore.getState().project!;
    const result = useEditorStore.getState().addCompositionFromAsset(audio.id);
    expect(result).toBeNull();
    const after = useEditorStore.getState().project!;
    expect(after.compositions.length).toBe(before.compositions.length);
    expect(after.assets.length).toBe(before.assets.length);
  });

  it("returns null for an unknown asset id", () => {
    expect(useEditorStore.getState().addCompositionFromAsset("does-not-exist")).toBeNull();
  });

  it("does not add the new layer to the previously active composition", () => {
    const originalCompId = useEditorStore.getState().currentCompId!;
    const asset = addAsset({ path: "assets/y.png", kind: "image", meta: { width: 100, height: 100 } });
    useEditorStore.getState().addCompositionFromAsset(asset.id);

    const originalComp = useEditorStore
      .getState()
      .project!.compositions.find((c) => c.id === originalCompId) as TimelineComposition;
    expect(originalComp.objects).toHaveLength(0);
    expect(useEditorStore.getState().currentCompId).not.toBe(originalCompId);
  });
});
