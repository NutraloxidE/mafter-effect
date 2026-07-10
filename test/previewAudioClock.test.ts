// Phase B（doc/issue/static-noise-problem/after-v3-implement-report.md §4）unit tests.
//
// vite.config.ts の test environment は "node"（window/AudioContext 無し）なので、実 decode を行う
// audioBufferCache をモックし、prepareAudioLayers の「収集ロジック」だけを検証する
// （PreviewAudioClock クラス自体の start()/tick() は window.AudioContext 前提のため対象外 — 実機は
// Playwright + Chromium で検証する、という PreviewAudioClock 実装冒頭の方針どおり）。

import { describe, expect, it, vi } from "vitest";
import { defaultTransform, staticProp } from "../src/core/props";
import type { AssetEntry, Component, Project, SceneObject, TimelineComposition } from "../src/core/schema";
import type { FileSystem } from "../src/fs/FileSystem";

const fakeVideoBuffer = { duration: 5 } as unknown as AudioBuffer;
const fakeAudioBuffer = { duration: 3 } as unknown as AudioBuffer;

// assetId -> AudioBuffer|null（null は「音声トラック無し・decode 失敗」を模す）。
const decodeResultByAssetId = new Map<string, unknown>();

vi.mock("../src/editor/audioBufferCache", () => ({
  peekAudioBuffer: vi.fn(() => undefined),
  loadAudioBuffer: vi.fn(async (assetId: string) => decodeResultByAssetId.get(assetId) ?? null),
}));

import { hasPreviewAudioCandidates, mutedVideoObjectIds, prepareAudioLayers } from "../src/editor/previewAudioClock";

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

function fakeFs(): FileSystem {
  return {
    read: vi.fn(async () => new Uint8Array()),
    readText: vi.fn(async () => ""),
    write: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    exists: vi.fn(async () => true),
    delete: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
  };
}

describe("prepareAudioLayers (Phase B — video 内蔵音声を PreviewAudioClock へ取り込む)", () => {
  it("collects an enabled video layer that has embedded audio as componentType video", async () => {
    decodeResultByAssetId.set("clip1", fakeVideoBuffer);
    const p = project([asset("clip1", "assets/clip1.mp4")]);
    const c = comp([obj("v", [{ type: "video", props: { asset: "clip1", trimStart: 0, gain: staticProp(1) } }])]);
    const layers = await prepareAudioLayers(p, c, fakeFs());
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({ objectId: "v", componentType: "video", buffer: fakeVideoBuffer });
  });

  it("skips a video layer whose asset has no audio track (decode returns null) without throwing", async () => {
    decodeResultByAssetId.set("silent1", null);
    const p = project([asset("silent1", "assets/silent1.mp4")]);
    const c = comp([obj("v", [{ type: "video", props: { asset: "silent1" } }])]);
    const layers = await prepareAudioLayers(p, c, fakeFs());
    expect(layers).toHaveLength(0);
  });

  it("leaves standalone audio-only comps unchanged (componentType audio, same fields as before)", async () => {
    decodeResultByAssetId.set("snd1", fakeAudioBuffer);
    const p = project([asset("snd1", "assets/snd1.mp3", "audio")]);
    const c = comp([
      obj("a", [{ type: "audio", props: { asset: "snd1", trimStart: 5, gain: staticProp(0.5), autoFade: true } }], {
        inPoint: 10,
        outPoint: 40,
      }),
    ]);
    const layers = await prepareAudioLayers(p, c, fakeFs());
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({
      objectId: "a",
      componentType: "audio",
      buffer: fakeAudioBuffer,
      inPoint: 10,
      outPoint: 40,
      trimStart: 5,
      autoFade: true,
    });
  });

  it("collects a mix of standalone audio + video-with-audio while skipping video-without-audio", async () => {
    decodeResultByAssetId.set("clip1", fakeVideoBuffer);
    decodeResultByAssetId.set("silent1", null);
    decodeResultByAssetId.set("snd1", fakeAudioBuffer);
    const p = project([
      asset("clip1", "assets/clip1.mp4"),
      asset("silent1", "assets/silent1.mp4"),
      asset("snd1", "assets/snd1.mp3", "audio"),
    ]);
    const c = comp([
      obj("v1", [{ type: "video", props: { asset: "clip1" } }]),
      obj("v2", [{ type: "video", props: { asset: "silent1" } }]),
      obj("a1", [{ type: "audio", props: { asset: "snd1" } }]),
    ]);
    const layers = await prepareAudioLayers(p, c, fakeFs());
    expect(layers.map((l) => l.objectId).sort()).toEqual(["a1", "v1"]);
  });

  it("respects autoFade:false on the video component props", async () => {
    decodeResultByAssetId.set("clip1", fakeVideoBuffer);
    const p = project([asset("clip1", "assets/clip1.mp4")]);
    const c = comp([obj("v", [{ type: "video", props: { asset: "clip1", autoFade: false } }])]);
    const layers = await prepareAudioLayers(p, c, fakeFs());
    expect(layers[0]!.autoFade).toBe(false);
  });

  it("excludes disabled video layers", async () => {
    decodeResultByAssetId.set("clip1", fakeVideoBuffer);
    const p = project([asset("clip1", "assets/clip1.mp4")]);
    const c = comp([obj("v", [{ type: "video", props: { asset: "clip1" } }], { enabled: false })]);
    const layers = await prepareAudioLayers(p, c, fakeFs());
    expect(layers).toHaveLength(0);
  });

  it("excludes layers whose asset is missing from the project", async () => {
    decodeResultByAssetId.set("clip1", fakeVideoBuffer);
    const p = project([]);
    const c = comp([obj("v", [{ type: "video", props: { asset: "clip1" } }])]);
    const layers = await prepareAudioLayers(p, c, fakeFs());
    expect(layers).toHaveLength(0);
  });
});

describe("hasPreviewAudioCandidates", () => {
  it("is true when only a video layer (no standalone audio) is present", () => {
    const c = comp([obj("v", [{ type: "video", props: { asset: "clip1" } }])]);
    expect(hasPreviewAudioCandidates(c)).toBe(true);
  });

  it("is true when only a standalone audio layer is present", () => {
    const c = comp([obj("a", [{ type: "audio", props: { asset: "snd1" } }])]);
    expect(hasPreviewAudioCandidates(c)).toBe(true);
  });

  it("is false when the comp has neither audio nor video layers", () => {
    const c = comp([obj("s", [{ type: "solid", props: {} }])]);
    expect(hasPreviewAudioCandidates(c)).toBe(false);
  });
});

describe("mutedVideoObjectIds (Phase B — persistentlyMutedVideoIds source for PreviewPanel)", () => {
  it("matches exactly the video-componentType layers that prepareAudioLayers actually prepared", async () => {
    decodeResultByAssetId.set("clip1", fakeVideoBuffer);
    decodeResultByAssetId.set("silent1", null);
    decodeResultByAssetId.set("snd1", fakeAudioBuffer);
    const p = project([
      asset("clip1", "assets/clip1.mp4"),
      asset("silent1", "assets/silent1.mp4"),
      asset("snd1", "assets/snd1.mp3", "audio"),
    ]);
    const c = comp([
      obj("v1", [{ type: "video", props: { asset: "clip1" } }]),
      obj("v2", [{ type: "video", props: { asset: "silent1" } }]),
      obj("a1", [{ type: "audio", props: { asset: "snd1" } }]),
    ]);
    const layers = await prepareAudioLayers(p, c, fakeFs());
    const ids = mutedVideoObjectIds(layers);
    expect(ids).toEqual(new Set(["v1"])); // v2 は decode 失敗でスキップ済み、a1 は audio なので含まない
  });

  it("is empty for a standalone-audio-only comp", async () => {
    decodeResultByAssetId.set("snd1", fakeAudioBuffer);
    const p = project([asset("snd1", "assets/snd1.mp3", "audio")]);
    const c = comp([obj("a1", [{ type: "audio", props: { asset: "snd1" } }])]);
    const layers = await prepareAudioLayers(p, c, fakeFs());
    expect(mutedVideoObjectIds(layers).size).toBe(0);
  });
});
