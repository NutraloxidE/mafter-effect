import { describe, expect, it } from "vitest";
import { BLUR_EFFECT_DEF, TINT_EFFECT_DEF, registerBuiltinEffects } from "../src/runtime/builtinEffects";
import { globalPluginRegistry } from "../src/runtime/pluginRegistry";
import { resolve } from "../src/runtime/resolve";
import { defaultTransform, staticProp, vec3 } from "../src/core/props";
import type { EffectInstance, SceneObject, TimelineComposition } from "../src/core/schema";
import { serializeProject, deserializeProject } from "../src/core/serialize";
import { createProject } from "../src/core/createProject";

describe("builtinEffects apply (§27.3)", () => {
  const ctx = { width: 1920, height: 1080 };

  it("re-registers after pluginRegistry.clear() (loadPlugins 経路)", () => {
    registerBuiltinEffects();
    expect(globalPluginRegistry.listEffects().map((e) => e.type)).toEqual(["blur", "tint"]);
    globalPluginRegistry.clear();
    registerBuiltinEffects();
    expect(globalPluginRegistry.listEffects().map((e) => e.type)).toEqual(["blur", "tint"]);
  });

  it("blur returns null when blurriness is 0", () => {
    expect(BLUR_EFFECT_DEF.apply({ blurriness: 0 }, ctx)).toBeNull();
  });

  it("blur returns css filter token", () => {
    expect(BLUR_EFFECT_DEF.apply({ blurriness: 4 }, ctx)).toEqual({
      kind: "css",
      fn: "blur(4px)",
    });
  });

  it("tint returns null when amount is 0", () => {
    expect(TINT_EFFECT_DEF.apply({ amount: 0, mapBlack: { r: 0, g: 0, b: 0, a: 1 }, mapWhite: { r: 1, g: 1, b: 1, a: 1 } }, ctx)).toBeNull();
  });

  it("tint returns svg primitives when amount > 0", () => {
    const r = TINT_EFFECT_DEF.apply({ amount: 0.5, mapBlack: { r: 0, g: 0, b: 0, a: 1 }, mapWhite: { r: 1, g: 0, b: 0, a: 1 } }, ctx);
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain("feColorMatrix");
      expect(r.primitives).toContain('slope="0.5"');
    }
  });
});

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

describe("resolve effects (§27.5)", () => {
  it("resolves effect props with keyframe interpolation", () => {
    const effect: EffectInstance = {
      id: "E1",
      type: "blur",
      enabled: true,
      props: {
        blurriness: {
          value: 0,
          keyframes: [
            { frame: 0, value: 0, easing: { type: "linear" } },
            { frame: 10, value: 20, easing: { type: "linear" } },
          ],
        },
      },
    };
    const scene0 = resolve(comp([makeObject({ id: "a", effects: [effect] })]), 0);
    const scene5 = resolve(comp([makeObject({ id: "a", effects: [effect] })]), 5);
    expect(scene0.objects[0]?.effects?.[0]?.props["blurriness"]).toBe(0);
    expect(scene5.objects[0]?.effects?.[0]?.props["blurriness"]).toBe(10);
  });

  it("passes isAdjustment and skips content components", () => {
    const scene = resolve(comp([
      makeObject({
        id: "adj",
        isAdjustment: true,
        components: [{ type: "solid", props: { color: staticProp({ r: 1, g: 0, b: 0, a: 1 }) } }],
      }),
    ]), 0);
    const obj = scene.objects[0]!;
    expect(obj.isAdjustment).toBe(true);
    expect(obj.components).toEqual([]);
  });
});

describe("effects project roundtrip (INV-4)", () => {
  it("effects 付き project が byte 等価で roundtrip する", () => {
    const p = createProject({ name: "FxTest" });
    const root = p.compositions.find((c) => c.id === p.rootComposition);
    if (!root || root.kind !== "timeline") throw new Error("no timeline comp");
    root.objects = [
      {
        id: "OBJ1",
        name: "Solid",
        parent: null,
        zOrder: 1,
        enabled: true,
        inPoint: 0,
        outPoint: root.duration,
        transform: defaultTransform(),
        opacity: staticProp(1),
        components: [{
          type: "solid",
          props: {
            color: staticProp({ r: 1, g: 0, b: 0, a: 1 }),
            size: staticProp(vec3(100, 100, 0)),
          },
        }],
        effects: [{
          id: "FX1",
          type: "blur",
          enabled: true,
          props: { blurriness: staticProp(8) },
        }],
      },
    ];
    const text = serializeProject(p);
    const loaded = deserializeProject(text);
    expect(serializeProject(loaded)).toBe(text);
  });

  it("effects 未使用の既存 project は byte 等価のまま", () => {
    const p = createProject({ name: "Plain" });
    const text = serializeProject(p);
    const loaded = deserializeProject(text);
    expect(serializeProject(loaded)).toBe(text);
  });
});
