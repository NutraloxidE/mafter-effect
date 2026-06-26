import { describe, expect, it } from "vitest";
import { canonicalizeProject, serializeProject } from "../src/core/serialize";
import { createProject } from "../src/core/createProject";
import { defaultTransform, staticProp, vec3 } from "../src/core/props";
import type { TimelineComposition, Vec3 } from "../src/core/schema";
import { ExpressionEngine } from "../src/runtime/expressionEngine";
import { MockModuleLoader } from "../src/runtime/moduleLoader";
import {
  buildDefaultPresetProps,
  presetIdFromExpressionPath,
  presetScriptPath,
} from "../src/editor/expressionPresets";
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
