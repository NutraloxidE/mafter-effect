import { describe, expect, it } from "vitest";
import { collectKfFrames } from "../src/editor/keyframeEdit";
import type { SceneObject } from "../src/core/schema";

function baseObject(id: string): SceneObject {
  const sp = <T>(value: T) => ({ value, keyframes: [] as { frame: number; value: T; easing: { type: "linear" } }[] });
  return {
    id,
    name: id,
    enabled: true,
    parent: null,
    zOrder: 1,
    inPoint: 0,
    outPoint: 150,
    isAdjustment: false,
    transform: {
      anchor: sp({ x: 0, y: 0, z: 0 }),
      position: sp({ x: 0, y: 0, z: 0 }),
      rotation: sp({ x: 0, y: 0, z: 0 }),
      scale: sp({ x: 1, y: 1, z: 1 }),
    },
    opacity: sp(1),
    components: [],
    effects: [],
  };
}

describe("collectKfFrames", () => {
  it("collects transform, component, and effect keyframes", () => {
    const obj = baseObject("a");
    obj.transform.position.keyframes = [
      { frame: 0, value: { x: 0, y: 0, z: 0 }, easing: { type: "linear" } },
      { frame: 30, value: { x: 10, y: 0, z: 0 }, easing: { type: "linear" } },
    ];
    obj.components = [{
      type: "solid",
      props: {
        size: {
          value: 100,
          keyframes: [{ frame: 45, value: 200, easing: { type: "linear" } }],
        },
      },
    }];
    obj.effects = [{
      id: "fx1",
      type: "blur",
      enabled: true,
      props: {
        radius: {
          value: 5,
          keyframes: [{ frame: 60, value: 20, easing: { type: "linear" } }],
        },
      },
    }];

    expect(collectKfFrames([obj], [])).toEqual([0, 30, 45, 60]);
  });

  it("scopes to selected layers when any are selected", () => {
    const a = baseObject("a");
    a.transform.position.keyframes = [{ frame: 10, value: { x: 0, y: 0, z: 0 }, easing: { type: "linear" } }];
    const b = baseObject("b");
    b.transform.position.keyframes = [{ frame: 20, value: { x: 0, y: 0, z: 0 }, easing: { type: "linear" } }];

    expect(collectKfFrames([a, b], ["a"])).toEqual([10]);
    expect(collectKfFrames([a, b], [])).toEqual([10, 20]);
  });
});
