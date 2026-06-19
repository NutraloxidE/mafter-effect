import { describe, expect, it } from "vitest";
import { registerBuiltinEffects } from "../src/runtime/builtinEffects";
import { defaultTransform, staticProp } from "../src/core/props";
import type { SceneObject, TimelineComposition } from "../src/core/schema";
import {
  compHasDisplacementEffect,
  compNeedsAutoPreviewCache,
  compRequiresPreviewBake,
  objectHasFastDisplacementOnly,
} from "../src/editor/previewCompAnalysis";
import { effectsAreFastDisplacementOnly } from "../src/runtime/previewDisplacement";
import { RamPreviewController } from "../src/editor/ramPreview";
import { MemoryFs } from "../src/fs/MemoryFs";
import { DefaultTieredCacheStore } from "../src/cache/tieredCacheStore";
import { InMemoryDiskCacheTier } from "../src/fs/PreviewCacheDb";

function makeComp(objects: SceneObject[] = []): TimelineComposition {
  return {
    id: "COMP01",
    name: "Main",
    kind: "timeline",
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 10,
    objects,
  };
}

describe("previewCompAnalysis", () => {
  beforeAll(() => {
    registerBuiltinEffects();
  });

  it("compRequiresPreviewBake is true only for pixelSorter", () => {
    const bakeObj: SceneObject = {
      id: "O1",
      name: "s",
      parent: null,
      zOrder: 1,
      enabled: true,
      inPoint: 0,
      outPoint: 10,
      transform: defaultTransform(),
      opacity: staticProp(1),
      components: [],
      effects: [{ id: "FX1", type: "pixelSorter", enabled: true, props: {} }],
    };
    const waveObj: SceneObject = {
      ...bakeObj,
      id: "O2",
      effects: [{ id: "FX2", type: "wave", enabled: true, props: { amplitude: 10 } }],
    };
    expect(compRequiresPreviewBake(makeComp([bakeObj]))).toBe(true);
    expect(compRequiresPreviewBake(makeComp([waveObj]))).toBe(false);
  });

  it("compNeedsAutoPreviewCache includes displacement", () => {
    const waveObj: SceneObject = {
      id: "O1",
      name: "s",
      parent: null,
      zOrder: 1,
      enabled: true,
      inPoint: 0,
      outPoint: 10,
      transform: defaultTransform(),
      opacity: staticProp(1),
      components: [],
      effects: [{ id: "FX1", type: "fastWave", enabled: true, props: { amplitude: 10 } }],
    };
    expect(compHasDisplacementEffect(makeComp([waveObj]))).toBe(true);
    expect(compNeedsAutoPreviewCache(makeComp([waveObj]))).toBe(true);
    expect(compNeedsAutoPreviewCache(makeComp())).toBe(false);
  });

  it("effectsAreFastDisplacementOnly detects fast* only", () => {
    expect(
      effectsAreFastDisplacementOnly(
        [{ type: "fastWave", enabled: true }],
        false,
      ),
    ).toBe(true);
    expect(
      effectsAreFastDisplacementOnly(
        [
          { type: "fastWave", enabled: true },
          { type: "wave", enabled: true },
        ],
        false,
      ),
    ).toBe(false);
    expect(objectHasFastDisplacementOnly([{ type: "fastRipple", enabled: true }], true)).toBe(false);
  });

  it("§27.12 draft fast path is gated to draftPlayback mode (Best keeps default raster)", () => {
    const effects = [{ type: "fastWave", enabled: true }];
    expect(effectsAreFastDisplacementOnly(effects, false)).toBe(true);
    const draftFastPath = (mode: "default" | "draftPlayback") =>
      mode === "draftPlayback" && effectsAreFastDisplacementOnly(effects, false);
    expect(draftFastPath("draftPlayback")).toBe(true);
    expect(draftFastPath("default")).toBe(false);
  });
});

describe("RamPreviewController auto cache session", () => {
  it("prefers cache when auto session active on heavy comp", () => {
    registerBuiltinEffects();
    const obj: SceneObject = {
      id: "O1",
      name: "s",
      parent: null,
      zOrder: 1,
      enabled: true,
      inPoint: 0,
      outPoint: 10,
      transform: defaultTransform(),
      opacity: staticProp(1),
      components: [],
      effects: [{ id: "FX1", type: "wave", enabled: true, props: { amplitude: 10 } }],
    };
    const comp = makeComp([obj]);
    const store = new DefaultTieredCacheStore({
      maxRamBytes: 1024,
      diskEnabled: false,
      disk: new InMemoryDiskCacheTier(),
    });
    const ctrl = new RamPreviewController(store, new MemoryFs(), {
      enabled: true,
      maxRamMB: 256,
      enableDiskCache: false,
    });
    ctrl.updateConfig({
      project: {
        schemaVersion: 1,
        meta: { name: "T", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        assets: [],
        compositions: [comp],
        rootComposition: comp.id,
        pluginRefs: [],
      },
      comp,
      projectRevision: 1,
      quality: "draft",
      proxy: "full",
      proxyScale: 1,
      workArea: { inPoint: 0, outPoint: comp.duration },
    });
    expect(ctrl.shouldPreferCacheDisplay()).toBe(false);
    ctrl.setAutoCacheSession(true);
    expect(ctrl.shouldPreferCacheDisplay()).toBe(true);
  });
});
