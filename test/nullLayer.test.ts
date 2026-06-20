import { describe, expect, it } from "vitest";
import { defaultTransform, staticProp, vec3 } from "../src/core/props";
import type { SceneObject, TimelineComposition } from "../src/core/schema";
import { validateProject } from "../src/core/validate";
import { transformPoint } from "../src/runtime/mat4";
import { resolve } from "../src/runtime/resolve";
import { createProject } from "../src/core/createProject";
import { deserializeProject, serializeProject } from "../src/core/serialize";

function makeObject(over: Partial<SceneObject> & { id: string }): SceneObject {
  return {
    name: over.id,
    parent: null,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 100,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [],
    ...over,
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

describe("resolve — null layer (§30)", () => {
  it("passes isNull and skips content components", () => {
    const scene = resolve(comp([
      makeObject({
        id: "n",
        isNull: true,
        components: [{ type: "solid", props: { color: staticProp({ r: 1, g: 0, b: 0, a: 1 }) } }],
      }),
    ]), 0);
    const obj = scene.objects[0]!;
    expect(obj.isNull).toBe(true);
    expect(obj.components).toEqual([]);
  });

  it("child inherits transform from null parent", () => {
    const nullParent = makeObject({
      id: "n",
      isNull: true,
      transform: (() => {
        const t = defaultTransform();
        t.position = staticProp(vec3(100, 50, 0));
        return t;
      })(),
    });
    const child = makeObject({
      id: "c",
      parent: "n",
      transform: (() => {
        const t = defaultTransform();
        t.position = staticProp(vec3(10, 20, 0));
        return t;
      })(),
      components: [{
        type: "solid",
        props: {
          color: staticProp({ r: 1, g: 0, b: 0, a: 1 }),
          size: staticProp(vec3(100, 100, 0)),
        },
      }],
    });
    const scene = resolve(comp([nullParent, child]), 0);
    const childResolved = scene.objects.find((o) => o.id === "c")!;
    const p = transformPoint(childResolved.worldTransform, vec3(0, 0, 0));
    expect(p.x).toBeCloseTo(110, 6);
    expect(p.y).toBeCloseTo(70, 6);
  });

  it("resolves opacity keyframes on null layer", () => {
    const nullObj = makeObject({
      id: "n",
      isNull: true,
      opacity: {
        value: 1,
        keyframes: [{ frame: 0, value: 0.5, easing: { type: "linear" } }],
      },
    });
    const scene = resolve(comp([nullObj]), 0);
    expect(scene.objects[0]?.opacity).toBe(0.5);
  });
});

describe("validate — null layer (§30)", () => {
  it("warns and clears isAdjustment when both flags are set", () => {
    const p = createProject({ name: "Both" });
    const root = p.compositions.find((c) => c.id === p.rootComposition);
    if (!root || root.kind !== "timeline") throw new Error("no timeline comp");
    root.objects = [
      makeObject({ id: "N1", isNull: true, isAdjustment: true }),
    ];
    const { project, warnings } = validateProject(structuredClone(p));
    const obj = (project.compositions[0] as TimelineComposition).objects[0]!;
    expect(warnings.some((w) => w.includes("isNull and isAdjustment"))).toBe(true);
    expect(obj.isNull).toBe(true);
    expect(obj.isAdjustment).toBeUndefined();
  });
});

describe("null layer project roundtrip (INV-4)", () => {
  it("isNull 付き project が byte 等価で roundtrip する", () => {
    const p = createProject({ name: "NullTest" });
    const root = p.compositions.find((c) => c.id === p.rootComposition);
    if (!root || root.kind !== "timeline") throw new Error("no timeline comp");
    root.objects = [
      makeObject({
        id: "N1",
        name: "Null",
        isNull: true,
        transform: (() => {
          const t = defaultTransform();
          t.position = staticProp(vec3(960, 540, 0));
          return t;
        })(),
      }),
    ];
    const text = serializeProject(p);
    const loaded = deserializeProject(text);
    expect(serializeProject(loaded)).toBe(text);
  });

  it("isNull 未使用の既存 project は byte 等価のまま", () => {
    const p = createProject({ name: "Plain" });
    const text = serializeProject(p);
    const loaded = deserializeProject(text);
    expect(serializeProject(loaded)).toBe(text);
  });
});
