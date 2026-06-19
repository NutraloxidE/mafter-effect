import { describe, expect, it } from "vitest";
import type { EffectDef } from "../src/runtime/plugin";
import { groupEffectsForPicker } from "../src/editor/effectCategories";

function mockEffect(type: string, category?: string): EffectDef {
  return {
    type,
    label: type,
    category,
    previewBakeRequired: false,
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

  it("orders lightweight distortion after full distortion", () => {
    const grouped = groupEffectsForPicker([
      mockEffect("fastWave", "ディストーション（軽量）"),
      mockEffect("wave", "ディストーション"),
    ]);
    expect(grouped.map((g) => g.category)).toEqual(["ディストーション", "ディストーション（軽量）"]);
  });
});
