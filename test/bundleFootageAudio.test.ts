import { describe, expect, it } from "vitest";
import { defaultTransform, staticProp } from "../src/core/props";
import type { AssetEntry, Component, Project, SceneObject, TimelineComposition } from "../src/core/schema";
import {
  clampFadeWindowToLoopRange,
  collectBundleFootageAudioSources,
  footageAudioMediaTimeSec,
  hasBundleFootageAudio,
} from "../src/player/bundleFootageAudio";

function obj(id: string, components: Component[], opts?: { enabled?: boolean; inPoint?: number; outPoint?: number }): SceneObject {
  return {
    id,
    name: id,
    parent: null,
    zOrder: 1,
    enabled: opts?.enabled ?? true,
    inPoint: opts?.inPoint ?? 0,
    outPoint: opts?.outPoint ?? 100,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components,
  };
}

function comp(objects: SceneObject[]): TimelineComposition {
  return {
    id: "c0",
    name: "c0",
    kind: "timeline",
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 100,
    objects,
  };
}

function asset(id: string, path: string, kind: AssetEntry["kind"] = "video"): AssetEntry {
  return { id, path, kind };
}

function project(assets: AssetEntry[]): Project {
  return {
    schemaVersion: 1,
    meta: { name: "p", createdAt: "", updatedAt: "" },
    rootComposition: "c0",
    compositions: [],
    pluginRefs: [],
    assets,
  };
}

describe("collectBundleFootageAudioSources (fix-plan-v2plus Phase 1)", () => {
  it("collects a video-only layer as a bundle audio source with componentType video", () => {
    const p = project([asset("clip1", "assets/clip1.mp4")]);
    const c = comp([obj("v", [{ type: "video", props: { asset: "clip1", trimStart: 0, gain: staticProp(1) } }])]);
    const sources = collectBundleFootageAudioSources(p, c);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      objectId: "v",
      assetPath: "assets/clip1.mp4",
      componentType: "video",
      autoFade: true,
    });
  });

  it("collects a standalone audio-only layer as componentType audio", () => {
    const p = project([asset("snd1", "assets/snd1.mp3", "audio")]);
    const c = comp([obj("a", [{ type: "audio", props: { asset: "snd1", gain: staticProp(1) } }])]);
    const sources = collectBundleFootageAudioSources(p, c);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ objectId: "a", componentType: "audio" });
  });

  it("collects a mix of video and audio layers together", () => {
    const p = project([asset("clip1", "assets/clip1.mp4"), asset("snd1", "assets/snd1.mp3", "audio")]);
    const c = comp([
      obj("v", [{ type: "video", props: { asset: "clip1" } }]),
      obj("a", [{ type: "audio", props: { asset: "snd1" } }]),
    ]);
    const sources = collectBundleFootageAudioSources(p, c);
    expect(sources.map((s) => s.componentType).sort()).toEqual(["audio", "video"]);
  });

  it("carries trimStart through for video layers", () => {
    const p = project([asset("clip1", "assets/clip1.mp4")]);
    const c = comp([obj("v", [{ type: "video", props: { asset: "clip1", trimStart: 12 } }])]);
    const sources = collectBundleFootageAudioSources(p, c);
    expect(sources[0]!.trimStart).toBe(12);
  });

  it("excludes disabled layers", () => {
    const p = project([asset("clip1", "assets/clip1.mp4")]);
    const c = comp([obj("v", [{ type: "video", props: { asset: "clip1" } }], { enabled: false })]);
    expect(collectBundleFootageAudioSources(p, c)).toHaveLength(0);
  });

  it("excludes layers whose asset is missing from the project", () => {
    const p = project([]);
    const c = comp([obj("v", [{ type: "video", props: { asset: "missing" } }])]);
    expect(collectBundleFootageAudioSources(p, c)).toHaveLength(0);
  });

  it("respects autoFade:false on the component props", () => {
    const p = project([asset("clip1", "assets/clip1.mp4")]);
    const c = comp([obj("v", [{ type: "video", props: { asset: "clip1", autoFade: false } }])]);
    expect(collectBundleFootageAudioSources(p, c)[0]!.autoFade).toBe(false);
  });
});

describe("hasBundleFootageAudio", () => {
  it("is true when only a video layer with audio is present (unlike hasAudioLayers, which is audio-only)", () => {
    const p = project([asset("clip1", "assets/clip1.mp4")]);
    const c = comp([obj("v", [{ type: "video", props: { asset: "clip1" } }])]);
    expect(hasBundleFootageAudio(p, c)).toBe(true);
  });

  it("is false when the comp has no audio or video layers", () => {
    const p = project([]);
    const c = comp([obj("s", [{ type: "solid", props: {} }])]);
    expect(hasBundleFootageAudio(p, c)).toBe(false);
  });
});

describe("footageAudioMediaTimeSec (fix-plan-v2plus Phase 2 time mapping)", () => {
  it("maps transportFrame directly to seconds when inPoint and trimStart are both 0", () => {
    expect(footageAudioMediaTimeSec(0, 0, 0, 30)).toBe(0);
    expect(footageAudioMediaTimeSec(90, 0, 0, 30)).toBeCloseTo(3, 6);
  });

  it("offsets by trimStart (frames) when the layer starts mid-source", () => {
    // trimStart=15 frames @30fps = 0.5s into the source when transportFrame == inPoint.
    expect(footageAudioMediaTimeSec(0, 0, 15, 30)).toBeCloseTo(0.5, 6);
  });

  it("subtracts inPoint so the media clock starts at trimStart when the layer becomes active", () => {
    // layer becomes active at comp frame 30 (inPoint=30); at that instant media time == trimStart.
    expect(footageAudioMediaTimeSec(30, 30, 12, 30)).toBeCloseTo(12 / 30, 6);
    // 15 frames later, media time has advanced by the same 15 frames.
    expect(footageAudioMediaTimeSec(45, 30, 12, 30)).toBeCloseTo((12 + 15) / 30, 6);
  });

  it("clamps to zero instead of returning a negative media time", () => {
    // transportFrame before inPoint would be negative without clamping.
    expect(footageAudioMediaTimeSec(0, 30, 0, 30)).toBe(0);
  });

  it("accepts fractional transportFrame (e.g. derived from wall-clock elapsed seconds)", () => {
    expect(footageAudioMediaTimeSec(15.5, 0, 0, 30)).toBeCloseTo(15.5 / 30, 6);
  });
});

describe("clampFadeWindowToLoopRange (fix-plan-v2plus — seam declick for mid-file-cut loops)", () => {
  it("clamps a source wider than the loop range so the fade window lands on the loop seam", () => {
    // 5s (150-frame) source, but the bundle loops [0,90). Without clamping the out-fade would sit
    // near frame 150 and never touch the actual seam at 90 → residual click.
    const w = clampFadeWindowToLoopRange(0, 150, 0, 90, true);
    expect(w).toEqual({ inPoint: 0, outPoint: 90 });
  });

  it("is a no-op when the source range fits inside the loop range (normal case)", () => {
    const w = clampFadeWindowToLoopRange(10, 80, 0, 90, true);
    expect(w).toEqual({ inPoint: 10, outPoint: 80 });
  });

  it("does not clamp when loop is disabled (avoid fading before the real source end)", () => {
    const w = clampFadeWindowToLoopRange(0, 150, 0, 90, false);
    expect(w).toEqual({ inPoint: 0, outPoint: 150 });
  });

  it("clamps a layer starting before the loop range up to the range start", () => {
    const w = clampFadeWindowToLoopRange(-30, 200, 0, 90, true);
    expect(w).toEqual({ inPoint: 0, outPoint: 90 });
  });
});
