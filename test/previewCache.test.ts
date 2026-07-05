import { RamPreviewController } from "../src/editor/ramPreview";
import { MemoryFs } from "../src/fs/MemoryFs";
import { describe, expect, it, vi } from "vitest";
import { buildCompFrameCacheKey, compFrameCachePrefix, parseCompFrameFromKey } from "../src/cache/compFrameKey";
import { FrameCacheQueue } from "../src/cache/frameCacheQueue";
import { MemoryCacheTier } from "../src/cache/memoryCacheTier";
import { DefaultTieredCacheStore } from "../src/cache/tieredCacheStore";
import { InMemoryDiskCacheTier } from "../src/fs/PreviewCacheDb";
import {
  loadPreviewCacheSettings,
  DEFAULT_PREVIEW_CACHE_SETTINGS,
} from "../src/editor/previewCacheSettings";
import { RealtimeDetector, shouldForceNonRealtime } from "../src/editor/realtimeDetector";
import { compRequiresPreviewBake } from "../src/editor/previewCompAnalysis";
import { registerBuiltinEffects } from "../src/runtime/builtinEffects";
import { defaultTransform, staticProp } from "../src/core/props";
import type { Project, SceneObject, TimelineComposition } from "../src/core/schema";

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

function makeRamConfig(comp: TimelineComposition) {
  const project: Project = {
    schemaVersion: 1,
    meta: { name: "Test", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    assets: [],
    compositions: [comp],
    rootComposition: comp.id,
    pluginRefs: [],
  };
  return {
    project,
    comp,
    projectRevision: 1,
    quality: "draft" as const,
    proxy: "full" as const,
    proxyScale: 1,
    workArea: { inPoint: 0, outPoint: comp.duration },
  };
}

describe("compFrameCacheKey", () => {
  it("builds deterministic keys", () => {
    const key = buildCompFrameCacheKey({
      compId: "C1",
      frame: 5,
      projectRevision: 3,
      quality: "draft",
      proxy: "full",
      width: 1920,
      height: 1080,
    });
    expect(key).toBe("comp:C1:f5:rev3:qdraft:proxyfull:w1920:h1080");
    expect(compFrameCachePrefix("C1")).toBe("comp:C1:");
  });
});

describe("MemoryCacheTier", () => {
  it("tracks LRU order for eviction", () => {
    const tier = new MemoryCacheTier(10);
    const meta = { byteSize: 6, width: 1, height: 1, format: "png" as const };
    tier.put("a", new Uint8Array(6), meta);
    tier.put("b", new Uint8Array(6), meta);
    const evicted = tier.evictKey(tier.lruKeys()[0]!);
    expect(evicted?.data.byteLength).toBe(6);
    expect(tier.get("a")).toBeNull();
    expect(tier.get("b")?.byteLength).toBe(6);
  });
});

describe("DefaultTieredCacheStore", () => {
  it("spills to disk tier on memory pressure", async () => {
    const disk = new InMemoryDiskCacheTier();
    const store = new DefaultTieredCacheStore({
      maxRamBytes: 12,
      diskEnabled: true,
      disk,
    });
    const meta = { byteSize: 8, width: 2, height: 2, format: "png" as const };
    await store.put("k1", new Uint8Array(8), meta);
    await store.put("k2", new Uint8Array(8), meta);
    const v1 = await store.get("k1");
    expect(v1?.byteLength).toBe(8);
    const stats = await store.stats();
    expect(stats.entryCount).toBeGreaterThanOrEqual(2);
  });

  it("clears by prefix", async () => {
    const disk = new InMemoryDiskCacheTier();
    const store = new DefaultTieredCacheStore({
      maxRamBytes: 1024,
      diskEnabled: true,
      disk,
    });
    const meta = { byteSize: 4, width: 1, height: 1, format: "png" as const };
    await store.put("comp:A:f0", new Uint8Array(4), meta);
    await store.put("comp:B:f0", new Uint8Array(4), meta);
    await store.clear("comp:A:");
    expect(await store.get("comp:A:f0")).toBeNull();
    expect(await store.get("comp:B:f0")).not.toBeNull();
  });
});

describe("RealtimeDetector", () => {
  it("detects realtime when median render time is under budget", () => {
    const d = new RealtimeDetector();
    for (let i = 0; i < 3; i++) d.recordRenderMs(5);
    expect(d.isRealtimeCapable(30)).toBe(true);
    for (let i = 0; i < 8; i++) d.recordRenderMs(100);
    expect(d.isRealtimeCapable(30)).toBe(false);
  });
});

describe("shouldForceNonRealtime", () => {
  it("forces non-realtime when raster effects are present", () => {
    const comp = makeComp();
    expect(shouldForceNonRealtime("draft", "full", comp)).toBe(false);
    registerBuiltinEffects();
    const obj: SceneObject = {
      id: "O1",
      name: "solid",
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
    expect(shouldForceNonRealtime("draft", "full", makeComp([obj]))).toBe(true);
  });

  it("forces non-realtime for non-full proxy", () => {
    expect(shouldForceNonRealtime("draft", "half", makeComp())).toBe(true);
  });
});

describe("previewCacheSettings", () => {
  it("has sane defaults", () => {
    expect(DEFAULT_PREVIEW_CACHE_SETTINGS.enabled).toBe(false);
    expect(loadPreviewCacheSettings().maxRamMB).toBeGreaterThan(0);
  });
});

describe("comp preview bake", () => {
  it("compRequiresPreviewBake is true for pixelSorter only among builtins", () => {
    registerBuiltinEffects();

    const bakeObj: SceneObject = {
      id: "O1",
      name: "solid",
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
    const blurObj: SceneObject = {
      ...bakeObj,
      id: "O2",
      effects: [{ id: "FX2", type: "blur", enabled: true, props: { blurriness: 4 } }],
    };
    expect(compRequiresPreviewBake(makeComp([bakeObj]))).toBe(true);
    expect(compRequiresPreviewBake(makeComp([blurObj]))).toBe(false);
    expect(shouldForceNonRealtime("draft", "full", makeComp([bakeObj]))).toBe(true);
    expect(shouldForceNonRealtime("draft", "full", makeComp([blurObj]))).toBe(false);
  });
});

describe("parseCompFrameFromKey", () => {
  it("extracts frame from comp cache keys", () => {
    const key = buildCompFrameCacheKey({
      compId: "C1",
      frame: 42,
      projectRevision: 1,
      quality: "draft",
      proxy: "full",
      width: 100,
      height: 100,
    });
    expect(parseCompFrameFromKey(key)).toBe(42);
    expect(parseCompFrameFromKey("layer:O1:f0:hashabc")).toBeNull();
  });
});

describe("listKeys", () => {
  it("lists keys by prefix across tiers", async () => {
    const disk = new InMemoryDiskCacheTier();
    const store = new DefaultTieredCacheStore({
      maxRamBytes: 1024,
      diskEnabled: true,
      disk,
    });
    const meta = { byteSize: 4, width: 1, height: 1, format: "png" as const };
    await store.put("comp:A:f0:rev1", new Uint8Array(4), meta);
    await store.put("comp:A:f1:rev1", new Uint8Array(4), meta);
    await store.put("comp:B:f0:rev1", new Uint8Array(4), meta);
    const keys = await store.listKeys("comp:A:");
    expect(keys.sort()).toEqual(["comp:A:f0:rev1", "comp:A:f1:rev1"]);
  });
});

describe("layerFrameCacheKey", () => {
  it("builds deterministic layer keys", async () => {
    const { buildLayerFrameCacheKey, layerFrameCachePrefix } = await import("../src/cache/layerFrameKey");
    expect(buildLayerFrameCacheKey({ objectId: "O1", frame: 3, propsHash: "abc" }))
      .toBe("layer:O1:f3:hashabc");
    expect(layerFrameCachePrefix("O1")).toBe("layer:O1:");
  });
});

describe("shouldPreferCacheDisplay", () => {
  it("returns false when controller has no config", () => {
    const store = new DefaultTieredCacheStore({ maxRamBytes: 1024, diskEnabled: true, disk: new InMemoryDiskCacheTier() });
    const ctrl = new RamPreviewController(store, new MemoryFs(), { enabled: true, maxRamMB: 256, enableDiskCache: true });
    expect(ctrl.shouldPreferCacheDisplay()).toBe(false);
    expect(ctrl.shouldUseCacheForPlayback()).toBe(false);
  });
});

describe("FrameCacheQueue pause", () => {
  it("stops taking jobs while paused and resumes after", async () => {
    const q = new FrameCacheQueue();
    const processed: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    q.enqueueRange(0, 5, "background");
    q.pump(async (frame) => {
      processed.push(frame);
      if (processed.length === 1) await gate;
    });

    await vi.waitFor(() => expect(processed.length).toBe(1));
    q.setPaused(true);
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(processed.length).toBe(1);
    expect(q.pendingCount()).toBe(4);

    q.setPaused(false);
    q.pump(async (frame) => {
      processed.push(frame);
    });
    await vi.waitFor(() => expect(processed.length).toBe(5));
    expect(q.pendingCount()).toBe(0);
  });
});

function makeBakeComp(): TimelineComposition {
  registerBuiltinEffects();
  const obj: SceneObject = {
    id: "O1",
    name: "solid",
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
  return makeComp([obj]);
}

describe("RamPreviewController playback bake pause (§28.4)", () => {
  it("defers background build while playback is active and starts on stop", () => {
    const comp = makeBakeComp();
    const store = new DefaultTieredCacheStore({
      maxRamBytes: 1024,
      diskEnabled: false,
      disk: new InMemoryDiskCacheTier(),
    });
    const settings = { enabled: true, maxRamMB: 256, enableDiskCache: false };
    const ctrl = new RamPreviewController(store, new MemoryFs(), settings);
    ctrl.updateConfig(makeRamConfig(comp));

    ctrl.setPlaybackActive(true);
    ctrl.startBackgroundBuildIfNeeded();
    expect(ctrl.isPlaybackActive()).toBe(true);
    expect(ctrl.isWorkAreaBuildComplete()).toBe(false);
    expect(ctrl.getDisplayStatus(true).kind).toBe("idle");

    ctrl.setPlaybackActive(false);
    expect(ctrl.isPlaybackActive()).toBe(false);
    expect(ctrl.getDisplayStatus(false).kind).toBe("building");
  });

  it("prefers overlay during play only after work-area build completes", async () => {
    const comp = makeBakeComp();
    const store = new DefaultTieredCacheStore({
      maxRamBytes: 1024 * 1024,
      diskEnabled: false,
      disk: new InMemoryDiskCacheTier(),
    });
    const settings = { enabled: true, maxRamMB: 256, enableDiskCache: false };
    const ctrl = new RamPreviewController(store, new MemoryFs(), settings);
    ctrl.updateConfig(makeRamConfig(comp));

    expect(ctrl.shouldPreferCacheOverlay(true)).toBe(false);
    expect(ctrl.shouldPreferCacheOverlay(false)).toBe(true);

    const meta = { byteSize: 4, width: 1, height: 1, format: "png" as const };
    for (let f = 0; f < comp.duration; f++) {
      const key = ctrl.frameCacheKey(f);
      expect(key).not.toBeNull();
      await store.put(key!, new Uint8Array(4), meta);
    }

    ctrl.startBackgroundBuildIfNeeded();
    await vi.waitFor(() => expect(ctrl.isWorkAreaBuildComplete()).toBe(true));
    expect(ctrl.shouldPreferCacheOverlay(true)).toBe(true);
    expect(ctrl.shouldPreferCacheOverlay(false)).toBe(true);
  });

  it("does not enqueue scrub/playback frames while playback is active", () => {
    const comp = makeBakeComp();
    const store = new DefaultTieredCacheStore({
      maxRamBytes: 1024 * 1024,
      diskEnabled: false,
      disk: new InMemoryDiskCacheTier(),
    });
    const settings = { enabled: true, maxRamMB: 256, enableDiskCache: false };
    const ctrl = new RamPreviewController(store, new MemoryFs(), settings);
    ctrl.updateConfig(makeRamConfig(comp));

    ctrl.setPlaybackActive(true);
    ctrl.cacheScrubbedFrame(0);
    ctrl.cachePlaybackFrame(1);
    // enqueue は no-op。build も未開始。
    expect(ctrl.getDisplayStatus(true).kind).toBe("idle");

    // 停止時に未完了なら build を開始する。
    ctrl.setPlaybackActive(false);
    expect(ctrl.getDisplayStatus(false).kind).toBe("building");
  });
});

describe("RamPreviewController enabled toggle", () => {
  it("skips cache when disabled", () => {
    registerBuiltinEffects();
    const obj: SceneObject = {
      id: "O1",
      name: "solid",
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
    const comp = makeComp([obj]);
    const store = new DefaultTieredCacheStore({ maxRamBytes: 1024, diskEnabled: false, disk: new InMemoryDiskCacheTier() });
    const settings = { enabled: false, maxRamMB: 256, enableDiskCache: false };
    const ctrl = new RamPreviewController(store, new MemoryFs(), settings);
    ctrl.updateConfig(makeRamConfig(comp));
    expect(ctrl.shouldPreferCacheDisplay()).toBe(false);
    expect(ctrl.getDisplayStatus(false)).toEqual({ kind: "off" });
    ctrl.cacheScrubbedFrame(0);
    ctrl.startBackgroundBuildIfNeeded();
    expect(ctrl.getDisplayStatus(false)).toEqual({ kind: "off" });
  });

  it("aborts background build when disabled via updateSettings", () => {
    registerBuiltinEffects();
    const obj: SceneObject = {
      id: "O1",
      name: "solid",
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
    const comp = makeComp([obj]);
    const store = new DefaultTieredCacheStore({ maxRamBytes: 1024, diskEnabled: false, disk: new InMemoryDiskCacheTier() });
    const settings = { enabled: true, maxRamMB: 256, enableDiskCache: false };
    const ctrl = new RamPreviewController(store, new MemoryFs(), settings);
    ctrl.updateConfig(makeRamConfig(comp));
    ctrl.startBackgroundBuildIfNeeded();
    expect(ctrl.getDisplayStatus(false).kind).toBe("building");
    ctrl.updateSettings({ ...settings, enabled: false });
    expect(ctrl.getDisplayStatus(false)).toEqual({ kind: "off" });
  });
});

describe("workAreaStorage", () => {
  it("defaults to full comp duration", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
      clear: () => { storage.clear(); },
    });
    const { loadWorkArea, saveWorkArea } = await import("../src/editor/workAreaStorage");
    saveWorkArea("WA1", { inPoint: 5, outPoint: 20 });
    expect(loadWorkArea("WA1", 30)).toEqual({ inPoint: 5, outPoint: 20 });
    expect(loadWorkArea("NEW", 100)).toEqual({ inPoint: 0, outPoint: 100 });
    vi.unstubAllGlobals();
  });
});
