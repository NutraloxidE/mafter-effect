import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { defaultTransform, staticProp } from "../src/core/props";
import { pipelineAnalysis, layerPipelineKind } from "../src/editor/pipelineAnalysis";
import { registerBuiltinEffects } from "../src/runtime/builtinEffects";
import { registerFastEffects } from "../src/runtime/fastEffects";
import type { AssetEntry, Project, SceneObject, TimelineComposition } from "../src/core/schema";

function videoLayer(id: string, assetId: string, overrides: Partial<SceneObject> = {}): SceneObject {
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
    components: [{ type: "video", props: { asset: assetId, trimStart: 0 } }],
    ...overrides,
  };
}

function videoAsset(id: string, alphaMode: "split" | "unified" | undefined): AssetEntry {
  const meta: Record<string, unknown> =
    alphaMode === undefined ? {} : { hasAlpha: true, alphaMode };
  if (alphaMode === "split") meta.alphaPath = `assets/${id}.alpha.webm`;
  return { id, path: `assets/${id}.webm`, kind: "video", meta };
}

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

  it("通常レイヤー + mosaicLite は live（軽量モザイク近似）", () => {
    const obj = baseObj("01A", {
      effects: [{ id: "fx1", type: "mosaicLite", enabled: true, props: { blockSize: 16 } }],
    });
    expect(layerPipelineKind(obj)).toBe("live");
  });

  it("通常レイヤー + mosaic は raster（正確なブロック平均）", () => {
    const obj = baseObj("01A", {
      effects: [{ id: "fx1", type: "mosaic", enabled: true, props: { blockSize: 16 } }],
    });
    expect(layerPipelineKind(obj)).toBe("raster");
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

  it("split alpha 動画レイヤーは alphaWarnings に検出される（effect 無しでも）", () => {
    const p = createProject({ now: "2026-01-01T00:00:00.000Z" });
    p.assets.push(videoAsset("asset-split", "split"));
    timeline(p).objects = [videoLayer("01V", "asset-split", { name: "Person" })];

    const result = pipelineAnalysis(timeline(p), p);
    expect(result.alphaWarnings).toHaveLength(1);
    expect(result.alphaWarnings[0]?.objectId).toBe("01V");
    expect(result.alphaWarnings[0]?.objectName).toBe("Person");
    expect(result.alphaWarnings[0]?.depth).toBe(0);
    expect(result.alphaWarnings[0]?.message).toContain("2回描画");
  });

  it("unified alpha / 通常動画は alphaWarnings を出さない", () => {
    const p = createProject({ now: "2026-01-01T00:00:00.000Z" });
    p.assets.push(videoAsset("asset-unified", "unified"), videoAsset("asset-plain", undefined));
    timeline(p).objects = [
      videoLayer("01U", "asset-unified", { zOrder: 1 }),
      videoLayer("01P", "asset-plain", { zOrder: 2 }),
    ];

    const result = pipelineAnalysis(timeline(p), p);
    expect(result.alphaWarnings).toHaveLength(0);
  });

  it("nested precomp 内の split alpha レイヤーも depth 付きで検出される", () => {
    const p = createProject({ now: "2026-01-01T00:00:00.000Z" });
    p.assets.push(videoAsset("asset-split", "split"));

    const nestedComp: TimelineComposition = {
      id: "nested-comp",
      name: "Nested",
      kind: "timeline",
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 90,
      objects: [videoLayer("01NV", "asset-split", { name: "NestedPerson" })],
    };
    p.compositions.push(nestedComp);

    const precompLayer: SceneObject = {
      id: "01PRE",
      name: "Precomp",
      parent: null,
      zOrder: 1,
      enabled: true,
      inPoint: 0,
      outPoint: 90,
      transform: defaultTransform(),
      opacity: staticProp(1),
      components: [{ type: "comp", props: { compId: "nested-comp", trimStart: 0 } }],
    };
    timeline(p).objects = [precompLayer];

    const result = pipelineAnalysis(timeline(p), p);
    expect(result.alphaWarnings).toHaveLength(1);
    expect(result.alphaWarnings[0]?.objectId).toBe("01NV");
    expect(result.alphaWarnings[0]?.depth).toBe(1);
  });
});

describe("glLayers（§5.5f WebGL context 上限の目安）", () => {
  const text3d = (id: string, enabled3d: boolean, overrides: Partial<SceneObject> = {}) =>
    baseObj(id, {
      components: [{ type: "text", props: { text: staticProp("hi"), geomEnabled: enabled3d } }],
      ...overrides,
    });

  it("3D Extrude ON の text だけを数える（2D text は 0）", () => {
    const p = createProject({ now: "2026-01-01T00:00:00.000Z" });
    timeline(p).objects = [text3d("01A", true), text3d("01B", false), text3d("01C", true)];

    const gl = pipelineAnalysis(timeline(p), p).glLayers;
    expect(gl.geom3d).toBe(2);
    expect(gl.total).toBe(2);
  });

  it("canvas 共有したレイヤー群は 1 canvas として数える（§5.5f-1）", () => {
    const p = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const shared = (id: string, zOrder: number) =>
      baseObj(id, {
        zOrder,
        components: [
          { type: "text", props: { text: staticProp("hi"), geomEnabled: true, geomShareCanvas: true } },
        ],
      });
    timeline(p).objects = [text3d("01A", true), shared("01B", 1), shared("01C", 2)];

    expect(pipelineAnalysis(timeline(p), p).glLayers.geom3d).toBe(2);
  });

  it("無効レイヤーは context を作らないので数えない", () => {
    const p = createProject({ now: "2026-01-01T00:00:00.000Z" });
    timeline(p).objects = [text3d("01A", true), text3d("01B", true, { enabled: false })];

    expect(pipelineAnalysis(timeline(p), p).glLayers.geom3d).toBe(1);
  });

  it("split/packed alpha video を alphaVideo として数える", () => {
    const p = createProject({ now: "2026-01-01T00:00:00.000Z" });
    p.assets.push(videoAsset("asset-split", "split"));
    p.assets.push(videoAsset("asset-plain", undefined));
    timeline(p).objects = [videoLayer("01V", "asset-split"), videoLayer("01W", "asset-plain")];

    const gl = pipelineAnalysis(timeline(p), p).glLayers;
    expect(gl.alphaVideo).toBe(1);
    expect(gl.geom3d).toBe(0);
  });

  it("precomp の中身も再帰カウントし、同じ precomp を 2 回置けば 2 倍になる", () => {
    const p = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const nestedComp: TimelineComposition = {
      id: "nested-comp",
      name: "Nested",
      kind: "timeline",
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 90,
      objects: [text3d("01N1", true), text3d("01N2", true)],
    };
    p.compositions.push(nestedComp);
    const compLayer = (id: string) =>
      baseObj(id, { components: [{ type: "comp", props: { compId: "nested-comp", trimStart: 0 } }] });
    timeline(p).objects = [compLayer("01P1"), compLayer("01P2"), text3d("01T", true)];

    // nested 2 枚 × precomp 2 個 + 直下 1 枚 = 5
    expect(pipelineAnalysis(timeline(p), p).glLayers.total).toBe(5);
  });
});
