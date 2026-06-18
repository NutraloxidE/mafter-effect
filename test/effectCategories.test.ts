import { describe, expect, it } from "vitest";
import type { EffectDef } from "../src/runtime/plugin";
import { groupEffectsForPicker } from "../src/editor/effectCategories";

function mockEffect(type: string, category?: string): EffectDef {
  return {
    type,
    label: type,
    category,
    params: [],
    apply: () => null,
  };
}

describe("groupEffectsForPicker", () => {
  it("groups by category and orders known categories first", () => {
    const grouped = groupEffectsForPicker([
      mockEffect("angularWipe", "ワイプ"),
      mockEffect("blur", "ぼかし"),
      mockEffect("wave", "ディストーション"),
      mockEffect("tint", "カラー補正"),
      mockEffect("pluginFx"),
    ]);
    expect(grouped.map((g) => g.category)).toEqual([
      "ぼかし",
      "カラー補正",
      "ディストーション",
      "ワイプ",
      "その他",
    ]);
    expect(grouped[2]?.effects.map((e) => e.type)).toEqual(["wave"]);
  });
});
