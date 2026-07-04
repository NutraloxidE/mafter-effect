import { describe, expect, it } from "vitest";
import type { SceneObject, TrackMatteMode } from "../src/core/schema";
import { defaultTransform, staticProp } from "../src/core/props";
import {
  isTrackMatteIneligible,
  resolveTrackMattePairs,
  trackMatteMaskId,
} from "../src/core/trackMatte";
import { applyEmptyTrackMatte, applyTrackMatte, type RgbaBuffer } from "../src/runtime/trackMatteApply";
import { resolve } from "../src/runtime/resolve";
import type { TimelineComposition } from "../src/core/schema";

function solidObj(
  id: string,
  zOrder: number,
  opts: Partial<SceneObject> & { trackMatteMode?: TrackMatteMode } = {},
): SceneObject {
  return {
    id,
    name: id,
    parent: null,
    zOrder,
    enabled: true,
    inPoint: 0,
    outPoint: 100,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [{ type: "solid", props: { color: staticProp({ r: 1, g: 0, b: 0, a: 1 }), width: staticProp(10), height: staticProp(10) } }],
    ...opts,
  };
}

function rgba(w: number, h: number, fill: [number, number, number, number]): RgbaBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = fill[3];
  }
  return { width: w, height: h, data };
}

describe("resolveTrackMattePairs", () => {
  it("pairs fill with next higher zOrder enabled layer", () => {
    const objects = [
      solidObj("a", 1, { trackMatteMode: "alpha" }),
      solidObj("b", 2),
      solidObj("c", 3),
    ];
    expect(resolveTrackMattePairs(objects)).toEqual([
      { fillId: "a", matteId: "b", mode: "alpha" },
    ]);
  });

  it("does not rebind when matte is disabled (still pairs with b)", () => {
    const objects = [
      solidObj("a", 1, { trackMatteMode: "alpha" }),
      solidObj("b", 2, { enabled: false }),
      solidObj("c", 3),
    ];
    expect(resolveTrackMattePairs(objects)).toEqual([
      { fillId: "a", matteId: "b", mode: "alpha" },
    ]);
  });

  it("ignores ineligible fill and matte", () => {
    const cam: SceneObject = {
      ...solidObj("cam", 2),
      components: [{ type: "camera", props: {} }],
    };
    const adj = solidObj("adj", 2, { isAdjustment: true, components: [] });
    expect(resolveTrackMattePairs([solidObj("a", 1, { trackMatteMode: "alpha" }), cam])).toEqual([]);
    expect(resolveTrackMattePairs([solidObj("a", 1, { trackMatteMode: "alpha" }), adj])).toEqual([]);
  });

  it("does not chain: matte source trackMatteMode ignored", () => {
    const objects = [
      solidObj("a", 1, { trackMatteMode: "alpha" }),
      solidObj("b", 2, { trackMatteMode: "luma" }),
      solidObj("c", 3),
    ];
    const pairs = resolveTrackMattePairs(objects);
    expect(pairs).toEqual([{ fillId: "a", matteId: "b", mode: "alpha" }]);
    // b is used as matte so cannot also be a fill in v1
    expect(pairs.find((p) => p.fillId === "b")).toBeUndefined();
  });

  it("topmost fill has no matte", () => {
    expect(resolveTrackMattePairs([solidObj("a", 1, { trackMatteMode: "alpha" })])).toEqual([]);
  });
});

describe("isTrackMatteIneligible", () => {
  it("flags adjustment, null, camera-only", () => {
    expect(isTrackMatteIneligible(solidObj("a", 1, { isAdjustment: true, components: [] }))).toBe(true);
    expect(isTrackMatteIneligible(solidObj("a", 1, { isNull: true, components: [] }))).toBe(true);
    expect(
      isTrackMatteIneligible({
        ...solidObj("a", 1),
        components: [{ type: "camera", props: {} }],
      }),
    ).toBe(true);
    expect(isTrackMatteIneligible(solidObj("a", 1))).toBe(false);
  });
});

describe("applyTrackMatte", () => {
  it("alpha multiplies fill alpha by matte alpha", () => {
    const fill = rgba(1, 1, [255, 0, 0, 255]);
    const matte = rgba(1, 1, [0, 0, 0, 128]);
    const out = applyTrackMatte(fill, matte, "alpha");
    expect(out.data[3]).toBe(128);
    expect(out.data[0]).toBe(255);
  });

  it("alphaInverted inverts matte alpha", () => {
    const fill = rgba(1, 1, [255, 0, 0, 255]);
    const matte = rgba(1, 1, [0, 0, 0, 0]);
    const out = applyTrackMatte(fill, matte, "alphaInverted");
    expect(out.data[3]).toBe(255);
  });

  it("luma uses luminance", () => {
    const fill = rgba(1, 1, [10, 20, 30, 255]);
    const matte = rgba(1, 1, [255, 255, 255, 255]);
    const out = applyTrackMatte(fill, matte, "luma");
    expect(out.data[3]).toBe(255);
    const matteBlack = rgba(1, 1, [0, 0, 0, 255]);
    const out2 = applyTrackMatte(fill, matteBlack, "luma");
    expect(out2.data[3]).toBe(0);
  });

  it("empty matte fully hides alpha fill", () => {
    const fill = rgba(2, 2, [255, 255, 255, 255]);
    const matte = rgba(2, 2, [0, 0, 0, 0]);
    const out = applyTrackMatte(fill, matte, "alpha");
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(0);
  });
});

describe("resolve() track matte flags", () => {
  it("sets trackMatte on fill and isTrackMatteSource on matte when both visible", () => {
    const comp: TimelineComposition = {
      id: "c1",
      name: "c",
      kind: "timeline",
      width: 100,
      height: 100,
      fps: 30,
      duration: 30,
      objects: [
        solidObj("fill", 1, { trackMatteMode: "alpha" }),
        solidObj("matte", 2),
      ],
    };
    const scene = resolve(comp, 0);
    const fill = scene.objects.find((o) => o.id === "fill");
    const matte = scene.objects.find((o) => o.id === "matte");
    expect(fill?.trackMatte).toEqual({ mode: "alpha", matteId: "matte" });
    expect(matte?.isTrackMatteSource).toBe(true);
  });

  it("keeps trackMatte on fill when matte is outside in/out (empty matte)", () => {
    const comp: TimelineComposition = {
      id: "c1",
      name: "c",
      kind: "timeline",
      width: 100,
      height: 100,
      fps: 30,
      duration: 30,
      objects: [
        solidObj("fill", 1, { trackMatteMode: "alpha", inPoint: 0, outPoint: 30 }),
        solidObj("matte", 2, { inPoint: 10, outPoint: 20 }),
      ],
    };
    const scene = resolve(comp, 0);
    const fill = scene.objects.find((o) => o.id === "fill");
    expect(fill?.trackMatte).toEqual({ mode: "alpha", matteId: "matte" });
    expect(scene.objects.find((o) => o.id === "matte")).toBeUndefined();
  });
});

describe("trackMatteMaskId", () => {
  it("prefixes fill id", () => {
    expect(trackMatteMaskId("01ABC")).toBe("tm-01ABC");
  });
});

describe("applyEmptyTrackMatte", () => {
  it("alpha empty matte clears fill", () => {
    const fill = rgba(2, 2, [255, 0, 0, 255]);
    const out = applyEmptyTrackMatte(fill, "alpha");
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(0);
  });

  it("alphaInverted empty matte keeps fill", () => {
    const fill = rgba(1, 1, [10, 20, 30, 255]);
    const out = applyEmptyTrackMatte(fill, "alphaInverted");
    expect([...out.data]).toEqual([10, 20, 30, 255]);
  });
});
