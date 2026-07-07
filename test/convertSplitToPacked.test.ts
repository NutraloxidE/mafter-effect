import { describe, expect, it } from "vitest";
import {
  estimatePackedConversionBytes,
  isConvertError,
  MAX_PACKED_CONVERT_BYTES,
  resolveConversionFps,
} from "../src/editor/subjectExtract/convertSplitToPacked";
import type { Project, TimelineComposition } from "../src/core/schema";
import { packedVideoHeight } from "../src/runtime/videoPackedAlpha";

function fakeComp(id: string, fps: number, objects: TimelineComposition["objects"]): TimelineComposition {
  return {
    id,
    kind: "timeline",
    name: id,
    width: 1920,
    height: 1080,
    fps,
    duration: 150,
    objects,
  } as unknown as TimelineComposition;
}

function videoLayer(id: string, assetId: string): TimelineComposition["objects"][number] {
  return {
    id,
    name: id,
    parent: null,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 100,
    transform: {},
    opacity: {},
    components: [{ type: "video", props: { asset: assetId } }],
  } as unknown as TimelineComposition["objects"][number];
}

function fakeProject(compositions: TimelineComposition[]): Project {
  return { compositions, assets: [], bins: [] } as unknown as Project;
}

describe("estimatePackedConversionBytes", () => {
  it("counts both the content-res frames[] and the packed-res frames[] held simultaneously (2026-07-07 Opus 4.8 review: packed-only undercounted the real peak)", () => {
    const contentHeight = 1080;
    const gutterPx = 8;
    const packedHeight = packedVideoHeight(contentHeight, gutterPx);
    const expected = 1 * 1920 * (contentHeight + packedHeight) * 4;
    expect(estimatePackedConversionBytes(1, 1920, contentHeight, gutterPx)).toBe(expected);
  });

  it("scales linearly with frame count", () => {
    const one = estimatePackedConversionBytes(1, 640, 480, 8);
    const ten = estimatePackedConversionBytes(10, 640, 480, 8);
    expect(ten).toBe(one * 10);
  });

  it("stays under the v1 safety limit for a short 640x480 clip", () => {
    // 150 frames (5s@30fps) at 640x480 is a small, everyday Subject Extract clip.
    expect(estimatePackedConversionBytes(150, 640, 480, 8)).toBeLessThan(MAX_PACKED_CONVERT_BYTES);
  });

  it("exceeds the v1 safety limit for a long 1080p clip (documents the known limitation)", () => {
    // ~30s @ 30fps @ 1080p, matching the Opus 4.8 review's OOM-risk example.
    expect(estimatePackedConversionBytes(900, 1920, 1080, 8)).toBeGreaterThan(MAX_PACKED_CONVERT_BYTES);
  });
});

describe("resolveConversionFps", () => {
  it("returns null when no layer references the asset", () => {
    const project = fakeProject([fakeComp("c1", 30, [])]);
    expect(resolveConversionFps(project, "asset-x")).toBeNull();
  });

  it("returns the host comp's fps when exactly one comp references the asset", () => {
    const project = fakeProject([fakeComp("c1", 24, [videoLayer("o1", "asset-x")])]);
    expect(resolveConversionFps(project, "asset-x")).toBe(24);
  });

  it("returns the shared fps when multiple referencing layers/comps agree", () => {
    const project = fakeProject([
      fakeComp("c1", 30, [videoLayer("o1", "asset-x")]),
      fakeComp("c2", 30, [videoLayer("o2", "asset-x")]),
    ]);
    expect(resolveConversionFps(project, "asset-x")).toBe(30);
  });

  it("returns null (ambiguous) when referencing comps disagree on fps rather than guessing", () => {
    const project = fakeProject([
      fakeComp("c1", 30, [videoLayer("o1", "asset-x")]),
      fakeComp("c2", 24, [videoLayer("o2", "asset-x")]),
    ]);
    expect(resolveConversionFps(project, "asset-x")).toBeNull();
  });

  it("ignores layers referencing a different asset", () => {
    const project = fakeProject([fakeComp("c1", 30, [videoLayer("o1", "asset-y")])]);
    expect(resolveConversionFps(project, "asset-x")).toBeNull();
  });
});

describe("isConvertError", () => {
  it("distinguishes the error branch from the success branch", () => {
    expect(isConvertError({ error: "boom" })).toBe(true);
    expect(isConvertError({ asset: {} as never })).toBe(false);
  });
});
