import { describe, expect, it } from "vitest";
import { directSolidCaptureDescriptor, isDirectSolidCaptureEnabled } from "../src/runtime/directSolidCapture";
import { identity, perspective } from "../src/runtime/mat4";
import type { ResolvedObject } from "../src/runtime/resolved";

function solidObject(overrides: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    id: "01DIRECTSOLID00000000000000",
    worldTransform: identity(),
    zOrder: 1,
    opacity: 0.6,
    blendMode: "normal",
    inPoint: 0,
    components: [{
      type: "solid",
      props: { color: { r: 0.2, g: 0.4, b: 0.8, a: 0.5 }, size: { x: 320, y: 180, z: 0 } },
    }],
    ...overrides,
  };
}

describe("directSolidCaptureDescriptor", () => {
  it("accepts one effect-free 2D solid", () => {
    expect(directSolidCaptureDescriptor(solidObject())).toEqual({
      worldTransform: identity(),
      opacity: 0.6,
      color: { r: 0.2, g: 0.4, b: 0.8, a: 0.5 },
      size: { x: 320, y: 180, z: 0 },
    });
  });

  it("rejects effects, matte, 3D, multiple components, and perspective", () => {
    expect(directSolidCaptureDescriptor(solidObject({ effects: [{ type: "blur", enabled: true, props: {} }] }))).toBeNull();
    expect(directSolidCaptureDescriptor(solidObject({ trackMatte: { mode: "alpha", matteId: "01MATTE0000000000000000000" } }))).toBeNull();
    expect(directSolidCaptureDescriptor(solidObject({ threeD: true }))).toBeNull();
    expect(directSolidCaptureDescriptor(solidObject({ components: [...solidObject().components, { type: "text", props: {} }] }))).toBeNull();
    expect(directSolidCaptureDescriptor(solidObject({ worldTransform: perspective(45, 1, 0.1, 100) }))).toBeNull();
  });

  it("rejects missing or non-positive geometry and clamps opacity", () => {
    expect(directSolidCaptureDescriptor(solidObject({ components: [{ type: "solid", props: {} }] }))).toBeNull();
    expect(directSolidCaptureDescriptor(solidObject({
      components: [{ type: "solid", props: { color: { r: 0, g: 0, b: 0, a: 1 }, size: { x: 0, y: 10, z: 0 } } }],
    }))).toBeNull();
    expect(directSolidCaptureDescriptor(solidObject({ opacity: 2 }))).toMatchObject({ opacity: 1 });
  });
});

describe("direct solid capture flag", () => {
  it("is enabled unless explicitly disabled", () => {
    const g = globalThis as { __mafterDirectSolidCapture?: unknown };
    const previous = g.__mafterDirectSolidCapture;
    try {
      delete g.__mafterDirectSolidCapture;
      expect(isDirectSolidCaptureEnabled()).toBe(true);
      g.__mafterDirectSolidCapture = false;
      expect(isDirectSolidCaptureEnabled()).toBe(false);
    } finally {
      if (previous === undefined) delete g.__mafterDirectSolidCapture;
      else g.__mafterDirectSolidCapture = previous;
    }
  });
});
