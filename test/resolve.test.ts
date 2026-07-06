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

  it("treats outPoint as exclusive (last visible frame is outPoint - 1)", () => {
    const c = comp([makeObject({ id: "on", inPoint: 0, outPoint: 30 })]);
    expect(resolve(c, 29).objects.map((o) => o.id)).toEqual(["on"]);
    expect(resolve(c, 30).objects).toHaveLength(0);
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

  it("§5.5c samples shape vertices (nested AnimatedProp pos/tangents) at the frame", () => {
    const obj = makeObject({
      id: "shape1",
      components: [
        {
          type: "shape",
          props: {
            kind: "path",
            fill: staticProp({ r: 1, g: 1, b: 1, a: 1 }),
            vertices: [
              {
                id: "v1",
                pos: {
                  value: vec3(0, 0, 0),
                  keyframes: [
                    { frame: 0, value: vec3(0, 0, 0), easing: { type: "linear" } },
                    { frame: 10, value: vec3(100, 0, 0), easing: { type: "linear" } },
                  ],
                },
                outTangent: staticProp(vec3(5, 5, 0)),
              },
              { id: "v2", pos: staticProp(vec3(50, 100, 0)) },
            ],
          },
        },
      ],
    });
    const scene = resolve(comp([obj]), 5);
    const rc = scene.objects[0]!.components[0]!;
    const vertices = rc.props.vertices as { id: string; pos: Vec3; outTangent?: Vec3; inTangent?: Vec3 }[];
    expect(vertices).toHaveLength(2);
    expect(vertices[0]!.pos).toEqual(vec3(50, 0, 0)); // interpolated at frame 5
    expect(vertices[0]!.outTangent).toEqual(vec3(5, 5, 0));
    expect(vertices[0]!.inTangent).toBeUndefined();
    expect(vertices[1]!.pos).toEqual(vec3(50, 100, 0)); // static
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

function camObj(id: string, pos: Vec3, over: Partial<SceneObject> = {}): SceneObject {
  return atPos(id, pos, {
    components: [{ type: "camera", props: { cameraType: "one-node", zoom: 1158 } }],
    ...over,
  });
}

describe("resolve — camera (§6.5)", () => {
  it("produces a view matrix = inverse(camera world) for the lone camera", () => {
    const cam = atPos("cam", vec3(0, 0, 500), {
      components: [{ type: "camera", props: { fov: 60 } }],
    });
    const scene = resolve(comp([cam, atPos("x", vec3(0, 0, 0))]), 0);
    expect(scene.camera).toBeDefined();
    expect(scene.camera!.fov).toBe(60);
    // camera at z=500 → view matrix translates scene by -500 in z
    const origin = transformPoint(scene.camera!.viewMatrix, vec3(0, 0, 0));
    expect(origin.z).toBeCloseTo(-500, 6);
  });

  it("derives fov from zoom(px): fov = 2·atan((h/2)/zoom) (§6.5b)", () => {
    // h=1080, zoom = 540/tan(25°) → fov = 50°
    const zoom = 540 / Math.tan((25 * Math.PI) / 180);
    const cam = atPos("cam", vec3(0, 0, 500), {
      components: [{ type: "camera", props: { cameraType: "one-node", zoom } }],
    });
    const scene = resolve(comp([cam]), 0);
    expect(scene.camera!.fov).toBeCloseTo(50, 4);
  });

  it("two-node camera looks at pointOfInterest (target in front, z<0) (§6.5b)", () => {
    const cam = atPos("cam", vec3(0, 0, 500), {
      components: [
        { type: "camera", props: { cameraType: "two-node", pointOfInterest: vec3(0, 0, 0), zoom: 1000 } },
      ],
    });
    const scene = resolve(comp([cam]), 0);
    // POI (origin) sits in front of the camera → view-space z negative.
    const poiInView = transformPoint(scene.camera!.viewMatrix, vec3(0, 0, 0));
    expect(poiInView.z).toBeLessThan(0);
    expect(poiInView.x).toBeCloseTo(0, 4);
    expect(poiInView.y).toBeCloseTo(0, 4);
  });

  it("straight-down two-node view == one-node invert(translate(eye)): no X/Y mirror (§6.5b)", () => {
    // camera directly in front of POI along +z → must match the one-node convention (translate(-eye)).
    const cam = atPos("cam", vec3(960, 540, 1158), {
      components: [
        { type: "camera", props: { cameraType: "two-node", pointOfInterest: vec3(960, 540, 0), zoom: 1158 } },
      ],
    });
    const scene = resolve(comp([cam]), 0);
    const v = scene.camera!.viewMatrix;
    // a point to the right of POI maps to view +x (NOT mirrored to -x).
    const right = transformPoint(v, vec3(960 + 100, 540, 0));
    expect(right.x).toBeCloseTo(100, 3);
    // a point below POI (world +y) maps to view +y (no flip).
    const below = transformPoint(v, vec3(960, 540 + 100, 0));
    expect(below.y).toBeCloseTo(100, 3);
  });
});

describe("resolve — active camera auto-selection (§6.5, AE 準拠)", () => {
  it("picks the topmost (highest zOrder) visible camera", () => {
    const back = camObj("back", vec3(0, 0, 300), { zOrder: 1 });
    const front = camObj("front", vec3(0, 0, 700), { zOrder: 5 });
    const scene = resolve(comp([back, front]), 0);
    // front camera (z=700) wins → view translates by -700.
    expect(transformPoint(scene.camera!.viewMatrix, vec3(0, 0, 0)).z).toBeCloseTo(-700, 6);
  });

  it("falls back to the next camera when the topmost is out of its time range", () => {
    const lower = camObj("lower", vec3(0, 0, 300), { zOrder: 1, inPoint: 0, outPoint: 100 });
    const topShort = camObj("top", vec3(0, 0, 700), { zOrder: 5, inPoint: 0, outPoint: 10 });
    const scene = resolve(comp([lower, topShort]), 50); // frame 50: top is out of range
    expect(transformPoint(scene.camera!.viewMatrix, vec3(0, 0, 0)).z).toBeCloseTo(-300, 6);
  });

  it("skips a disabled topmost camera", () => {
    const lower = camObj("lower", vec3(0, 0, 300), { zOrder: 1 });
    const topOff = camObj("top", vec3(0, 0, 700), { zOrder: 5, enabled: false });
    const scene = resolve(comp([lower, topOff]), 0);
    expect(transformPoint(scene.camera!.viewMatrix, vec3(0, 0, 0)).z).toBeCloseTo(-300, 6);
  });

  it("no visible camera → default view (scene.camera undefined)", () => {
    const offRange = camObj("c", vec3(0, 0, 500), { inPoint: 60, outPoint: 100 });
    const scene = resolve(comp([offRange]), 0);
    expect(scene.camera).toBeUndefined();
  });

  it("previewCamera override forces that camera (editor-only)", () => {
    const back = camObj("back", vec3(0, 0, 300), { zOrder: 1 });
    const front = camObj("front", vec3(0, 0, 700), { zOrder: 5 });
    const c = comp([back, front]);
    const scene = resolve(c, 0, { previewCamera: "back" });
    expect(transformPoint(scene.camera!.viewMatrix, vec3(0, 0, 0)).z).toBeCloseTo(-300, 6);
  });

  it('previewCamera "default" forces no camera (default view)', () => {
    const cam = camObj("cam", vec3(0, 0, 500));
    const scene = resolve(comp([cam]), 0, { previewCamera: "default" });
    expect(scene.camera).toBeUndefined();
  });

  it("INV-2: output resolve (no override) is independent of preview override", () => {
    const back = camObj("back", vec3(0, 0, 300), { zOrder: 1 });
    const front = camObj("front", vec3(0, 0, 700), { zOrder: 5 });
    const c = comp([back, front]);
    const output = resolve(c, 0); // export path: no previewCamera
    // auto-selected front camera regardless of any editor preview state.
    expect(transformPoint(output.camera!.viewMatrix, vec3(0, 0, 0)).z).toBeCloseTo(-700, 6);
  });
});

describe("resolve — 3D mode resolution (§5.4b)", () => {
  it("threeD!=true → no mode3d (flat 2D)", () => {
    const scene = resolve(comp([makeObject({ id: "a" })]), 0);
    expect(scene.objects[0]!.threeD).toBeUndefined();
    expect(scene.objects[0]!.mode3d).toBeUndefined();
  });

  it("auto follows comp.renderer3d: classic→dom, advanced→raster3d", () => {
    const classic = resolve(comp([makeObject({ id: "a", threeD: true })], { renderer3d: "classic" }), 0);
    expect(classic.objects[0]!.mode3d).toBe("dom");
    const advanced = resolve(comp([makeObject({ id: "a", threeD: true })], { renderer3d: "advanced" }), 0);
    expect(advanced.objects[0]!.mode3d).toBe("raster3d");
    // default (no renderer3d) = classic
    const def = resolve(comp([makeObject({ id: "a", threeD: true })]), 0);
    expect(def.objects[0]!.mode3d).toBe("dom");
  });

  it("explicit threeDMode overrides comp renderer3d", () => {
    const overrideRaster = resolve(
      comp([makeObject({ id: "a", threeD: true, threeDMode: "raster3d" })], { renderer3d: "classic" }),
      0,
    );
    expect(overrideRaster.objects[0]!.mode3d).toBe("raster3d");
    const overrideDom = resolve(
      comp([makeObject({ id: "a", threeD: true, threeDMode: "dom" })], { renderer3d: "advanced" }),
      0,
    );
    expect(overrideDom.objects[0]!.mode3d).toBe("dom");
  });
});
