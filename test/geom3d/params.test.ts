import { describe, expect, it } from "vitest";
import { curveQualitySegments, GEOM3D_PARAM_DESCRIPTORS, parseGeom3DParams } from "../../src/runtime/geom3d/geom3dParams";

describe("parseGeom3DParams", () => {
  it("returns defaults when props are missing (backward compat with pre-3D projects)", () => {
    const p = parseGeom3DParams({});
    expect(p.enabled).toBe(false);
    expect(p.depth).toBe(50);
    expect(p.bevelSize).toBe(0);
    expect(p.bevelSegments).toBe(2);
    expect(p.curveQuality).toBe("medium");
    expect(p.shading).toBe("lambert");
    expect(p.ambient).toBeCloseTo(0.35);
    expect(p.lightDir).toEqual({ x: -0.5, y: -0.7, z: -0.5 });
  });

  it("reads explicit values", () => {
    const p = parseGeom3DParams({
      geomEnabled: true,
      geomDepth: 120,
      geomBevelSize: 8,
      geomBevelSegments: 4,
      geomCurveQuality: "high",
      geomShading: "none",
      geomAmbient: 0.8,
      geomLightDir: { x: 1, y: 0, z: 0 },
    });
    expect(p.enabled).toBe(true);
    expect(p.depth).toBe(120);
    expect(p.bevelSize).toBe(8);
    expect(p.bevelSegments).toBe(4);
    expect(p.curveQuality).toBe("high");
    expect(p.shading).toBe("none");
    expect(p.ambient).toBeCloseTo(0.8);
    expect(p.lightDir).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("clamps out-of-range values (depth<0, ambient>1, bevelSegments out of [1,8])", () => {
    const p = parseGeom3DParams({
      geomDepth: -10,
      geomBevelSize: -5,
      geomAmbient: 5,
      geomBevelSegments: 99,
    });
    expect(p.depth).toBe(0);
    expect(p.bevelSize).toBe(0);
    expect(p.ambient).toBe(1);
    expect(p.bevelSegments).toBe(8);
  });

  it("clamps bevelSegments below range too", () => {
    const p = parseGeom3DParams({ geomBevelSegments: 0 });
    expect(p.bevelSegments).toBe(1);
  });

  it("falls back on invalid enum values instead of throwing", () => {
    const p = parseGeom3DParams({ geomCurveQuality: "ultra", geomShading: "toon" });
    expect(p.curveQuality).toBe("medium");
    expect(p.shading).toBe("lambert");
  });

  it("geomEnabled is strictly boolean-true gated (truthy non-bool does not enable)", () => {
    expect(parseGeom3DParams({ geomEnabled: "true" as unknown as boolean }).enabled).toBe(false);
    expect(parseGeom3DParams({ geomEnabled: 1 as unknown as boolean }).enabled).toBe(false);
  });
});

describe("curveQualitySegments", () => {
  it("maps quality tiers to segment counts", () => {
    expect(curveQualitySegments("low")).toBe(8);
    expect(curveQualitySegments("medium")).toBe(16);
    expect(curveQualitySegments("high")).toBe(32);
  });
});

describe("GEOM3D_PARAM_DESCRIPTORS", () => {
  it("declares geomEnabled as non-animatable (structural toggle, not a KF-able value)", () => {
    const enabled = GEOM3D_PARAM_DESCRIPTORS.find((d) => d.key === "geomEnabled");
    expect(enabled?.animatable).toBe(false);
    expect(enabled?.kind).toBe("bool");
  });

  it("declares depth/bevelSize/ambient as animatable scalars", () => {
    for (const key of ["geomDepth", "geomBevelSize", "geomAmbient"]) {
      const d = GEOM3D_PARAM_DESCRIPTORS.find((x) => x.key === key);
      expect(d?.animatable).toBe(true);
      expect(d?.kind).toBe("scalar");
    }
  });

  it("has unique keys", () => {
    const keys = GEOM3D_PARAM_DESCRIPTORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
