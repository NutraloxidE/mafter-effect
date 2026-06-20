import { describe, expect, it } from "vitest";
import { defaultTransform, staticProp, vec3 } from "../src/core/props";
import type { SceneObject, TimelineComposition } from "../src/core/schema";
import { buildReparentPatch, worldOriginAtFrame } from "../src/editor/reparent";

function atPos(id: string, pos: { x: number; y: number; z?: number }, parent: string | null = null): SceneObject {
  const t = defaultTransform();
  t.position = staticProp(vec3(pos.x, pos.y, pos.z ?? 0));
  return {
    id,
    name: id,
    parent,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 100,
    transform: t,
    opacity: staticProp(1),
    components: [],
  };
}

function comp(objects: SceneObject[]): TimelineComposition {
  return {
    id: "C",
    name: "Main",
    kind: "timeline",
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 100,
    objects,
  };
}

describe("buildReparentPatch", () => {
  it("preserves world origin when parenting to null layer", () => {
    const nullLayer = atPos("n", { x: 500, y: 300 });
    nullLayer.isNull = true;
    nullLayer.components = [];
    const solid = atPos("s", { x: 100, y: 50 });
    const c = comp([nullLayer, solid]);

    const before = worldOriginAtFrame(c, "s", 0)!;
    const patch = buildReparentPatch(c, solid, "n", 0);
    expect(patch).not.toBeNull();

    const afterObj: SceneObject = { ...solid, ...patch! };
    const c2 = comp([nullLayer, afterObj]);
    const after = worldOriginAtFrame(c2, "s", 0)!;

    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
  });

  it("returns null when parent unchanged", () => {
    const solid = atPos("s", { x: 10, y: 20 }, "p");
    const parent = atPos("p", { x: 0, y: 0 });
    const c = comp([parent, solid]);
    expect(buildReparentPatch(c, solid, "p", 0)).toBeNull();
  });

  it("updates animated position at current frame", () => {
    const nullLayer = atPos("n", { x: 0, y: 0 });
    nullLayer.isNull = true;
    const solid = atPos("s", { x: 100, y: 0 });
    solid.transform.position = {
      value: { x: 0, y: 0, z: 0 },
      keyframes: [{ frame: 0, value: { x: 100, y: 0, z: 0 }, easing: { type: "linear" } }],
    };
    const c = comp([nullLayer, solid]);
    const patch = buildReparentPatch(c, solid, "n", 0);
    expect(patch?.transform.position.keyframes).toHaveLength(1);
    expect(patch?.transform.position.keyframes[0]?.frame).toBe(0);
  });
});
