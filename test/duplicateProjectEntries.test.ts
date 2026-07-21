import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { appendTreeEntry, createBinInProject, orderedEntriesForParent } from "../src/core/projectTree";
import { defaultTransform, staticProp } from "../src/core/props";
import type { AssetEntry, Project, SceneObject, TimelineComposition } from "../src/core/schema";
import {
  duplicateProjectEntries,
  nextAvailableProjectItemName,
  normalizeProjectCopyRoots,
  type ProjectEntryIdFactory,
} from "../src/editor/duplicateProjectEntries";

function deterministicIds(): ProjectEntryIdFactory {
  const counts = { asset: 0, bin: 0, comp: 0, object: 0, vertex: 0 };
  return {
    asset: () => `asset-copy-${++counts.asset}`,
    bin: () => `bin-copy-${++counts.bin}`,
    comp: () => `comp-copy-${++counts.comp}`,
    object: () => `object-copy-${++counts.object}`,
    vertex: () => `vertex-copy-${++counts.vertex}`,
  };
}

function object(id: string, parent: string | null, components: SceneObject["components"]): SceneObject {
  return {
    id,
    name: id,
    parent,
    zOrder: parent ? 2 : 1,
    enabled: true,
    inPoint: 0,
    outPoint: 30,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components,
  };
}

function fixture(): Project {
  let project = createProject({ name: "Copy fixture" });
  project = createBinInProject(project, "folder", "Folder", null);
  project = createBinInProject(project, "child-folder", "Child", "folder");
  const asset: AssetEntry = { id: "asset", kind: "image", path: "assets/source.png", binId: "folder" };
  const nested: TimelineComposition = {
    id: "nested",
    name: "Nested",
    kind: "timeline",
    width: 100,
    height: 100,
    fps: 30,
    duration: 30,
    binId: "child-folder",
    objects: [],
  };
  const parent = object("parent", null, [{ type: "solid", props: {} }]);
  const child = object("child", "parent", [
    { type: "image", props: { asset: "asset" } },
    { type: "comp", props: { compId: "nested" } },
    {
      type: "shape",
      props: {
        vertices: [{ id: "vertex", pos: staticProp({ x: 0, y: 0, z: 0 }) }],
        mergeInputs: [{ id: "merge", objectId: "parent", op: "unite" }],
      },
    },
  ]);
  child.opacity.expression = { path: "scripts/child/opacity.js", enabled: true };
  const main: TimelineComposition = {
    id: "main",
    name: "Main",
    kind: "timeline",
    width: 100,
    height: 100,
    fps: 30,
    duration: 30,
    binId: "folder",
    objects: [parent, child],
  };
  project = {
    ...project,
    assets: [...project.assets, asset],
    compositions: [...project.compositions, main, nested],
  };
  project = appendTreeEntry(project, { kind: "asset", id: asset.id }, "folder");
  project = appendTreeEntry(project, { kind: "composition", id: main.id }, "folder");
  project = appendTreeEntry(project, { kind: "composition", id: nested.id }, "child-folder");
  return project;
}

describe("duplicateProjectEntries", () => {
  it("advances numeric suffixes only when the destination name conflicts", () => {
    expect(nextAvailableProjectItemName("Main", new Set())).toBe("Main");
    expect(nextAvailableProjectItemName("Main", new Set(["Main"]))).toBe("Main 2");
    expect(nextAvailableProjectItemName("Main", new Set(["Main", "Main 2"]))).toBe("Main 3");
    expect(nextAvailableProjectItemName("Main 2", new Set(["Main 2", "Main 3"]))).toBe("Main 4");
    expect(nextAvailableProjectItemName("Main 2", new Set())).toBe("Main 2");
  });

  it("deduplicates descendants covered by a selected folder", () => {
    const project = fixture();
    expect(normalizeProjectCopyRoots(project, [
      { kind: "bin", id: "folder" },
      { kind: "composition", id: "main" },
      { kind: "asset", id: "asset" },
    ])).toEqual([{ kind: "bin", id: "folder" }]);
  });

  it("recursively clones a folder and remaps internal project/object references", () => {
    const project = fixture();
    const result = duplicateProjectEntries(
      project,
      [{ kind: "bin", id: "folder" }],
      null,
      deterministicIds(),
    );

    expect(result.pastedEntries).toEqual([{ kind: "bin", id: "bin-copy-1" }]);
    expect(result.project.bins?.find((bin) => bin.id === "bin-copy-1")).toMatchObject({
      name: "Folder 2",
      parentId: null,
    });
    expect(result.project.bins?.find((bin) => bin.id === "bin-copy-2")).toMatchObject({
      name: "Child",
      parentId: "bin-copy-1",
    });

    const copiedMain = result.project.compositions.find((comp) => comp.name === "Main" && comp.id.startsWith("comp-copy-"));
    expect(copiedMain?.name).toBe("Main");
    expect(copiedMain?.binId).toBe("bin-copy-1");
    expect(copiedMain?.kind).toBe("timeline");
    if (!copiedMain || copiedMain.kind !== "timeline") throw new Error("missing copied timeline comp");
    const copiedParent = copiedMain.objects.find((item) => item.name === "parent")!;
    const copiedChild = copiedMain.objects.find((item) => item.name === "child")!;
    expect(copiedChild.parent).toBe(copiedParent.id);
    expect(copiedChild.opacity.expression?.path).toBe(`scripts/${copiedChild.id}/opacity.js`);
    expect(copiedChild.components[0]?.props["asset"]).toBe("asset-copy-1");
    const copiedNested = result.project.compositions.find((comp) => comp.name === "Nested" && comp.id.startsWith("comp-copy-"));
    expect(copiedChild.components[1]?.props["compId"]).toBe(copiedNested?.id);
    const shape = copiedChild.components[2]!;
    expect((shape.props["vertices"] as Array<{ id: string }>)[0]?.id).not.toBe("vertex");
    expect((shape.props["mergeInputs"] as Array<{ objectId: string }>)[0]?.objectId).toBe(copiedParent.id);
    expect(result.objectScriptCopies).toEqual(expect.arrayContaining([
      { from: "parent", to: copiedParent.id },
      { from: "child", to: copiedChild.id },
    ]));

    expect(orderedEntriesForParent(result.project, "bin-copy-1").map((entry) => entry.kind)).toEqual([
      "bin",
      "asset",
      "composition",
    ]);
  });

  it("pastes a direct comp into the requested folder and keeps external references", () => {
    const project = fixture();
    const result = duplicateProjectEntries(
      project,
      [{ kind: "composition", id: "main" }],
      "child-folder",
      deterministicIds(),
    );
    const copied = result.project.compositions.find((comp) => comp.id === "comp-copy-1");
    expect(copied).toMatchObject({ name: "Main", binId: "child-folder" });
    if (!copied || copied.kind !== "timeline") throw new Error("missing copied timeline comp");
    const child = copied.objects.find((item) => item.name === "child")!;
    expect(child.components[0]?.props["asset"]).toBe("asset");
    expect(child.components[1]?.props["compId"]).toBe("nested");
  });

  it("increments an existing numeric suffix in the same folder", () => {
    const project = fixture();
    const main = project.compositions.find((comp) => comp.id === "main")!;
    project.compositions.push({ ...main, id: "main-2", name: "Main 2" });
    const withOrder = appendTreeEntry(project, { kind: "composition", id: "main-2" }, "folder");

    const result = duplicateProjectEntries(
      withOrder,
      [{ kind: "composition", id: "main-2" }],
      "folder",
      deterministicIds(),
    );

    expect(result.project.compositions.find((comp) => comp.id === "comp-copy-1")?.name).toBe("Main 3");
  });
});
