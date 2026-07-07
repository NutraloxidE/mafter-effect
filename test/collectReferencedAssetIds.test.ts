import { describe, expect, it } from "vitest";
import type { Project, SceneObject, TimelineComposition } from "../src/core/schema";
import { collectReferencedAssetIds } from "../src/runtime/collectReferencedAssetIds";

function transform() {
  return {
    anchor: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
    position: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
    rotation: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
    scale: { value: { x: 1, y: 1, z: 1 }, keyframes: [] },
  };
}

function obj(id: string, components: SceneObject["components"]): SceneObject {
  return {
    id,
    name: id,
    parent: null,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 90,
    transform: transform(),
    opacity: { value: 1, keyframes: [] },
    components,
  };
}

function comp(id: string, objects: SceneObject[]): TimelineComposition {
  return { id, name: id, kind: "timeline", width: 1920, height: 1080, fps: 30, duration: 90, objects };
}

function project(compositions: TimelineComposition[], rootComposition: string): Project {
  return {
    schemaVersion: 1,
    meta: { name: "Test", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    assets: [],
    compositions,
    rootComposition,
    pluginRefs: [],
  };
}

describe("collectReferencedAssetIds", () => {
  it("collects image/video asset refs directly on the root comp", () => {
    const root = comp("root", [
      obj("o1", [{ type: "image", props: { asset: "img1" } }]),
      obj("o2", [{ type: "video", props: { asset: "vid1" } }]),
      obj("o3", [{ type: "text", props: {} }]),
    ]);
    const p = project([root], "root");
    expect(collectReferencedAssetIds(p, "root")).toEqual(new Set(["img1", "vid1"]));
  });

  it("recurses into nested comp components", () => {
    const child = comp("child", [obj("c1", [{ type: "video", props: { asset: "nestedVid" } }])]);
    const root = comp("root", [
      obj("o1", [{ type: "image", props: { asset: "topImg" } }]),
      obj("o2", [{ type: "comp", props: { compId: "child" } }]),
    ]);
    const p = project([root, child], "root");
    expect(collectReferencedAssetIds(p, "root")).toEqual(new Set(["topImg", "nestedVid"]));
  });

  it("guards against circular comp references", () => {
    const a = comp("a", [
      obj("a1", [{ type: "video", props: { asset: "vidA" } }]),
      obj("a2", [{ type: "comp", props: { compId: "b" } }]),
    ]);
    const b = comp("b", [
      obj("b1", [{ type: "video", props: { asset: "vidB" } }]),
      obj("b2", [{ type: "comp", props: { compId: "a" } }]), // circular back-reference
    ]);
    const p = project([a, b], "a");
    // 循環しても止まり、到達可能な両方の asset を集める。
    expect(collectReferencedAssetIds(p, "a")).toEqual(new Set(["vidA", "vidB"]));
  });

  it("returns an empty set for an unknown root comp id", () => {
    const root = comp("root", [obj("o1", [{ type: "video", props: { asset: "vid1" } }])]);
    const p = project([root], "root");
    expect(collectReferencedAssetIds(p, "does-not-exist")).toEqual(new Set());
  });
});
