import { describe, expect, it } from "vitest";
import { registerBuiltinEffects } from "../src/runtime/builtinEffects";
import { defaultTransform, staticProp } from "../src/core/props";
import type { SceneObject, TimelineComposition } from "../src/core/schema";
import {
  compHasDisplacementEffect,
  compHasFullDisplacementEffect,
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

  it("compNeedsAutoPreviewCache: fast-only は live なので対象外、full displacement は対象（§27.12 改定3）", () => {
    const fastObj: SceneObject = {
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
    const waveObj: SceneObject = {
      ...fastObj,
      effects: [{ id: "FX2", type: "wave", enabled: true, props: { amplitude: 10 } }],
    };
    // fast* も "displacement 系" ではある（full+fast）が…
    expect(compHasDisplacementEffect(makeComp([fastObj]))).toBe(true);
    // …full displacement のみ Auto Cache を起動する。
    expect(compHasFullDisplacementEffect(makeComp([fastObj]))).toBe(false);
    expect(compHasFullDisplacementEffect(makeComp([waveObj]))).toBe(true);
    expect(compNeedsAutoPreviewCache(makeComp([fastObj]))).toBe(false);
    expect(compNeedsAutoPreviewCache(makeComp([waveObj]))).toBe(true);
    const opticsObj: SceneObject = {
      ...fastObj,
      effects: [{ id: "FX3", type: "opticsCompensation", enabled: true, props: { fieldOfView: 50 } }],
    };
    expect(compHasFullDisplacementEffect(makeComp([opticsObj]))).toBe(false);
    expect(compNeedsAutoPreviewCache(makeComp([opticsObj]))).toBe(false);
    expect(compNeedsAutoPreviewCache(makeComp())).toBe(false);
  });

  it("effectsAreFastDisplacementOnly detects fast* displacement only", () => {
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
          { type: "blur", enabled: true, props: { radius: 2 } } as { type: string; enabled: boolean },
        ],
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
