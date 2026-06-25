import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { newAssetId, newBinId, newCompId } from "../src/core/ids";
import {
  appendTreeEntry,
  createBinInProject,
  deleteBinFromProject,
  ensureProjectTree,
  moveTreeEntries,
  orderedEntriesForParent,
  registerNewProjectItem,
  ROOT_TREE_KEY,
} from "../src/core/projectTree";
import { canonicalizeProject, serializeProject } from "../src/core/serialize";
import type { AssetEntry, Project, ProjectTreeEntry } from "../src/core/schema";
import { validateProject } from "../src/core/validate";

describe("projectTree", () => {
  it("legacy project without bins gets default root order from id sort", () => {
    const p = createProject();
    const ensured = ensureProjectTree(p);
    const root = orderedEntriesForParent(ensured, null);
    expect(root).toHaveLength(1);
    expect(root[0]).toEqual({ kind: "composition", id: p.rootComposition });
  });

  it("createBin and append composition preserve treeOrder", () => {
    const p = createProject();
    const binId = newBinId();
    let next = createBinInProject(p, binId, "Footage", null);
    const compId = newCompId();
    next = {
      ...next,
      compositions: [
        ...next.compositions,
        {
          id: compId,
          name: "Sub",
          kind: "timeline" as const,
          width: 1920,
          height: 1080,
          fps: 30,
          duration: 30,
          objects: [],
        },
      ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    };
    next = registerNewProjectItem(next, { kind: "composition", id: compId });

    const root = orderedEntriesForParent(next, null);
    expect(root.map((e) => e.id)).toContain(binId);
    expect(root.map((e) => e.id)).toContain(compId);
  });

  it("moveTreeEntries moves asset into bin and sets binId", () => {
    const assetId = newAssetId();
    const asset: AssetEntry = {
      id: assetId,
      path: `assets/${assetId}.png`,
      kind: "image",
    };
    let p: Project = {
      ...createProject(),
      assets: [asset],
    };
    p = registerNewProjectItem(p, { kind: "asset", id: assetId });
    const binId = newBinId();
    p = createBinInProject(p, binId, "Images", null);

    const entry: ProjectTreeEntry = { kind: "asset", id: assetId };
    p = moveTreeEntries(p, [entry], binId, 0);

    expect(p.assets[0]?.binId).toBe(binId);
    expect(orderedEntriesForParent(p, binId).map((e) => e.id)).toEqual([assetId]);
    expect(orderedEntriesForParent(p, null).some((e) => e.id === assetId)).toBe(false);
  });

  it("deleteBin moves children to parent root", () => {
    const binId = newBinId();
    const assetId = newAssetId();
    let p = createBinInProject(createProject(), binId, "Temp", null);
    p = {
      ...p,
      assets: [{ id: assetId, path: `assets/${assetId}.mp3`, kind: "audio", binId }],
    };
    p = appendTreeEntry(p, { kind: "asset", id: assetId }, binId);
    p = deleteBinFromProject(p, binId);

    expect(p.bins?.some((b) => b.id === binId)).toBe(false);
    expect(p.assets[0]?.binId).toBeUndefined();
    expect(orderedEntriesForParent(p, null).some((e) => e.id === assetId)).toBe(true);
  });
});

describe("project bins serialize", () => {
  it("omits bins and treeOrder when empty (byte compatible with legacy)", () => {
    const p = createProject();
    const text = serializeProject(p);
    expect(text).not.toContain('"bins"');
    expect(text).not.toContain('"treeOrder"');
    expect(text).not.toContain('"binId"');
  });

  it("preserves treeOrder entry order (not id sorted)", () => {
    const binId = newBinId();
    const assetId = newAssetId();
    let p = createBinInProject(createProject(), binId, "Folder", null);
    p = {
      ...p,
      assets: [{ id: assetId, path: `assets/${assetId}.png`, kind: "image" }],
    };
    p = moveTreeEntries(
      p,
      [{ kind: "bin", id: binId }, { kind: "asset", id: assetId }],
      null,
      0,
    );
    const canon = canonicalizeProject(p);
    const root = canon.treeOrder?.[ROOT_TREE_KEY] ?? [];
    expect(root[0]?.kind).toBe("bin");
    expect(root[1]?.kind).toBe("asset");
  });

  it("validate repairs unknown binId with warning", () => {
    const p: Project = {
      ...createProject(),
      assets: [
        {
          id: newAssetId(),
          path: "assets/x.png",
          kind: "image",
          binId: "missing-bin",
        },
      ],
    };
    const { project, warnings } = validateProject(p);
    expect(warnings.some((w) => w.includes("unknown binId"))).toBe(true);
    expect(project.assets[0]?.binId).toBeUndefined();
    expect(project.treeOrder?.[ROOT_TREE_KEY]?.some((e) => e.kind === "asset")).toBe(true);
  });
});
