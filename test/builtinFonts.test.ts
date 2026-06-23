import { describe, expect, it } from "vitest";
import {
  BUILTIN_FONTS,
  findBuiltinFontByFamily,
  fontUsesFamily,
  isBuiltinFontFamily,
  nearestBuiltinWeight,
} from "../src/runtime/builtinFonts";

describe("§26.3.2 builtin fonts", () => {
  it("exposes Noto Sans and Noto Sans JP with 3 weights each", () => {
    const families = BUILTIN_FONTS.map((f) => f.family);
    expect(families).toContain("Noto Sans");
    expect(families).toContain("Noto Sans JP");
    for (const f of BUILTIN_FONTS) {
      expect(f.weights.map((w) => w.weight)).toEqual([400, 500, 700]);
    }
  });

  it("detects built-in family at the head of a font stack", () => {
    expect(isBuiltinFontFamily("'Noto Sans', sans-serif")).toBe(true);
    expect(isBuiltinFontFamily("'Noto Sans JP', sans-serif")).toBe(true);
    expect(isBuiltinFontFamily("Arial, sans-serif")).toBe(false);
    // family only as a fallback (not head) must not match
    expect(fontUsesFamily("Arial, 'Noto Sans'", "Noto Sans")).toBe(false);
  });

  it("snaps an arbitrary weight to the nearest bundled weight", () => {
    const def = findBuiltinFontByFamily("Noto Sans")!;
    expect(nearestBuiltinWeight(def, 100).weight).toBe(400);
    expect(nearestBuiltinWeight(def, 450).weight).toBe(400);
    expect(nearestBuiltinWeight(def, 600).weight).toBe(500);
    expect(nearestBuiltinWeight(def, 900).weight).toBe(700);
  });
});
