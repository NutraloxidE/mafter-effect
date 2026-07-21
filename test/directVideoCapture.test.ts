import { describe, expect, it } from "vitest";
import {
  directVideoCaptureDescriptor,
  isCanvas2DAffineTransform,
  isDirectVideoCaptureEnabled,
  videoDrawRect,
} from "../src/runtime/directVideoCapture";
import { identity, perspective } from "../src/runtime/mat4";
import type { ResolvedObject } from "../src/runtime/resolved";

function videoObject(overrides: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    id: "01DIRECTVIDEO00000000000000",
    worldTransform: identity(),
    zOrder: 1,
    opacity: 0.75,
    blendMode: "normal",
    inPoint: 0,
    components: [{ type: "video", props: { asset: "01ASSET0000000000000000000", fit: "contain" } }],
    ...overrides,
  };
}

describe("directVideoCaptureDescriptor", () => {
  it("accepts one effect-free 2D video and preserves affine placement", () => {
    const matrix = identity();
    matrix[0] = 2;
    matrix[5] = 3;
    matrix[12] = 40;
    matrix[13] = 50;
    const descriptor = directVideoCaptureDescriptor(videoObject({ worldTransform: matrix }));
    expect(descriptor).toEqual({ worldTransform: matrix, opacity: 0.75, fit: "contain" });
  });

  it("rejects effects, matte, 3D, multiple components, and perspective matrices", () => {
    expect(directVideoCaptureDescriptor(videoObject({ effects: [{ type: "blur", enabled: true, props: {} }] }))).toBeNull();
    expect(directVideoCaptureDescriptor(videoObject({ trackMatte: { mode: "alpha", matteId: "01MATTE0000000000000000000" } }))).toBeNull();
    expect(directVideoCaptureDescriptor(videoObject({ threeD: true }))).toBeNull();
    expect(directVideoCaptureDescriptor(videoObject({ components: [...videoObject().components, { type: "solid", props: {} }] }))).toBeNull();
    expect(directVideoCaptureDescriptor(videoObject({ worldTransform: perspective(45, 1, 0.1, 100) }))).toBeNull();
  });

  it("normalizes unknown fit and clamps opacity", () => {
    const obj = videoObject({ opacity: 2 });
    obj.components[0]!.props["fit"] = "unknown";
    expect(directVideoCaptureDescriptor(obj)).toMatchObject({ fit: "contain", opacity: 1 });
  });
});

describe("videoDrawRect", () => {
  it("centers contain content", () => {
    expect(videoDrawRect(1920, 1080, 100, 100, "contain")).toEqual({
      sx: 0, sy: 0, sw: 1920, sh: 1080,
      dx: 0, dy: 21.875, dw: 100, dh: 56.25,
    });
  });

  it("center-crops cover content", () => {
    expect(videoDrawRect(1920, 1080, 100, 100, "cover")).toEqual({
      sx: 420, sy: 0, sw: 1080, sh: 1080,
      dx: 0, dy: 0, dw: 100, dh: 100,
    });
  });

  it("stretches fill and rejects invalid sizes", () => {
    expect(videoDrawRect(10, 20, 30, 40, "fill")).toEqual({
      sx: 0, sy: 0, sw: 10, sh: 20,
      dx: 0, dy: 0, dw: 30, dh: 40,
    });
    expect(videoDrawRect(0, 20, 30, 40, "fill")).toBeNull();
  });
});

describe("direct video capture flag", () => {
  it("is enabled unless explicitly disabled", () => {
    const g = globalThis as { __mafterDirectVideoCapture?: unknown };
    const previous = g.__mafterDirectVideoCapture;
    try {
      delete g.__mafterDirectVideoCapture;
      expect(isDirectVideoCaptureEnabled()).toBe(true);
      g.__mafterDirectVideoCapture = false;
      expect(isDirectVideoCaptureEnabled()).toBe(false);
    } finally {
      if (previous === undefined) delete g.__mafterDirectVideoCapture;
      else g.__mafterDirectVideoCapture = previous;
    }
  });
});

describe("isCanvas2DAffineTransform", () => {
  it("accepts identity and rejects z translation", () => {
    expect(isCanvas2DAffineTransform(identity())).toBe(true);
    const matrix = identity();
    matrix[14] = 1;
    expect(isCanvas2DAffineTransform(matrix)).toBe(false);
  });
});
