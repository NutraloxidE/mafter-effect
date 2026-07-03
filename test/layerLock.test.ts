import { describe, expect, it } from "vitest";
import type { SceneObject } from "../src/core/schema";
import {
  canEditLayer,
  isLayerLocked,
  isLockExemptPatch,
  unlockedVisibilityPatches,
} from "../src/editor/layerLock";

function baseObj(overrides: Partial<SceneObject> = {}): SceneObject {
  return {
    id: "01TEST",
    name: "Layer",
    parent: null,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 100,
    transform: {
      anchor: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
      position: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
      rotation: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
      scale: { value: { x: 1, y: 1, z: 1 }, keyframes: [] },
    },
    opacity: { value: 1, keyframes: [] },
    components: [{ type: "solid", props: {} }],
    ...overrides,
  };
}

describe("layerLock helpers", () => {
  it("isLayerLocked is true only when locked === true", () => {
    expect(isLayerLocked(baseObj())).toBe(false);
    expect(isLayerLocked(baseObj({ locked: false }))).toBe(false);
    expect(isLayerLocked(baseObj({ locked: true }))).toBe(true);
  });

  it("isLockExemptPatch allows locked, enabled, labelIndex only", () => {
    expect(isLockExemptPatch({ enabled: false })).toBe(true);
    expect(isLockExemptPatch({ locked: true })).toBe(true);
    expect(isLockExemptPatch({ labelIndex: 3 })).toBe(true);
    expect(isLockExemptPatch({ enabled: false, locked: true })).toBe(true);
    expect(isLockExemptPatch({ name: "x" })).toBe(false);
    expect(isLockExemptPatch({ enabled: false, name: "x" })).toBe(false);
  });

  it("canEditLayer blocks non-exempt patches on locked layers", () => {
    const locked = baseObj({ locked: true });
    expect(canEditLayer(locked, { enabled: false })).toBe(true);
    expect(canEditLayer(locked, { labelIndex: 2 })).toBe(true);
    expect(canEditLayer(locked, { locked: undefined })).toBe(true);
    expect(canEditLayer(locked, { name: "Renamed" })).toBe(false);
    expect(canEditLayer(baseObj(), { name: "Renamed" })).toBe(true);
  });

  it("unlockedVisibilityPatches skips locked and already-matching layers", () => {
    const objects = [
      baseObj({ id: "a", enabled: true }),
      baseObj({ id: "b", enabled: false }),
      baseObj({ id: "c", enabled: true, locked: true }),
      baseObj({ id: "d", enabled: false, locked: true }),
    ];
    expect(unlockedVisibilityPatches(objects, false)).toEqual([
      { id: "a", patch: { enabled: false } },
    ]);
    expect(unlockedVisibilityPatches(objects, true)).toEqual([
      { id: "b", patch: { enabled: true } },
    ]);
  });
});
