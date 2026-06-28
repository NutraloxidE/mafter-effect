import { describe, expect, it } from "vitest";
import { canonicalizeProject, serializeProject } from "../src/core/serialize";
import { createProject } from "../src/core/createProject";
import { defaultTransform, staticProp, vec3 } from "../src/core/props";
import type { TimelineComposition, Vec3 } from "../src/core/schema";
import { ExpressionEngine } from "../src/runtime/expressionEngine";
import { MockModuleLoader } from "../src/runtime/moduleLoader";
import {
  buildDefaultPresetProps,
  EXPRESSION_PRESETS,
  presetIdFromExpressionPath,
  presetScriptPath,
} from "../src/editor/expressionPresets";
import { pulseModulation } from "../src/runtime/pulseScaleWave";
import { newObjectId } from "../src/core/ids";

function makeComp(): TimelineComposition {
  return {
    id: newObjectId(),
    kind: "timeline",
    name: "Test",
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 30,
    objects: [
      {
        id: newObjectId(),
        name: "Layer",
        parent: null,
        zOrder: 1,
        enabled: true,
        inPoint: 0,
        outPoint: 30,
        transform: defaultTransform(),
        opacity: staticProp(1),
        components: [{ type: "solid", props: { color: staticProp({ r: 1, g: 0, b: 0, a: 1 }), size: staticProp(vec3(100, 100, 0)) } }],
        expressionPresets: [
          {
            id: "01EXPRPRESET0001",
            presetId: "wiggle-position",
            enabled: true,
            props: {
              frequency: {
                value: 2,
                keyframes: [
                  { frame: 0, value: 2, easing: { type: "hold" } },
                  { frame: 15, value: 4, easing: { type: "hold" } },
                ],
              },
              amplitude: staticProp(60),
              seed: staticProp(0),
            },
          },
        ],
      },
    ],
  };
}

describe("expressionPresets — serialize byte 等価", () => {
  it("omits empty expressionPresets from canonical project", () => {
    const p = createProject();
    const before = serializeProject(p);
    const after = serializeProject(canonicalizeProject(p));
    expect(after).toBe(before);
  });
});

describe("presetIdFromExpressionPath", () => {
  it("parses shared FS path", () => {
    expect(presetIdFromExpressionPath("presets/expressions/wiggle-position.js")).toBe("wiggle-position");
    expect(presetIdFromExpressionPath("scripts/foo/position.js")).toBeNull();
  });
});

describe("ExpressionEngine presetParams", () => {
  it("samples expressionPresets props at frame", async () => {
    const comp = makeComp();
    const obj = comp.objects[0]!;
    const path = presetScriptPath("wiggle-position");
    obj.transform.position = {
      ...obj.transform.position,
      expression: { path, enabled: true },
    };

    const captured: number[] = [];
    const loader = new MockModuleLoader();
    loader.register(path, (ctx: { presetParams: Record<string, unknown>; wiggle: (f: number, a: number, s?: number) => Vec3 }) => {
      captured.push(ctx.presetParams.frequency as number);
      return ctx.wiggle(
        ctx.presetParams.frequency as number,
        ctx.presetParams.amplitude as number,
        ctx.presetParams.seed as number,
      );
    });

    const engine = new ExpressionEngine(loader);
    await engine.prepare(comp);
    const evaluator = engine.makeEvaluator(comp);

    evaluator({ path, frame: 0, fps: 30, value: vec3(0, 0, 0), objectId: obj.id });
    evaluator({ path, frame: 15, fps: 30, value: vec3(0, 0, 0), objectId: obj.id });
    expect(captured[0]).toBe(2);
    expect(captured[1]).toBe(4);
  });

  it("zero amplitude via presetParams yields no wiggle offset", async () => {
    const comp = makeComp();
    const obj = comp.objects[0]!;
    const path = presetScriptPath("wiggle-position");
    obj.transform.position = {
      value: vec3(100, 200, 0),
      keyframes: [],
      expression: { path, enabled: true },
    };
    const inst = obj.expressionPresets![0]!;
    inst.props = {
      ...buildDefaultPresetProps("wiggle-position"),
      amplitude: staticProp(0),
    };

    const loader = new MockModuleLoader();
    loader.register(path, (ctx: { value: Vec3; presetParams: Record<string, unknown>; wiggle: (f: number, a: number, s?: number) => Vec3 }) => {
      const f = (ctx.presetParams.frequency as number) ?? 2;
      const a = (ctx.presetParams.amplitude as number) ?? 60;
      const s = (ctx.presetParams.seed as number) ?? 0;
      return ctx.wiggle(f, a, s);
    });
    const engine = new ExpressionEngine(loader);
    await engine.prepare(comp);
    const evaluator = engine.makeEvaluator(comp);

    const result = evaluator({
      path,
      frame: 0,
      fps: 30,
      value: vec3(100, 200, 0),
      objectId: obj.id,
    }) as Vec3;
    expect(result.x).toBeCloseTo(100, 5);
    expect(result.y).toBeCloseTo(200, 5);
  });
});

describe("pulse-scale waveform param", () => {
  it("buildDefaultPresetProps includes static waveform and bend", () => {
    const props = buildDefaultPresetProps("pulse-scale");
    expect(props.waveform).toBe("sine");
    expect(props.polarity).toBe("+");
    expect(props.bend).toEqual(staticProp(0));
    expect(props.phase).toEqual(staticProp(0));
    expect(props.amount).toEqual(staticProp(0.1));
  });

  it("passes waveform string via presetParams", async () => {
    const comp = makeComp();
    const obj = comp.objects[0]!;
    const path = presetScriptPath("pulse-scale");
    obj.expressionPresets = [
      {
        id: "01EXPRPRESET0002",
        presetId: "pulse-scale",
        enabled: true,
        props: {
          ...buildDefaultPresetProps("pulse-scale"),
          waveform: "square",
        },
      },
    ];
    obj.transform.scale = {
      value: vec3(1, 1, 1),
      keyframes: [],
      expression: { path, enabled: true },
    };

    let capturedWaveform: unknown;
    const loader = new MockModuleLoader();
    loader.register(path, (ctx: { presetParams: Record<string, unknown>; value: Vec3 }) => {
      capturedWaveform = ctx.presetParams.waveform;
      return ctx.value;
    });
    const engine = new ExpressionEngine(loader);
    await engine.prepare(comp);
    const evaluator = engine.makeEvaluator(comp);
    evaluator({ path, frame: 0, fps: 30, value: vec3(1, 1, 1), objectId: obj.id });
    expect(capturedWaveform).toBe("square");
  });

  it("waveform shapes modulate scale deterministically (INV-1)", async () => {
    const src = EXPRESSION_PRESETS["pulse-scale"].script;
    const url = `data:text/javascript,${encodeURIComponent(src)}`;
    const mod = (await import(/* @vite-ignore */ url)) as { default: (ctx: {
      time: number;
      value: Vec3;
      presetParams: Record<string, unknown>;
    }) => Vec3 };
    const pulseFn = mod.default;
    const base = vec3(100, 100, 0);
    const ctx = (time: number, waveform: string) => ({
      time,
      value: base,
      presetParams: { amount: 0.1, frequency: 1, waveform },
    });

    // freq=1 → period 1s. triangle peaks at t=0.5; square/sine at quarter period
    const trianglePeak = pulseFn(ctx(0.5, "triangle"));
    expect(trianglePeak.x).toBeCloseTo(110, 5);

    const squareHigh = pulseFn(ctx(0.1, "square"));
    expect(squareHigh.x).toBeCloseTo(110, 5);
    const squareLow = pulseFn(ctx(0.6, "square"));
    expect(squareLow.x).toBeCloseTo(90, 5);

    const saw = pulseFn(ctx(0.25, "sawtooth"));
    expect(saw.x).toBeCloseTo(95, 5);

    const sine = pulseFn(ctx(0.25, "sine"));
    expect(sine.x).toBeCloseTo(110, 5);

    const again = pulseFn(ctx(0.25, "sine"));
    expect(sine).toEqual(again);
  });

  it("sawtooth bend +/- warps ramp like Serum BEND (INV-1)", () => {
    const t = 0.25;
    const neutral = pulseModulation("sawtooth", 0, t);
    const bendPlus = pulseModulation("sawtooth", 0.5, t);
    const bendMinus = pulseModulation("sawtooth", -0.5, t);
    expect(bendPlus).toBeGreaterThan(neutral);
    expect(bendMinus).toBeLessThan(neutral);
    expect(bendPlus - neutral).toBeGreaterThan(0.15);
  });

  it("makeEvaluator resolveComp picks up live preset prop edits", async () => {
    let comp = makeComp();
    const obj = comp.objects[0]!;
    const path = presetScriptPath("pulse-scale");
    obj.expressionPresets = [
      {
        id: "01EXPRPRESET0003",
        presetId: "pulse-scale",
        enabled: true,
        props: { ...buildDefaultPresetProps("pulse-scale"), waveform: "sine" },
      },
    ];
    obj.transform.scale = {
      value: vec3(1, 1, 1),
      keyframes: [],
      expression: { path, enabled: true },
    };

    const captured: string[] = [];
    const loader = new MockModuleLoader();
    loader.register(path, (ctx: { presetParams: Record<string, unknown> }) => {
      captured.push(String(ctx.presetParams.waveform));
      return vec3(1, 1, 0);
    });
    const engine = new ExpressionEngine(loader);
    await engine.prepare(comp);
    const evaluator = engine.makeEvaluator(comp, () => comp);

    evaluator({ path, frame: 0, fps: 30, value: vec3(1, 1, 1), objectId: obj.id });
    const inst = obj.expressionPresets![0]!;
    inst.props = { ...inst.props, waveform: "square" };
    evaluator({ path, frame: 0, fps: 30, value: vec3(1, 1, 1), objectId: obj.id });
    expect(captured).toEqual(["sine", "square"]);
  });
});

describe("orbit-position circular motion (§9, INV-1)", () => {
  it("buildDefaultPresetProps includes radius, frequency, phase", () => {
    const props = buildDefaultPresetProps("orbit-position");
    expect(props.radius).toEqual(staticProp(80));
    expect(props.frequency).toEqual(staticProp(0.5));
    expect(props.phase).toEqual(staticProp(0));
  });

  it("moves on a circle deterministically", async () => {
    const src = EXPRESSION_PRESETS["orbit-position"].script;
    const url = `data:text/javascript,${encodeURIComponent(src)}`;
    const mod = (await import(/* @vite-ignore */ url)) as { default: (ctx: {
      time: number;
      value: Vec3;
      presetParams: Record<string, unknown>;
    }) => Vec3 };
    const orbitFn = mod.default;
    const base = vec3(200, 150, 0);
    const ctx = (time: number) => ({
      time,
      value: base,
      presetParams: { radius: 80, frequency: 1, phase: 0 },
    });

    const at0 = orbitFn(ctx(0));
    expect(at0.x).toBeCloseTo(280, 5);
    expect(at0.y).toBeCloseTo(150, 5);

    const atQuarter = orbitFn(ctx(0.25));
    expect(atQuarter.x).toBeCloseTo(200, 5);
    expect(atQuarter.y).toBeCloseTo(230, 5);

    const again = orbitFn(ctx(0.25));
    expect(atQuarter).toEqual(again);
  });
});
