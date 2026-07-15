import { describe, expect, it } from "vitest";
import {
  addFontAssetToProject,
  ensureFontsBin,
  fontBinAssetIds,
  FONTS_BIN_NAME,
  migrateFontAssetsToBin,
  strayFontAssetIds,
} from "../src/editor/fontBin";
import { orderedEntriesForParent } from "../src/core/projectTree";
import type { AssetEntry, Project } from "../src/core/schema";

function font(id: string, binId?: string): AssetEntry {
  return { id, path: `assets/font/${id}.ttf`, kind: "font", meta: { family: "Noto Sans", weight: 400 }, ...(binId ? { binId } : {}) };
}

function projectWith(assets: AssetEntry[]): Project {
  return { assets, compositions: [], bins: undefined, treeOrder: undefined } as unknown as Project;
}

describe("ensureFontsBin", () => {
  it("creates a root-level fonts bin once and reuses it", () => {
    const p = projectWith([]);
    const first = ensureFontsBin(p, "B1");
    expect(first.project.bins).toEqual([{ id: "B1", name: FONTS_BIN_NAME, parentId: null }]);

    const second = ensureFontsBin(first.project, "B2");
    expect(second.binId).toBe("B1");
    expect(second.project).toBe(first.project);
  });
});

describe("addFontAssetToProject", () => {
  it("puts the asset in the fonts bin instead of the project root", () => {
    const p = addFontAssetToProject(projectWith([]), font("F1"), "B1");
    expect(p.assets[0]?.binId).toBe("B1");
    expect(fontBinAssetIds(p)).toEqual(["F1"]);
    expect(orderedEntriesForParent(p, null)).toEqual([{ kind: "bin", id: "B1" }]);
  });

  it("keeps assets id-sorted (§3 直列化)", () => {
    let p = addFontAssetToProject(projectWith([]), font("F2"), "B1");
    p = addFontAssetToProject(p, font("F1"), "B2");
    expect(p.assets.map((a) => a.id)).toEqual(["F1", "F2"]);
    expect(fontBinAssetIds(p)).toEqual(["F2", "F1"]);
  });
});

describe("migrateFontAssetsToBin", () => {
  it("moves root-level fonts into the fonts bin", () => {
    const p = migrateFontAssetsToBin(projectWith([font("F1"), font("F2")]), "B1");
    expect(strayFontAssetIds(p)).toEqual([]);
    expect(fontBinAssetIds(p)).toEqual(["F1", "F2"]);
    expect(orderedEntriesForParent(p, null)).toEqual([{ kind: "bin", id: "B1" }]);
  });

  it("leaves fonts the user filed elsewhere alone", () => {
    const p = projectWith([font("F1", "USER-BIN")]);
    expect(migrateFontAssetsToBin(p, "B1")).toBe(p);
  });

  it("is a no-op without fonts and reuses an existing fonts bin", () => {
    const empty = projectWith([]);
    expect(migrateFontAssetsToBin(empty, "B1")).toBe(empty);

    const { project: withBin } = ensureFontsBin(projectWith([font("F1")]), "B1");
    const p = migrateFontAssetsToBin(withBin, "B2");
    expect(p.bins?.map((b) => b.id)).toEqual(["B1"]);
    expect(fontBinAssetIds(p)).toEqual(["F1"]);
  });
});
