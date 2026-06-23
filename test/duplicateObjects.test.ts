import { describe, expect, it } from "vitest";
import { defaultTransform, staticProp, vec3 } from "../src/core/props";
import type { SceneObject, TimelineComposition } from "../src/core/schema";
import { duplicateObjectsWithRemap } from "../src/editor/duplicateObjects";
import { transformPoint } from "../src/runtime/mat4";
import { resolve } from "../src/runtime/resolve";

function atPos(
  id: string,
  pos: { x: number; y: number; z?: number },
  parent: string | null = null,
  extra: Partial<SceneObject> = {},
): SceneObject {
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
    ...extra,
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

function worldPos(c: TimelineComposition, id: string, f: number) {
  const ro = resolve(c, f).objects.find((o) => o.id === id);
  return ro ? transformPoint(ro.worldTransform, vec3(0, 0, 0)) : null;
}

describe("duplicateObjectsWithRemap", () => {
  it("remaps parent within duplicated set (null + child)", () => {
    const nullLayer = atPos("n", { x: 500, y: 300 }, null, { isNull: true, zOrder: 2 });
    const child = atPos("c", { x: 10, y: 20 }, "n", { zOrder: 1 });
    const copies = duplicateObjectsWithRemap([nullLayer, child], new Set());

    const newNull = copies.find((o) => o.isNull)!;
    const newChild = copies.find((o) => !o.isNull)!;
    expect(newNull.id).not.toBe("n");
    expect(newChild.parent).toBe(newNull.id);
    expect(newNull.isNull).toBe(true);
    expect(newNull.zOrder).toBe(2.5);
    expect(newChild.zOrder).toBe(1.5);
  });

  it("keeps parent pointing to existing comp object when only child is duplicated", () => {
    const nullLayer = atPos("n", { x: 100, y: 50 }, null, { isNull: true });
    const child = atPos("c", { x: 10, y: 20 }, "n");
    const copies = duplicateObjectsWithRemap([child], new Set([nullLayer.id, child.id]));

    expect(copies).toHaveLength(1);
    expect(copies[0]!.parent).toBe("n");
    expect(copies[0]!.id).not.toBe("c");
  });

  it("clears dangling parent when original parent is not in comp (cut-then-paste)", () => {
    const child = atPos("c", { x: 10, y: 20 }, "n");
    const copies = duplicateObjectsWithRemap([child], new Set());

    expect(copies).toHaveLength(1);
    expect(copies[0]!.parent).toBeNull();
  });

  it("remaps multi-level parent chain A→B→C", () => {
    const a = atPos("a", { x: 10, y: 0 });
    const b = atPos("b", { x: 20, y: 0 }, "a");
    const c = atPos("c", { x: 30, y: 0 }, "b");
    const copies = duplicateObjectsWithRemap([a, b, c], new Set());

    const byOld = new Map(copies.map((o, i) => [["a", "b", "c"][i]!, o]));
    const newA = byOld.get("a")!;
    const newB = byOld.get("b")!;
    const newC = byOld.get("c")!;
    expect(newB.parent).toBe(newA.id);
    expect(newC.parent).toBe(newB.id);
  });

  it("preserves child world position when null parent is duplicated with child", () => {
    const nullLayer = atPos("n", { x: 500, y: 300 }, null, { isNull: true });
    const child = atPos("c", { x: 10, y: 20 }, "n");
    const before = comp([nullLayer, child]);
    const beforeWorld = worldPos(before, "c", 0)!;

    const copies = duplicateObjectsWithRemap([nullLayer, child], new Set(["n", "c"]));
    const after = comp([...before.objects, ...copies]);
    const newChild = copies.find((o) => o.id !== copies.find((x) => x.isNull)!.id)!;
    const afterWorld = worldPos(after, newChild.id, 0)!;

    expect(afterWorld.x).toBeCloseTo(beforeWorld.x, 6);
    expect(afterWorld.y).toBeCloseTo(beforeWorld.y, 6);
  });
});
