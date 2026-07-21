import { describe, expect, it } from "vitest";
import { directImageCaptureDescriptor, isDirectImageCaptureEnabled } from "../src/runtime/directImageCapture";
import { identity, perspective } from "../src/runtime/mat4";
import type { ResolvedObject } from "../src/runtime/resolved";

function imageObject(overrides: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    id: "01DIRECTIMAGE00000000000000",
    worldTransform: identity(),
    zOrder: 1,
    opacity: 0.7,
    blendMode: "normal",
    inPoint: 0,
    components: [{ type: "image", props: { asset: "01ASSET0000000000000000000", fit: "cover" } }],
    ...overrides,
  };
}

describe("directImageCaptureDescriptor", () => {
  it("accepts one effect-free 2D image and preserves fit", () => {
    expect(directImageCaptureDescriptor(imageObject())).toEqual({
      worldTransform: identity(), opacity: 0.7, fit: "cover",
    });
  });

  it("rejects effects, matte, 3D, multiple components, and perspective", () => {
    expect(directImageCaptureDescriptor(imageObject({ effects: [{ type: "blur", enabled: true, props: {} }] }))).toBeNull();
    expect(directImageCaptureDescriptor(imageObject({ trackMatte: { mode: "alpha", matteId: "01MATTE0000000000000000000" } }))).toBeNull();
    expect(directImageCaptureDescriptor(imageObject({ threeD: true }))).toBeNull();
    expect(directImageCaptureDescriptor(imageObject({ components: [...imageObject().components, { type: "solid", props: {} }] }))).toBeNull();
    expect(directImageCaptureDescriptor(imageObject({ worldTransform: perspective(45, 1, 0.1, 100) }))).toBeNull();
  });

  it("normalizes unknown fit and clamps opacity", () => {
    const obj = imageObject({ opacity: -1 });
    obj.components[0]!.props["fit"] = "unknown";
    expect(directImageCaptureDescriptor(obj)).toMatchObject({ fit: "contain", opacity: 0 });
  });
});

describe("direct image capture flag", () => {
  it("is enabled unless explicitly disabled", () => {
    const g = globalThis as { __mafterDirectImageCapture?: unknown };
    const previous = g.__mafterDirectImageCapture;
    try {
      delete g.__mafterDirectImageCapture;
      expect(isDirectImageCaptureEnabled()).toBe(true);
      g.__mafterDirectImageCapture = false;
      expect(isDirectImageCaptureEnabled()).toBe(false);
    } finally {
      if (previous === undefined) delete g.__mafterDirectImageCapture;
      else g.__mafterDirectImageCapture = previous;
    }
  });
});
