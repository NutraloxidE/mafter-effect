import { describe, expect, it } from "vitest";
import { defaultTransform, staticProp } from "../src/core/props";
import type { SceneObject } from "../src/core/schema";
import {
  defaultLabelIndexForObject,
  isLabelIndex,
  labelBarColor,
  LAYER_LABEL_COLORS,
  timelineBarFill,
} from "../src/editor/layerLabels";

function baseObj(patch: Partial<SceneObject> = {}): SceneObject {
  return {
    id: "01TEST",
    name: "Test",
    parent: null,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 30,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [],
    ...patch,
  };
}

describe("layerLabels", () => {
  it("has AE palette + legacy beige entries", () => {
    expect(LAYER_LABEL_COLORS).toHaveLength(17);
    expect(LAYER_LABEL_COLORS[16]).toBe("#b89b6a");
  });

  it("isLabelIndex accepts 0–16 only", () => {
    expect(isLabelIndex(0)).toBe(true);
    expect(isLabelIndex(16)).toBe(true);
    expect(isLabelIndex(15)).toBe(true);
    expect(isLabelIndex(17)).toBe(false);
    expect(isLabelIndex(-1)).toBe(false);
  });

  it("labelBarColor returns neutral for undefined", () => {
    expect(labelBarColor(undefined)).toBe("#4a4a4a");
    expect(labelBarColor(0)).toBe(LAYER_LABEL_COLORS[0]);
  });

  it("defaultLabelIndexForObject maps layer kinds", () => {
    expect(defaultLabelIndexForObject(baseObj({
      components: [{ type: "solid", props: {} }],
    }))).toBe(0);
    expect(defaultLabelIndexForObject(baseObj({
      components: [{ type: "text", props: {} }],
    }))).toBe(1);
    expect(defaultLabelIndexForObject(baseObj({
      components: [{ type: "image", props: {} }],
    }))).toBe(2);
    expect(defaultLabelIndexForObject(baseObj({
      components: [{ type: "camera", props: {} }],
    }))).toBe(7);
    expect(defaultLabelIndexForObject(baseObj({ isNull: true }))).toBe(4);
    expect(defaultLabelIndexForObject(baseObj({ isAdjustment: true }))).toBe(5);
    expect(defaultLabelIndexForObject(baseObj({
      components: [{ type: "html", props: {} }],
    }))).toBe(9);
    expect(defaultLabelIndexForObject(baseObj({
      components: [{ type: "plugin-gradient", props: {} }],
    }))).toBe(14);
  });

  it("timelineBarFill uses label color and brightens when selected", () => {
    expect(timelineBarFill(0, false)).toBe(LAYER_LABEL_COLORS[0]);
    expect(timelineBarFill(0, true)).not.toBe(LAYER_LABEL_COLORS[0]);
    expect(timelineBarFill(undefined, false)).toBe("#4a4a4a");
    expect(timelineBarFill(undefined, true)).toBe("#5a5a5a");
  });
});
