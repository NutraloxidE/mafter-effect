import { describe, expect, it } from "vitest";
import type { ResolvedObject } from "../src/runtime/resolved";
import { isStaticLayerCaptureCacheEnabled, staticLayerCaptureSignature } from "../src/runtime/staticLayerCaptureCache";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as ResolvedObject["worldTransform"];

function resolved(patch: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    id: "01CACHE0000000000000000000",
    worldTransform: identity,
    zOrder: 0,
    opacity: 1,
    blendMode: "normal",
    inPoint: 0,
    components: [{ type: "solid", props: { color: "#fff" } }],
    ...patch,
  };
}

describe("staticLayerCaptureSignature", () => {
  it("同じ2D solidは同じsignature、transform変化はmissになる", () => {
    const a = staticLayerCaptureSignature(resolved());
    expect(a).not.toBeNull();
    expect(staticLayerCaptureSignature(resolved())).toBe(a);
    const moved = [...identity] as ResolvedObject["worldTransform"];
    moved[12] = 10;
    expect(staticLayerCaptureSignature(resolved({ worldTransform: moved }))).not.toBe(a);
  });

  it("plain textは対象、geom textは対象外", () => {
    expect(staticLayerCaptureSignature(resolved({ components: [{ type: "text", props: { text: "A" } }] }))).not.toBeNull();
    expect(staticLayerCaptureSignature(resolved({ components: [{ type: "text", props: { text: "A", geomEnabled: true } }] }))).toBeNull();
  });

  it("effect・media・matte・3Dは対象外", () => {
    expect(staticLayerCaptureSignature(resolved({ effects: [{ type: "blur", enabled: true, props: {} }] }))).toBeNull();
    expect(staticLayerCaptureSignature(resolved({ components: [{ type: "image", props: {} }] }))).toBeNull();
    expect(staticLayerCaptureSignature(resolved({ trackMatte: { mode: "alpha", matteId: "01MATTE0000000000000000000" } }))).toBeNull();
    expect(staticLayerCaptureSignature(resolved({ threeD: true }))).toBeNull();
  });
});

describe("isStaticLayerCaptureCacheEnabled", () => {
  it("既定true、false明示だけA/B用に停止する", () => {
    const g = globalThis as { __mafterStaticLayerCaptureCache?: unknown };
    const previous = g.__mafterStaticLayerCaptureCache;
    try {
      delete g.__mafterStaticLayerCaptureCache;
      expect(isStaticLayerCaptureCacheEnabled()).toBe(true);
      g.__mafterStaticLayerCaptureCache = false;
      expect(isStaticLayerCaptureCacheEnabled()).toBe(false);
    } finally {
      if (previous === undefined) delete g.__mafterStaticLayerCaptureCache;
      else g.__mafterStaticLayerCaptureCache = previous;
    }
  });
});
