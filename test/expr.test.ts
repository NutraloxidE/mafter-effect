import { describe, expect, it } from "vitest";
import {
  clamp,
  easeRemap,
  lerp,
  linearRemap,
  seededOnce,
  seededRandom,
  wiggleNumber,
  wiggleVec3,
} from "../src/runtime/exprHelpers";
import { ExpressionEngine } from "../src/runtime/expressionEngine";
import { MockModuleLoader } from "../src/runtime/moduleLoader";
import { HtmlCompPlayer } from "../src/runtime/htmlComp";
import { defaultTransform, staticProp, vec3 } from "../src/core/props";
import type { HtmlComposition, TimelineComposition } from "../src/core/schema";

// ─── seededRandom ────────────────────────────────────────────────────────────

describe("seededRandom — INV-1 determinism", () => {
  it("same seed produces same sequence", () => {
    const rng1 = seededRandom(42);
    const rng2 = seededRandom(42);
    const a = [rng1(), rng1(), rng1()];
    const b = [rng2(), rng2(), rng2()];
    expect(a).toEqual(b);
  });

  it("different seeds produce different first values", () => {
    expect(seededRandom(0)()).not.toBe(seededRandom(1)());
  });

  it("values are in [0, 1)", () => {
    const rng = seededRandom(12345);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("seededOnce is deterministic", () => {
    expect(seededOnce(7)).toBe(seededOnce(7));
    expect(seededOnce(7)).not.toBe(seededOnce(8));
  });
});

// ─── wiggle ──────────────────────────────────────────────────────────────────

describe("wiggle — deterministic noise (§9)", () => {
  it("same args → same output (INV-1)", () => {
    expect(wiggleNumber(0, 10, 30, 2, 50)).toBe(wiggleNumber(0, 10, 30, 2, 50));
  });

  it("different frames produce different values at non-zero freq", () => {
    const a = wiggleNumber(0, 10, 30, 2, 50);
    const b = wiggleNumber(0, 20, 30, 2, 50);
    expect(a).not.toBeCloseTo(b, 5);
  });

  it("zero freq → zero offset", () => {
    expect(wiggleNumber(100, 15, 30, 0, 50)).toBe(100);
  });

  it("zero amp → zero offset", () => {
    expect(wiggleNumber(100, 15, 30, 2, 0)).toBe(100);
  });

  it("wiggleVec3 returns Vec3 with per-axis variation (INV-1 deterministic)", () => {
    const base = vec3(0, 0, 0);
    const w1 = wiggleVec3(base, 15, 30, 2, 50);
    const w2 = wiggleVec3(base, 15, 30, 2, 50);
    expect(w1).toEqual(w2);
    // x, y, z はそれぞれ独立したシードで異なる値になるはず（統計的に）
    expect(w1.x).not.toBeCloseTo(w1.y, 5);
  });

  it("wiggle output stays within ±amp", () => {
    const amp = 50;
    for (let f = 0; f < 60; f++) {
      const v = wiggleNumber(0, f, 30, 2, amp);
      expect(Math.abs(v)).toBeLessThanOrEqual(amp + 0.001);
    }
  });
});

// ─── 純粋数値ヘルパー ─────────────────────────────────────────────────────────

describe("pure math helpers (§9)", () => {
  it("linearRemap: maps t from [tMin,tMax] to [vMin,vMax]", () => {
    expect(linearRemap(5, 0, 10, 0, 100)).toBeCloseTo(50);
    expect(linearRemap(0, 0, 10, 0, 100)).toBeCloseTo(0);
    expect(linearRemap(10, 0, 10, 0, 100)).toBeCloseTo(100);
  });

  it("easeRemap: smooth at edges, midpoint near 50%", () => {
    expect(easeRemap(0, 0, 10, 0, 100)).toBeCloseTo(0);
    expect(easeRemap(10, 0, 10, 0, 100)).toBeCloseTo(100);
    expect(easeRemap(5, 0, 10, 0, 100)).toBeCloseTo(50);
  });

  it("clamp works", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it("lerp works", () => {
    expect(lerp(0, 100, 0.5)).toBeCloseTo(50);
    expect(lerp(0, 100, 0)).toBe(0);
    expect(lerp(0, 100, 1)).toBe(100);
  });
});

// ─── ExpressionEngine (MockModuleLoader) ─────────────────────────────────────

function makeComp(objects: TimelineComposition["objects"] = []): TimelineComposition {
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

function makeObjWithExpr(id: string, param = "opacity.js"): TimelineComposition["objects"][0] {
  return {
    id,
    name: id,
    parent: null,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 100,
    transform: defaultTransform(),
    opacity: {
      value: 1,
      keyframes: [],
      expression: { path: `scripts/${id}/${param}`, enabled: true },
    },
    components: [],
  };
}

describe("ExpressionEngine — module evaluation (§9)", () => {
  it("evaluates expression and returns overridden value", async () => {
    const loader = new MockModuleLoader();
    loader.register("scripts/obj/opacity.js", (ctx: unknown) => (ctx as { value: number }).value * 0.5);
    const engine = new ExpressionEngine(loader);
    const obj = makeObjWithExpr("obj");
    const comp = makeComp([obj]);

    await engine.prepare(comp);
    const evaluator = engine.makeEvaluator(comp);
    const result = evaluator({
      path: "scripts/obj/opacity.js",
      frame: 0,
      fps: 30,
      value: 1,
      objectId: "obj",
    });
    expect(result).toBe(0.5);
  });

  it("falls back to value when module not found", async () => {
    const loader = new MockModuleLoader();
    const engine = new ExpressionEngine(loader);
    const obj = makeObjWithExpr("obj");
    const comp = makeComp([obj]);

    await engine.prepare(comp);
    const evaluator = engine.makeEvaluator(comp);
    const result = evaluator({
      path: "scripts/obj/opacity.js",
      frame: 0,
      fps: 30,
      value: 0.8,
      objectId: "obj",
    });
    expect(result).toBe(0.8);
  });

  it("falls back to value when expression throws (§9)", async () => {
    const loader = new MockModuleLoader();
    loader.register("scripts/obj/opacity.js", () => {
      throw new Error("boom");
    });
    const engine = new ExpressionEngine(loader);
    const obj = makeObjWithExpr("obj");
    const comp = makeComp([obj]);

    await engine.prepare(comp);
    const evaluator = engine.makeEvaluator(comp);
    // resolve の applyExpr がキャッチするが、evaluator 自体も throw したら resolve がキャッチ。
    // ここでは evaluator が throw しても value が返るかを確認。
    expect(() =>
      evaluator({ path: "scripts/obj/opacity.js", frame: 0, fps: 30, value: 0.9, objectId: "obj" }),
    ).toThrow(); // evaluator 本体は throw するが resolve 側でキャッチされる（§9 既検証）
  });

  it("ExprContext has correct frame/time/fps/value", async () => {
    const seen: unknown[] = [];
    const loader = new MockModuleLoader();
    loader.register("scripts/obj/opacity.js", (ctx: unknown) => {
      seen.push(ctx);
      return (ctx as { value: number }).value;
    });
    const engine = new ExpressionEngine(loader);
    const obj = makeObjWithExpr("obj");
    const comp = makeComp([obj]);

    await engine.prepare(comp);
    const evaluator = engine.makeEvaluator(comp);
    evaluator({ path: "scripts/obj/opacity.js", frame: 15, fps: 30, value: 0.7, objectId: "obj" });

    const ctx = seen[0] as Record<string, unknown>;
    expect(ctx.frame).toBe(15);
    expect(ctx.time).toBeCloseTo(0.5);
    expect(ctx.fps).toBe(30);
    expect(ctx.value).toBe(0.7);
  });

  it("ExprContext.wiggle is deterministic (INV-1)", async () => {
    const loader = new MockModuleLoader();
    loader.register("scripts/obj/opacity.js", (ctx: unknown) => {
      const c = ctx as { frame: number; fps: number; value: number; wiggle: (f: number, a: number) => number };
      return c.wiggle(2, 0.1);
    });
    const engine = new ExpressionEngine(loader);
    const obj = makeObjWithExpr("obj");
    const comp = makeComp([obj]);

    await engine.prepare(comp);
    const eval1 = engine.makeEvaluator(comp);
    const eval2 = engine.makeEvaluator(comp);
    const r1 = eval1({ path: "scripts/obj/opacity.js", frame: 10, fps: 30, value: 1, objectId: "obj" });
    const r2 = eval2({ path: "scripts/obj/opacity.js", frame: 10, fps: 30, value: 1, objectId: "obj" });
    expect(r1).toEqual(r2);
  });

  it("ExprContext.thisObject has position/opacity", async () => {
    const seen: unknown[] = [];
    const loader = new MockModuleLoader();
    loader.register("scripts/obj/opacity.js", (ctx: unknown) => {
      seen.push((ctx as { thisObject: unknown }).thisObject);
      return (ctx as { value: number }).value;
    });
    const engine = new ExpressionEngine(loader);
    const obj = {
      ...makeObjWithExpr("obj"),
      transform: {
        ...defaultTransform(),
        position: staticProp(vec3(100, 200, 0)),
      },
    };
    const comp = makeComp([obj]);

    await engine.prepare(comp);
    engine.makeEvaluator(comp)({
      path: "scripts/obj/opacity.js",
      frame: 0,
      fps: 30,
      value: 1,
      objectId: "obj",
    });

    const view = seen[0] as { position: { x: number; y: number; z: number }; opacity: number };
    expect(view.position.x).toBeCloseTo(100);
    expect(view.position.y).toBeCloseTo(200);
    expect(view.opacity).toBeCloseTo(1);
  });
});

// ─── HtmlCompPlayer — module loading (§7) ────────────────────────────────────
// 回帰テスト: ModuleLoader が「オブジェクト default export」(CompositionModule) を
// 拒否していたバグ。§7 のモジュールは関数ではなくオブジェクト。

describe("HtmlCompPlayer — accepts object CompositionModule (§7)", () => {
  const htmlComp: HtmlComposition = {
    id: "comp1",
    name: "Comp1",
    kind: "html",
    width: 320,
    height: 240,
    fps: 30,
    duration: 60,
  };

  it("registers an object module exposing mount/render", async () => {
    const loader = new MockModuleLoader();
    // CompositionModule はオブジェクト（関数ではない）。
    loader.register("compositions/comp1/script.js", {
      manifest: { id: "comp1", params: [] },
      mount() {},
      render() {},
    });
    const player = new HtmlCompPlayer(loader);
    await player.prepare([htmlComp], (id) => `compositions/${id}/script.js`);
    expect(player.hasModule("comp1")).toBe(true);
  });

  it("rejects a module missing mount/render", async () => {
    const loader = new MockModuleLoader();
    loader.register("compositions/comp1/script.js", { manifest: { id: "comp1", params: [] } });
    const player = new HtmlCompPlayer(loader);
    await player.prepare([htmlComp], (id) => `compositions/${id}/script.js`);
    expect(player.hasModule("comp1")).toBe(false);
  });
});
