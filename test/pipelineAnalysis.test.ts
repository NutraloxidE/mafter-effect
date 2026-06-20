import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { defaultTransform, staticProp } from "../src/core/props";
import { pipelineAnalysis, layerPipelineKind } from "../src/editor/pipelineAnalysis";
import { registerBuiltinEffects } from "../src/runtime/builtinEffects";
import { registerFastEffects } from "../src/runtime/fastEffects";
import type { Project, SceneObject, TimelineComposition } from "../src/core/schema";

function timeline(p: Project): TimelineComposition {
  const comp = p.compositions[0];
  if (!comp || comp.kind !== "timeline") throw new Error("expected timeline");
  return comp;
}

function baseObj(id: string, overrides: Partial<SceneObject> = {}): SceneObject {
  return {
    id,
    name: overrides.name ?? id,
    parent: null,
    zOrder: overrides.zOrder ?? 1,
    enabled: true,
    inPoint: 0,
    outPoint: 90,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [],
    ...overrides,
  };
}

describe("layerPipelineKind", () => {
  beforeAll(() => {
    registerBuiltinEffects();
    registerFastEffects();
  });

  it("Live調整 + blur は live", () => {
    const obj = baseObj("01A", {
      isAdjustment: true,
      effects: [{ id: "fx1", type: "blur", enabled: true, props: {} }],
    });
    expect(layerPipelineKind(obj)).toBe("live");
  });

  it("Raster調整 + blur は raster", () => {
    const obj = baseObj("01A", {
      isAdjustment: true,
      adjustmentMode: "raster",
      effects: [{ id: "fx1", type: "blur", enabled: true, props: {} }],
    });
    expect(layerPipelineKind(obj)).toBe("raster");
  });

  it("通常レイヤー + wave は raster", () => {
    const obj = baseObj("01A", {
      effects: [{ id: "fx1", type: "wave", enabled: true, props: {} }],
    });
    expect(layerPipelineKind(obj)).toBe("raster");
  });

  it("通常レイヤー + fastWave は live（raster 無し・§27.12 改定3）", () => {
    const obj = baseObj("01A", {
      effects: [{ id: "fx1", type: "fastWave", enabled: true, props: {} }],
    });
    expect(layerPipelineKind(obj)).toBe("live");
  });

  it("Live調整 + fastWave は live（backdrop・§27.12 改定3）", () => {
    const obj = baseObj("01A", {
      isAdjustment: true,
      adjustmentMode: "live",
      effects: [{ id: "fx1", type: "fastWave", enabled: true, props: {} }],
    });
    expect(layerPipelineKind(obj)).toBe("live");
  });

  it("Live調整 + ripple(full) は raster", () => {
    const obj = baseObj("01A", {
      isAdjustment: true,
      adjustmentMode: "live",
      effects: [{ id: "fx1", type: "ripple", enabled: true, props: {} }],
    });
    expect(layerPipelineKind(obj)).toBe("raster");
  });
});

describe("pipelineAnalysis", () => {
  beforeAll(() => {
    registerBuiltinEffects();
    registerFastEffects();
  });

  it("effect なし comp は軽量", () => {
    const p = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const result = pipelineAnalysis(timeline(p), p);
    expect(result.rasterPassCount).toBe(0);
    expect(result.summaryTone).toBe("light");
    expect(result.segments).toHaveLength(0);
  });

  it("live→raster→live の崖を検出", () => {
    const p = createProject({ now: "2026-01-01T00:00:00.000Z" });
    timeline(p).objects = [
      baseObj("01LIVE", {
        name: "LiveAdj",
        zOrder: 1,
        isAdjustment: true,
        effects: [{ id: "fx1", type: "blur", enabled: true, props: {} }],
      }),
      baseObj("01RAST", {
        name: "WaveLayer",
        zOrder: 2,
        effects: [{ id: "fx2", type: "wave", enabled: true, props: {} }],
      }),
      baseObj("01LIVE2", {
        name: "LiveAdj2",
        zOrder: 3,
        isAdjustment: true,
        effects: [{ id: "fx3", type: "tint", enabled: true, props: {} }],
      }),
    ];
    const result = pipelineAnalysis(timeline(p), p);
    expect(result.rasterPassCount).toBe(1);
    expect(result.cliffs).toHaveLength(1);
    expect(result.cliffs[0]?.atIndex).toBe(1);
    expect(result.exportRasterExtra).toBe(2);
  });

  it("raster 2段でやや重いサマリ", () => {
    const p = createProject({ now: "2026-01-01T00:00:00.000Z" });
    timeline(p).objects = [
      baseObj("01A", {
        zOrder: 1,
        effects: [{ id: "fx1", type: "wave", enabled: true, props: {} }],
      }),
      baseObj("01B", {
        zOrder: 2,
        adjustmentMode: "raster",
        isAdjustment: true,
        effects: [{ id: "fx2", type: "blur", enabled: true, props: {} }],
      }),
    ];
    const result = pipelineAnalysis(timeline(p), p);
    expect(result.rasterPassCount).toBe(2);
    expect(result.summaryLabel).toContain("2段");
    expect(result.summaryTone).toBe("heavy");
  });
});
