import { describe, expect, it } from "vitest";
import { applyFontAssetMigration, planFontAssetMigration } from "../src/editor/migrateFontAssetPaths";
import type { Project } from "../src/core/schema";

function projectWith(assets: { id: string; path: string; kind: "font" | "image" }[]): Project {
  return { assets: assets.map((a) => ({ ...a, meta: {} })) } as unknown as Project;
}

describe("planFontAssetMigration", () => {
  it("moves legacy assets/<id>.ttf fonts under assets/font/", () => {
    const p = projectWith([{ id: "F1", path: "assets/F1.ttf", kind: "font" }]);
    expect(planFontAssetMigration(p)).toEqual([{ id: "F1", from: "assets/F1.ttf", to: "assets/font/F1.ttf" }]);
  });

  it("keeps the original extension", () => {
    const p = projectWith([{ id: "F1", path: "assets/F1.woff2", kind: "font" }]);
    expect(planFontAssetMigration(p)[0]?.to).toBe("assets/font/F1.woff2");
  });

  it("leaves already-migrated fonts and non-font assets alone", () => {
    const p = projectWith([
      { id: "F1", path: "assets/font/F1.ttf", kind: "font" },
      { id: "I1", path: "assets/I1.png", kind: "image" },
    ]);
    expect(planFontAssetMigration(p)).toEqual([]);
  });
});

describe("applyFontAssetMigration", () => {
  it("rewrites only the moved paths and returns the same object when nothing moved", () => {
    const p = projectWith([
      { id: "F1", path: "assets/F1.ttf", kind: "font" },
      { id: "I1", path: "assets/I1.png", kind: "image" },
    ]);
    const next = applyFontAssetMigration(p, planFontAssetMigration(p));
    expect(next.assets.map((a) => a.path)).toEqual(["assets/font/F1.ttf", "assets/I1.png"]);
    expect(applyFontAssetMigration(p, [])).toBe(p);
  });
});
