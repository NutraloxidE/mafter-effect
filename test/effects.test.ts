import { describe, expect, it } from "vitest";
import {
  ANGULAR_WIPE_EFFECT_DEF,
  BLUR_EFFECT_DEF,
  LINEAR_WIPE_EFFECT_DEF,
  RIPPLE_EFFECT_DEF,
  TINT_EFFECT_DEF,
  TURBULENT_DISPLACE_EFFECT_DEF,
  WAVE_EFFECT_DEF,
  PIXEL_SORTER_EFFECT_DEF,
  PIXEL_SORT_LITE_EFFECT_DEF,
  registerBuiltinEffects,
} from "../src/runtime/builtinEffects";
import { globalPluginRegistry } from "../src/runtime/pluginRegistry";
import { resolve } from "../src/runtime/resolve";
import { defaultTransform, staticProp, vec3 } from "../src/core/props";
import type { EffectInstance, SceneObject, TimelineComposition } from "../src/core/schema";
import { serializeProject, deserializeProject } from "../src/core/serialize";
import { createProject } from "../src/core/createProject";

const ctx = { width: 1920, height: 1080, frame: 0 };

describe("builtinEffects apply (§27.3)", () => {
  it("re-registers after pluginRegistry.clear() (loadPlugins 経路)", () => {
    registerBuiltinEffects();
    expect(globalPluginRegistry.listEffects().map((e) => e.type)).toEqual([
      "blur", "tint", "wave", "turbulentDisplace", "ripple", "linearWipe", "angularWipe", "pixelSorter", "pixelSortLite",
    ]);
    globalPluginRegistry.clear();
    registerBuiltinEffects();
    expect(globalPluginRegistry.listEffects().map((e) => e.type)).toEqual([
      "blur", "tint", "wave", "turbulentDisplace", "ripple", "linearWipe", "angularWipe", "pixelSorter", "pixelSortLite",
    ]);
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

  it("wave returns null when amplitude is 0", () => {
    expect(WAVE_EFFECT_DEF.apply({ amplitude: 0, wavelength: 50, direction: "horizontal", phase: 0 }, ctx)).toBeNull();
  });

  it("wave returns a sine displacement map (not turbulence)", () => {
    const r = WAVE_EFFECT_DEF.apply({ amplitude: 20, wavelength: 50, direction: "horizontal", phase: 45 }, ctx);
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain("feImage");
      expect(r.primitives).toContain("feDisplacementMap");
      // 正弦波 displacement map なのでノイズ (feTurbulence) は使わない。
      expect(r.primitives).not.toContain("feTurbulence");
      // scale = 2·amplitude。
      expect(r.primitives).toContain('scale="40"');
    }
  });

  it("wave phase animates the map (smooth scroll, not seed jump)", () => {
    const a = WAVE_EFFECT_DEF.apply({ amplitude: 20, wavelength: 50, direction: "horizontal", phase: 0 }, ctx);
    const b = WAVE_EFFECT_DEF.apply({ amplitude: 20, wavelength: 50, direction: "horizontal", phase: 45 }, ctx);
    expect(a?.kind === "svg" && b?.kind === "svg" && a.primitives !== b.primitives).toBe(true);
  });

  it("turbulentDisplace returns null when amount is 0", () => {
    expect(
      TURBULENT_DISPLACE_EFFECT_DEF.apply(
        { amount: 0, size: 100, complexity: 2, evolution: 0, offsetX: 0, offsetY: 0, randomSeed: 0 },
        ctx,
      ),
    ).toBeNull();
  });

  it("turbulentDisplace returns svg turbulence with layer-scoped noise", () => {
    const r = TURBULENT_DISPLACE_EFFECT_DEF.apply(
      { amount: 50, size: 100, complexity: 2, evolution: 90, offsetX: 0, offsetY: 0, randomSeed: 0 },
      ctx,
    );
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain('type="turbulence"');
      expect(r.primitives).toContain('scale="50"');
      expect(r.primitives).toContain('width="1920"');
      expect(r.primitives).toContain("feOffset");
    }
  });

  it("turbulentDisplace evolution uses feOffset not seed jump", () => {
    const base = {
      amount: 50,
      size: 100,
      complexity: 2,
      offsetX: 0,
      offsetY: 0,
      randomSeed: 0,
    };
    const a = TURBULENT_DISPLACE_EFFECT_DEF.apply({ ...base, evolution: 0 }, ctx);
    const b = TURBULENT_DISPLACE_EFFECT_DEF.apply({ ...base, evolution: 45 }, ctx);
    expect(a?.kind === "svg" && b?.kind === "svg" && a.primitives !== b.primitives).toBe(true);
    if (a?.kind === "svg" && b?.kind === "svg") {
      expect(a.primitives).toContain('seed="0"');
      expect(b.primitives).toContain('seed="0"');
      expect(b.primitives).toContain("feOffset");
    }
  });

  it("ripple returns null when amplitude is 0", () => {
    expect(RIPPLE_EFFECT_DEF.apply({ amplitude: 0, radius: 100, frequency: 5, centerX: 0.5, centerY: 0.5 }, ctx)).toBeNull();
  });

  it("ripple returns a radial displacement map driven by center", () => {
    const r = RIPPLE_EFFECT_DEF.apply({ amplitude: 10, radius: 100, frequency: 5, centerX: 0.5, centerY: 0.5 }, ctx);
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain("feDisplacementMap");
      expect(r.primitives).toContain("feImage");
    }
  });

  it("ripple center actually moves the rings", () => {
    const a = RIPPLE_EFFECT_DEF.apply({ amplitude: 10, radius: 100, frequency: 5, centerX: 0.25, centerY: 0.5 }, ctx);
    const b = RIPPLE_EFFECT_DEF.apply({ amplitude: 10, radius: 100, frequency: 5, centerX: 0.75, centerY: 0.5 }, ctx);
    expect(a?.kind === "svg" && b?.kind === "svg" && a.primitives !== b.primitives).toBe(true);
  });

  it("linearWipe returns null when completion <= 0 (AE: inert)", () => {
    expect(LINEAR_WIPE_EFFECT_DEF.apply({ completion: 0, angle: 0, feather: 0 }, ctx)).toBeNull();
  });

  it("linearWipe returns mask composite when completion in (0,1)", () => {
    const r = LINEAR_WIPE_EFFECT_DEF.apply({ completion: 0.5, angle: 0, feather: 2 }, ctx);
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain("feImage");
      expect(r.primitives).toContain("feComposite");
      expect(r.primitives).toContain("linearGradient");
      // luminance を alpha に変換しないと feComposite "in" は切り抜かない。
      expect(r.primitives).toContain("luminanceToAlpha");
    }
  });

  it("linearWipe hides all when completion is 1 (AE: fully wiped)", () => {
    const r = LINEAR_WIPE_EFFECT_DEF.apply({ completion: 1, angle: 0, feather: 0 }, ctx);
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain("black");
      expect(r.primitives).toContain('operator="in"');
      expect(r.primitives).toContain("luminanceToAlpha");
    }
  });

  it("angularWipe returns null when completion <= 0 (AE: inert)", () => {
    expect(ANGULAR_WIPE_EFFECT_DEF.apply({ completion: 0, startAngle: 0, centerX: 0.5, centerY: 0.5, feather: 0 }, ctx)).toBeNull();
  });

  it("angularWipe returns wedge mask when completion in (0,1)", () => {
    const r = ANGULAR_WIPE_EFFECT_DEF.apply({ completion: 0.25, startAngle: 0, centerX: 0.5, centerY: 0.5, feather: 0 }, ctx);
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain("feImage");
      expect(r.primitives).toContain("path");
    }
  });

  it("linearWipe accepts angle outside 0..360", () => {
    const r = LINEAR_WIPE_EFFECT_DEF.apply({ completion: 0.5, angle: -30, feather: 0 }, ctx);
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain("userSpaceOnUse");
    }
  });

  it("angularWipe accepts startAngle outside 0..360", () => {
    const r = ANGULAR_WIPE_EFFECT_DEF.apply({ completion: 0.25, startAngle: 720, centerX: 0.5, centerY: 0.5, feather: 0 }, ctx);
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain("path");
    }
  });

  it("pixelSorter returns null when identity threshold", () => {
    expect(
      PIXEL_SORTER_EFFECT_DEF.apply({
        sortingMode: "simple",
        thresholdLow: 0.8,
        thresholdHigh: 0.2,
        angle: 0,
        length: 256,
        offset: 0,
        feather: 0,
        sortBlocks: 1,
      }, ctx),
    ).toBeNull();
  });

  it("pixelSorter returns raster kind when active", () => {
    expect(
      PIXEL_SORTER_EFFECT_DEF.apply({
        sortingMode: "simple",
        thresholdLow: 0,
        thresholdHigh: 1,
        angle: 0,
        length: 256,
        offset: 0,
        feather: 0,
        sortBlocks: 1,
      }, ctx),
    ).toEqual({ kind: "raster" });
  });

  it("pixelSorter processPixels changes buffer", () => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    const pattern = [255, 32, 200, 64];
    for (let i = 0; i < 16; i++) {
      const v = pattern[i % 4]!;
      const o = i * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
    const input = { data, width: 4, height: 4 };
    const out = PIXEL_SORTER_EFFECT_DEF.processPixels!(
      input,
      {
        sortingMode: "simple",
        thresholdLow: 0,
        thresholdHigh: 1,
        angle: 0,
        length: 0,
        offset: 0,
        feather: 0,
        sortBlocks: 1,
      },
      { ...ctx, frame: 5 },
    );
    expect(Array.from(out.data)).not.toEqual(Array.from(input.data));
  });

  it("pixelSortLite returns null when streakLength or intensity is 0", () => {
    expect(PIXEL_SORT_LITE_EFFECT_DEF.apply({ streakLength: 0, intensity: 1 }, ctx)).toBeNull();
    expect(PIXEL_SORT_LITE_EFFECT_DEF.apply({ streakLength: 64, intensity: 0 }, ctx)).toBeNull();
  });

  it("pixelSortLite returns svg kind when active", () => {
    const r = PIXEL_SORT_LITE_EFFECT_DEF.apply({
      angle: 90,
      threshold: 0.5,
      streakLength: 64,
      stripWidth: 8,
      intensity: 1,
      phase: 0,
    }, ctx);
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain("feDisplacementMap");
      expect(r.primitives).toContain("luminanceToAlpha");
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

  it("resolves linearWipe completion keyframes", () => {
    const effect: EffectInstance = {
      id: "E2",
      type: "linearWipe",
      enabled: true,
      props: {
        completion: {
          value: 0,
          keyframes: [
            { frame: 0, value: 0, easing: { type: "linear" } },
            { frame: 10, value: 1, easing: { type: "linear" } },
          ],
        },
        angle: staticProp(0),
        feather: staticProp(0),
      },
    };
    const scene0 = resolve(comp([makeObject({ id: "a", effects: [effect] })]), 0);
    const scene10 = resolve(comp([makeObject({ id: "a", effects: [effect] })]), 10);
    expect(scene0.objects[0]?.effects?.[0]?.props["completion"]).toBe(0);
    expect(scene10.objects[0]?.effects?.[0]?.props["completion"]).toBe(1);
  });

  it("passes non-animatable enum direction through resolve", () => {
    const effect: EffectInstance = {
      id: "E3",
      type: "wave",
      enabled: true,
      props: {
        amplitude: staticProp(20),
        wavelength: staticProp(50),
        direction: "vertical",
        phase: staticProp(0),
      },
    };
    const scene = resolve(comp([makeObject({ id: "a", effects: [effect] })]), 0);
    expect(scene.objects[0]?.effects?.[0]?.props["direction"]).toBe("vertical");
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
          type: "wave",
          enabled: true,
          props: {
            amplitude: staticProp(20),
            wavelength: staticProp(50),
            direction: "horizontal",
            phase: staticProp(0),
          },
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
