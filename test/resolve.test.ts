import { describe, expect, it } from "vitest";
import { resolve } from "../src/runtime/resolve";
import { transformPoint } from "../src/runtime/mat4";
import { defaultTransform, staticProp, vec3 } from "../src/core/props";
import type { SceneObject, TimelineComposition, Vec3 } from "../src/core/schema";

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

function comp(objects: SceneObject[], extra: Partial<TimelineComposition> = {}): TimelineComposition {
  return {
    id: "C",
    name: "Main",
    kind: "timeline",
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 100,
    objects,
    ...extra,
  };
}

function atPos(id: string, pos: Vec3, over: Partial<SceneObject> = {}): SceneObject {
  const t = defaultTransform();
  t.position = staticProp(pos);
  return makeObject({ id, transform: t, ...over });
}

describe("resolve — world transform (§6.3)", () => {
  it("bakes position into world matrix (origin → position)", () => {
    const scene = resolve(comp([atPos("a", vec3(100, 50, 0))]), 0);
    const wt = scene.objects[0]!.worldTransform;
    const p = transformPoint(wt, vec3(0, 0, 0));
    expect(p.x).toBeCloseTo(100, 6);
    expect(p.y).toBeCloseTo(50, 6);
  });

  it("composes parent chain: W_child = W_parent · L_child", () => {
    const parent = atPos("p", vec3(100, 0, 0));
    const child = atPos("c", vec3(10, 0, 0), { parent: "p" });
    const scene = resolve(comp([parent, child]), 0);
    const childResolved = scene.objects.find((o) => o.id === "c")!;
    // child origin → parent(100) + child(10) = (110,0,0)
    expect(transformPoint(childResolved.worldTransform, vec3(0, 0, 0)).x).toBeCloseTo(110, 6);
  });

  it("parent transform is inherited even when parent is invisible", () => {
    const parent = atPos("p", vec3(100, 0, 0), { enabled: false });
    const child = atPos("c", vec3(10, 0, 0), { parent: "p" });
    const scene = resolve(comp([parent, child]), 0);
    expect(scene.objects.map((o) => o.id)).toEqual(["c"]); // parent not rendered
    const childResolved = scene.objects[0]!;
    expect(transformPoint(childResolved.worldTransform, vec3(0, 0, 0)).x).toBeCloseTo(110, 6);
  });
});

describe("resolve — visibility & ordering", () => {
  it("excludes disabled and out-of-range objects (inPoint/outPoint)", () => {
    const scene = resolve(
      comp([
        makeObject({ id: "on", inPoint: 0, outPoint: 30 }),
        makeObject({ id: "future", inPoint: 50, outPoint: 100 }),
        makeObject({ id: "off", enabled: false }),
      ]),
      10,
    );
    expect(scene.objects.map((o) => o.id)).toEqual(["on"]);
  });

  it("sorts objects by zOrder ascending (small = back)", () => {
    const scene = resolve(
      comp([
        makeObject({ id: "front", zOrder: 3 }),
        makeObject({ id: "back", zOrder: 1 }),
        makeObject({ id: "mid", zOrder: 2 }),
      ]),
      0,
    );
    expect(scene.objects.map((o) => o.id)).toEqual(["back", "mid", "front"]);
  });

  it("resolves per-object opacity (not inherited)", () => {
    const child = makeObject({ id: "c", parent: "p", opacity: staticProp(0.5) });
    const parent = makeObject({ id: "p", opacity: staticProp(0.2) });
    const scene = resolve(comp([parent, child]), 0);
    expect(scene.objects.find((o) => o.id === "c")!.opacity).toBe(0.5);
  });
});

describe("resolve — component prop resolution", () => {
  it("samples animated component props at the frame", () => {
    const obj = makeObject({
      id: "s",
      components: [
        {
          type: "solid",
          props: {
            color: { r: 1, g: 0, b: 0, a: 1 },
            size: {
              value: vec3(),
              keyframes: [
                { frame: 0, value: vec3(0, 0, 0), easing: { type: "linear" } },
                { frame: 10, value: vec3(100, 100, 0), easing: { type: "linear" } },
              ],
            },
          },
        },
      ],
    });
    const scene = resolve(comp([obj]), 5);
    const rc = scene.objects[0]!.components[0]!;
    expect(rc.props.color).toEqual({ r: 1, g: 0, b: 0, a: 1 }); // raw passthrough
    expect(rc.props.size).toEqual(vec3(50, 50, 0)); // interpolated
  });
});

describe("resolve — INV-1 determinism", () => {
  it("same input → deeply equal output", () => {
    const c = comp([atPos("a", vec3(10, 20, 30)), atPos("b", vec3(1, 2, 3), { parent: "a" })]);
    expect(resolve(c, 7)).toEqual(resolve(c, 7));
  });
});

describe("resolve — expression seam (§9, M2 frozen boundary)", () => {
  function objWithExprOpacity(): SceneObject {
    return makeObject({
      id: "e",
      opacity: {
        value: 1,
        keyframes: [],
        expression: { path: "scripts/e/opacity.js", enabled: true },
      },
    });
  }

  it("ignores expressions when no evaluator is provided (keyframe/static value used)", () => {
    const scene = resolve(comp([objWithExprOpacity()]), 0);
    expect(scene.objects[0]!.opacity).toBe(1);
  });

  it("applies the evaluator result, overriding the sampled value (§5.2)", () => {
    const scene = resolve(comp([objWithExprOpacity()]), 0, {
      expressions: ({ value }) => (value as number) * 0.5,
    });
    expect(scene.objects[0]!.opacity).toBe(0.5);
  });

  it("passes frame/fps/value/objectId to the evaluator", () => {
    const seen: unknown[] = [];
    resolve(comp([objWithExprOpacity()]), 7, {
      expressions: (args) => {
        seen.push(args);
        return args.value;
      },
    });
    expect(seen[0]).toMatchObject({ path: "scripts/e/opacity.js", frame: 7, fps: 30, value: 1, objectId: "e" });
  });

  it("falls back to the sampled value when the evaluator throws (§9, never stops render)", () => {
    const scene = resolve(comp([objWithExprOpacity()]), 0, {
      expressions: () => {
        throw new Error("boom");
      },
    });
    expect(scene.objects[0]!.opacity).toBe(1); // fallback to ctx.value
  });

  it("stays deterministic given a pure evaluator (INV-1)", () => {
    const c = comp([objWithExprOpacity()]);
    const evalFn = { expressions: ({ value }: { value: unknown }) => (value as number) * 0.3 };
    expect(resolve(c, 3, evalFn)).toEqual(resolve(c, 3, evalFn));
  });
});

describe("resolve — camera (§6.5)", () => {
  it("produces a view matrix = inverse(camera world) when activeCamera set", () => {
    const cam = atPos("cam", vec3(0, 0, 500), {
      components: [{ type: "camera", props: { fov: 60 } }],
    });
    const scene = resolve(comp([cam, atPos("x", vec3(0, 0, 0))], { activeCamera: "cam" }), 0);
    expect(scene.camera).toBeDefined();
    expect(scene.camera!.fov).toBe(60);
    // camera at z=500 → view matrix translates scene by -500 in z
    const origin = transformPoint(scene.camera!.viewMatrix, vec3(0, 0, 0));
    expect(origin.z).toBeCloseTo(-500, 6);
  });
});
