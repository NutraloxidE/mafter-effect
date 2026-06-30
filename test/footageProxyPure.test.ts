import { describe, expect, it } from "vitest";
import { fitProxyDimensions } from "../src/runtime/webcodecsVideoEncode";
import {
  chooseProxyFps,
  resampleFrameIndices,
} from "../src/runtime/animatedRasterProxy";
import {
  isAnimatedRasterCandidate,
  shouldTreatAsAnimatedRaster,
  type AnimatedRasterInfo,
} from "../src/runtime/animatedRasterDetect";
import { collectExportProxyJobs } from "../src/runtime/footagePlayback";
import { collectProxyPaths, normalizeProjectForZip } from "../src/fs/zip";
import { collectBundleDependencies } from "../src/runtime/bundleCollect";
import type { AssetEntry, Project, SceneObject, TimelineComposition } from "../src/core/schema";
import { defaultTransform, staticProp } from "../src/core/props";

describe("fitProxyDimensions", () => {
  it("scales down to maxDim preserving aspect, even dims, never upscales", () => {
    expect(fitProxyDimensions(1920, 1080, 960)).toEqual({ width: 960, height: 540 });
    expect(fitProxyDimensions(400, 300, 960)).toEqual({ width: 400, height: 300 }); // no upscale
    const r = fitProxyDimensions(1001, 999, 500);
    expect(r.width % 2).toBe(0);
    expect(r.height % 2).toBe(0);
  });
});

describe("animated raster detection (pure)", () => {
  it("isAnimatedRasterCandidate matches webp/gif by name or mime", () => {
    expect(isAnimatedRasterCandidate("a.webp")).toBe(true);
    expect(isAnimatedRasterCandidate("A.GIF")).toBe(true);
    expect(isAnimatedRasterCandidate("image/webp")).toBe(true);
    expect(isAnimatedRasterCandidate("a.png")).toBe(false);
    expect(isAnimatedRasterCandidate("video/mp4")).toBe(false);
  });
  it("shouldTreatAsAnimatedRaster requires animated && >1 frame", () => {
    expect(shouldTreatAsAnimatedRaster(10, true)).toBe(true);
    expect(shouldTreatAsAnimatedRaster(1, true)).toBe(false);
    expect(shouldTreatAsAnimatedRaster(10, false)).toBe(false);
  });
});

describe("resampling", () => {
  const info: AnimatedRasterInfo = {
    frameCount: 3,
    durationSec: 1,
    width: 100,
    height: 100,
    frameDurationsSec: [0.5, 0.25, 0.25],
  };
  it("chooseProxyFps from avg fps clamped 1..30", () => {
    expect(chooseProxyFps(info)).toBe(3);
    expect(chooseProxyFps({ ...info, durationSec: 0 })).toBe(12);
  });
  it("resampleFrameIndices maps even-spaced output frames to source by cumulative time", () => {
    // 4 output frames over 1s: sample times 0.125,0.375,0.625,0.875
    // source ends: 0.5,0.75,1.0 → indices 0,0,1,2
    expect(resampleFrameIndices(info.frameDurationsSec, 4, 4)).toEqual([0, 0, 1, 2]);
  });
});

function videoObj(id: string, assetId: string, quality?: string): SceneObject {
  return {
    id, name: id, parent: null, zOrder: 1, enabled: true, inPoint: 0, outPoint: 100,
    transform: defaultTransform(), opacity: staticProp(1),
    components: [{ type: "video", props: { asset: assetId, ...(quality ? { footageQuality: quality } : {}) } }],
  };
}

function makeProject(assets: AssetEntry[], objects: SceneObject[]): Project {
  const comp: TimelineComposition = {
    id: "c0", name: "c0", kind: "timeline", rootObjectIds: [], objects,
    fps: 30, duration: 100, width: 640, height: 480,
  } as unknown as TimelineComposition;
  return {
    schemaVersion: 1, rootComposition: "c0",
    meta: { name: "p", createdAt: "", updatedAt: "" },
    assets, compositions: [comp], pluginRefs: [],
  } as unknown as Project;
}

const nativeAsset: AssetEntry = {
  id: "a-native", path: "assets/a-native.mp4", kind: "video",
  meta: { footageKind: "native", mime: "video/mp4", proxies: { medium: { path: "assets/a-native.medium.webm" } } },
};
const rasterAsset: AssetEntry = {
  id: "a-raster", path: "assets/a-raster.medium.webm", kind: "video",
  meta: { footageKind: "animated-raster", originalPath: "assets/a-raster.webp", proxies: { medium: { path: "assets/a-raster.medium.webm" } } },
};

describe("collectExportProxyJobs", () => {
  it("collects only proxy-tier video layers, deduped", () => {
    const p = makeProject([nativeAsset], [
      videoObj("o1", "a-native", "medium"),
      videoObj("o2", "a-native", "medium"), // dup
      videoObj("o3", "a-native", "original"), // not a proxy
      videoObj("o4", "a-native"), // default original
    ]);
    expect(collectExportProxyJobs(p)).toEqual([{ assetId: "a-native", quality: "medium" }]);
  });
});

describe("zip normalization", () => {
  it("collectProxyPaths gathers every proxy path", () => {
    const p = makeProject([nativeAsset, rasterAsset], []);
    expect(collectProxyPaths(p)).toEqual(new Set(["assets/a-native.medium.webm", "assets/a-raster.medium.webm"]));
  });
  it("normalizeProjectForZip restores original path and drops proxies/originalPath", () => {
    const p = makeProject([nativeAsset, rasterAsset], []);
    const n = normalizeProjectForZip(p);
    const native = n.assets.find((a) => a.id === "a-native")!;
    const raster = n.assets.find((a) => a.id === "a-raster")!;
    expect(native.path).toBe("assets/a-native.mp4"); // native unchanged
    expect(native.meta?.proxies).toBeUndefined();
    expect(raster.path).toBe("assets/a-raster.webp"); // raster restored to original
    expect(raster.meta?.proxies).toBeUndefined();
    expect(raster.meta?.originalPath).toBeUndefined();
    expect(raster.meta?.footageKind).toBe("animated-raster"); // kept for re-import regen
  });
});

describe("bundleCollect video path selection", () => {
  it("bundles proxy video path + original audio for proxy-tier native layer", () => {
    const p = makeProject([nativeAsset], [videoObj("o1", "a-native", "medium")]);
    const deps = collectBundleDependencies(p, "c0");
    expect(deps.binaryPaths.has("assets/a-native.medium.webm")).toBe(true); // proxy video
    expect(deps.binaryPaths.has("assets/a-native.mp4")).toBe(true); // original audio
  });
  it("bundles original video for original-tier layer", () => {
    const p = makeProject([nativeAsset], [videoObj("o1", "a-native", "original")]);
    const deps = collectBundleDependencies(p, "c0");
    expect(deps.binaryPaths.has("assets/a-native.mp4")).toBe(true);
    expect(deps.binaryPaths.has("assets/a-native.medium.webm")).toBe(false);
  });
});
