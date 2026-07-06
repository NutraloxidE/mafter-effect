import { describe, expect, it } from "vitest";
import { bakeMergeShapeToPath } from "../src/editor/shapeBake";
import { defaultTransform, staticProp, vec3 } from "../src/core/props";
import type { BooleanOp, SceneObject, TimelineComposition } from "../src/core/schema";

function makeShapeObject(
  id: string,
  props: Record<string, unknown>,
  over: Partial<SceneObject> = {},
): SceneObject {
  return {
    id,
    name: id,
    parent: null,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 30,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [{ type: "shape", props }],
    ...over,
  };
}

function comp(objects: SceneObject[]): TimelineComposition {
  return { id: "C", name: "Main", kind: "timeline", width: 800, height: 600, fps: 30, duration: 60, objects };
}

function rectObj(id: string, size: number, position: (frame: number) => { x: number; y: number }): SceneObject {
  // static position for simplicity in most tests; overridden per-test with keyframes when needed.
  const p = position(0);
  const obj = makeShapeObject(id, { kind: "rect", fill: staticProp({ r: 1, g: 1, b: 1, a: 1 }), size: staticProp(vec3(size, size, 0)) });
  obj.transform.position = staticProp(vec3(p.x, p.y, 0));
  return obj;
}

function mergeObj(id: string, inputs: { objectId: string; op: BooleanOp }[]): SceneObject {
  return makeShapeObject(id, {
    kind: "merge",
    fill: staticProp({ r: 1, g: 1, b: 1, a: 1 }),
    mergeInputs: inputs.map((inp, i) => ({ id: `mi${i}`, objectId: inp.objectId, op: inp.op })),
  });
}

describe("bakeMergeShapeToPath (§5.5d/e Bake — Illustrator Expand equivalent)", () => {
  it("bakes a stable-topology range into a single keyframed ring (no holes)", () => {
    const a = rectObj("a", 20, () => ({ x: 0, y: 0 }));
    const b = rectObj("b", 20, () => ({ x: 10, y: 10 }));
    const m = mergeObj("m", [{ objectId: "a", op: "unite" }, { objectId: "b", op: "unite" }]);
    m.inPoint = 0;
    m.outPoint = 3;
    const project = comp([a, b, m]);

    const result = bakeMergeShapeToPath(project, "m", 0, 3, 0);
    expect(result.bakedFrameRange).toEqual([0, 2]);
    expect(result.fallbackReason).toBeUndefined();
    expect(result.rings).toHaveLength(1); // union of overlapping squares -> single ring, no holes
    // every vertex should have 3 keyframes (frames 0,1,2) since nothing moves in this test
    for (const ring of result.rings) {
      for (const vtx of ring) {
        expect(vtx.pos.keyframes).toHaveLength(3);
        expect(vtx.pos.keyframes.map((k) => k.frame)).toEqual([0, 1, 2]);
      }
    }
  });

  it("bakes a subtract (hole) result into 2 rings when topology is stable", () => {
    const a = rectObj("a", 20, () => ({ x: 0, y: 0 }));
    const b = rectObj("b", 5, () => ({ x: 5, y: 5 }));
    const m = mergeObj("m", [{ objectId: "a", op: "unite" }, { objectId: "b", op: "subtract" }]);
    m.inPoint = 0;
    m.outPoint = 2;
    const project = comp([a, b, m]);

    const result = bakeMergeShapeToPath(project, "m", 0, 2, 0);
    expect(result.bakedFrameRange).toEqual([0, 1]);
    expect(result.rings).toHaveLength(2); // outer + hole
  });

  it("falls back to a static single-frame bake when topology changes across the range", () => {
    const a = rectObj("a", 20, () => ({ x: 0, y: 0 }));
    // b moves from fully overlapping (frame 0, unite = single ring) to disjoint (frame 2, unite = two separate rings)
    const b = rectObj("b", 10, () => ({ x: 5, y: 5 }));
    b.transform.position = {
      value: vec3(5, 5, 0),
      keyframes: [
        { frame: 0, value: vec3(5, 5, 0), easing: { type: "hold" } },
        { frame: 2, value: vec3(200, 200, 0), easing: { type: "hold" } },
      ],
    };
    const m = mergeObj("m", [{ objectId: "a", op: "unite" }, { objectId: "b", op: "unite" }]);
    m.inPoint = 0;
    m.outPoint = 3;
    const project = comp([a, b, m]);

    const result = bakeMergeShapeToPath(project, "m", 0, 3, 0);
    expect(result.bakedFrameRange).toBeNull();
    expect(result.fallbackReason).toBeTruthy();
    // fallback bakes frame 0 (current frame passed in) — at frame 0, b fully overlaps a -> single ring
    expect(result.rings).toHaveLength(1);
    for (const ring of result.rings) {
      for (const vtx of ring) {
        expect(vtx.pos.keyframes).toHaveLength(0); // static, no animation
      }
    }
  });

  it("is a pure-ish function: same inputs produce structurally identical (position-wise) output", () => {
    const a = rectObj("a", 20, () => ({ x: 0, y: 0 }));
    const b = rectObj("b", 20, () => ({ x: 10, y: 10 }));
    const m = mergeObj("m", [{ objectId: "a", op: "unite" }, { objectId: "b", op: "unite" }]);
    m.inPoint = 0;
    m.outPoint = 1;
    const project = comp([a, b, m]);

    const r1 = bakeMergeShapeToPath(project, "m", 0, 1, 0);
    const r2 = bakeMergeShapeToPath(project, "m", 0, 1, 0);
    const positions = (r: typeof r1) => r.rings.map((ring) => ring.map((v) => v.pos.value));
    expect(positions(r1)).toEqual(positions(r2));
  });
});
