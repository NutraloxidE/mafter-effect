import { describe, expect, it } from "vitest";
import {
  DEFAULT_FOOTAGE_QUALITY,
  FOOTAGE_QUALITY_TIERS,
  PACKED_SAME_AS_EXPORT,
  PROXY_TIER_PARAMS,
  QUALITY_UI_GROUPS,
  effectivePackedQuality,
  footageQualityLabel,
  isPackedSameAsExport,
  isProxyTier,
  normalizeFootageQuality,
  normalizePackedPreviewSelection,
  type ProxyTier,
} from "../src/runtime/footageQuality";
import {
  collectExportProxyJobs,
  footageKindOf,
  getProxyEntry,
  resolveFootageAudioPath,
  resolveFootageVideoPath,
  resolveOriginalPath,
  type FootagePathAsset,
} from "../src/runtime/footagePlayback";
import type { Project } from "../src/core/schema";

describe("footageQuality module", () => {
  it("isProxyTier: original is not a proxy, all others are", () => {
    expect(isProxyTier("original")).toBe(false);
    for (const t of FOOTAGE_QUALITY_TIERS.filter((t) => t !== "original")) {
      expect(isProxyTier(t)).toBe(true);
      expect(PROXY_TIER_PARAMS[t as ProxyTier]).toBeDefined();
    }
  });

  it("normalizeFootageQuality falls back to default for unknown/missing", () => {
    expect(normalizeFootageQuality("medium")).toBe("medium");
    expect(normalizeFootageQuality(undefined)).toBe(DEFAULT_FOOTAGE_QUALITY);
    expect(normalizeFootageQuality("nope")).toBe(DEFAULT_FOOTAGE_QUALITY);
    expect(normalizeFootageQuality(3)).toBe(DEFAULT_FOOTAGE_QUALITY);
  });

  it("UI groups cover every tier exactly once", () => {
    const grouped = QUALITY_UI_GROUPS.flatMap((g) => g.tiers);
    expect([...grouped].sort()).toEqual([...FOOTAGE_QUALITY_TIERS].sort());
    for (const t of FOOTAGE_QUALITY_TIERS) {
      expect(footageQualityLabel(t)).toBeTruthy();
    }
  });

  it("proxy maxDim decreases monotonically across editing→performance tiers", () => {
    const order: ProxyTier[] = ["high", "medium", "low", "super_low", "potato", "garbage"];
    for (let i = 1; i < order.length; i++) {
      const cur = order[i]!;
      const prev = order[i - 1]!;
      expect(PROXY_TIER_PARAMS[cur].maxDim).toBeLessThan(PROXY_TIER_PARAMS[prev].maxDim);
    }
  });
});

describe("effectivePackedQuality (§16.2b decode-bound proxy)", () => {
  it("exportStep defaults to original when no exportQuality is given (INV-2 / back-compat)", () => {
    expect(effectivePackedQuality("original", { exportStep: true })).toBe("original");
    expect(effectivePackedQuality("medium", { exportStep: true })).toBe("original");
    expect(effectivePackedQuality("garbage", { exportStep: true })).toBe("original");
  });

  it("exportStep honors an explicit exportQuality (packed Export Quality control), independent of preview quality", () => {
    expect(effectivePackedQuality("garbage", { exportStep: true, exportQuality: "medium" })).toBe("medium");
    expect(effectivePackedQuality("original", { exportStep: true, exportQuality: "low" })).toBe("low");
    expect(effectivePackedQuality("high", { exportStep: true, exportQuality: "original" })).toBe("original");
  });

  it("preview/bundle live: user-selected proxy tier is honored as-is", () => {
    expect(effectivePackedQuality("high", {})).toBe("high");
    expect(effectivePackedQuality("potato", { exportStep: false })).toBe("potato");
  });

  it("preview/bundle live: default 'original' is swapped for the packed default proxy tier", () => {
    const tier = effectivePackedQuality("original", { exportStep: false });
    expect(tier).not.toBe("original");
    expect(isProxyTier(tier)).toBe(true);
  });

  it("preview/bundle live ignores exportQuality entirely for a concrete preview tier", () => {
    expect(effectivePackedQuality("high", { exportStep: false, exportQuality: "garbage" })).toBe("high");
  });
});

describe("PACKED_SAME_AS_EXPORT (Preview Quality → Export Quality link, §16.2b)", () => {
  it("normalizePackedPreviewSelection recognizes the sentinel and normal tiers", () => {
    expect(normalizePackedPreviewSelection(PACKED_SAME_AS_EXPORT)).toBe(PACKED_SAME_AS_EXPORT);
    expect(normalizePackedPreviewSelection("medium")).toBe("medium");
    expect(normalizePackedPreviewSelection(undefined)).toBe("original");
    expect(normalizePackedPreviewSelection("nonsense")).toBe("original");
  });

  it("isPackedSameAsExport is a precise type guard", () => {
    expect(isPackedSameAsExport(PACKED_SAME_AS_EXPORT)).toBe(true);
    expect(isPackedSameAsExport("original")).toBe(false);
    expect(isPackedSameAsExport(undefined)).toBe(false);
  });

  it("preview/bundle live: same_as_export follows exportQuality exactly, including 'original' (no default-tier substitution)", () => {
    expect(effectivePackedQuality(PACKED_SAME_AS_EXPORT, { exportStep: false, exportQuality: "original" })).toBe("original");
    expect(effectivePackedQuality(PACKED_SAME_AS_EXPORT, { exportStep: false, exportQuality: "medium" })).toBe("medium");
    expect(effectivePackedQuality(PACKED_SAME_AS_EXPORT, { exportStep: false })).toBe("original");
  });

  it("exportStep ignores the preview sentinel entirely (export always resolves from mode.exportQuality)", () => {
    expect(effectivePackedQuality(PACKED_SAME_AS_EXPORT, { exportStep: true, exportQuality: "low" })).toBe("low");
    expect(effectivePackedQuality(PACKED_SAME_AS_EXPORT, { exportStep: true })).toBe("original");
  });
});

describe("collectExportProxyJobs packed alpha handling (§16.2b)", () => {
  function packedProject(footageQuality?: string, packedExportQuality?: string): Project {
    return {
      id: "p1",
      rootComposition: "c1",
      assets: [
        { id: "a1", path: "assets/a1.webm", kind: "video", binId: "b1", meta: { alphaMode: "packed", packedLayout: "topBottom", contentHeight: 100, gutterPx: 8, hasAlpha: true } },
      ],
      compositions: [
        {
          id: "c1",
          kind: "timeline",
          name: "C1",
          fps: 30,
          width: 100,
          height: 100,
          duration: 10,
          objects: [
            {
              id: "o1",
              name: "o1",
              parent: null,
              zOrder: 0,
              enabled: true,
              inPoint: 0,
              outPoint: 10,
              transform: undefined as never,
              opacity: undefined as never,
              components: [
                {
                  type: "video",
                  props: {
                    asset: "a1",
                    ...(footageQuality !== undefined ? { footageQuality } : {}),
                    ...(packedExportQuality !== undefined ? { packedExportQuality } : {}),
                  },
                },
              ],
            },
          ],
        },
      ],
      bins: [],
    } as unknown as Project;
  }

  it("without any includePackedAlpha* option, a packed layer yields no proxy job (mp4/webm/PNG export unaffected)", () => {
    const jobs = collectExportProxyJobs(packedProject());
    expect(jobs).toEqual([]);
  });

  it("with includePackedAlphaPreview, a packed layer at default quality gets the packed default proxy tier queued", () => {
    const jobs = collectExportProxyJobs(packedProject(), { includePackedAlphaPreview: true });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.assetId).toBe("a1");
    expect(isProxyTier(jobs[0]!.quality)).toBe(true);
  });

  it("with includePackedAlphaPreview, an explicit user preview tier on a packed layer is respected", () => {
    const jobs = collectExportProxyJobs(packedProject("high"), { includePackedAlphaPreview: true });
    expect(jobs).toEqual([{ assetId: "a1", quality: "high" }]);
  });

  it("with includePackedAlphaExport, a packed layer at default (original) Export Quality yields no proxy job", () => {
    const jobs = collectExportProxyJobs(packedProject(undefined, undefined), { includePackedAlphaExport: true });
    expect(jobs).toEqual([]);
  });

  it("with includePackedAlphaExport, an explicit packedExportQuality tier is queued regardless of preview quality", () => {
    const jobs = collectExportProxyJobs(packedProject("garbage", "medium"), { includePackedAlphaExport: true });
    expect(jobs).toEqual([{ assetId: "a1", quality: "medium" }]);
  });

  it("with both includePackedAlphaPreview and includePackedAlphaExport, distinct tiers both get queued", () => {
    const jobs = collectExportProxyJobs(packedProject("high", "low"), {
      includePackedAlphaPreview: true,
      includePackedAlphaExport: true,
    });
    expect(jobs).toHaveLength(2);
    expect(jobs).toEqual(
      expect.arrayContaining([
        { assetId: "a1", quality: "high" },
        { assetId: "a1", quality: "low" },
      ]),
    );
  });

  it("with includePackedAlphaPreview, footageQuality='same_as_export' resolves the preview job from packedExportQuality", () => {
    const jobs = collectExportProxyJobs(packedProject("same_as_export", "medium"), {
      includePackedAlphaPreview: true,
    });
    expect(jobs).toEqual([{ assetId: "a1", quality: "medium" }]);
  });

  it("with includePackedAlphaPreview, footageQuality='same_as_export' + default (original) exportQuality yields no proxy job", () => {
    const jobs = collectExportProxyJobs(packedProject("same_as_export"), { includePackedAlphaPreview: true });
    expect(jobs).toEqual([]);
  });
});

describe("footagePlayback resolvers", () => {
  const native: FootagePathAsset = {
    path: "assets/clip.mp4",
    meta: {
      footageKind: "native",
      proxies: { medium: { path: "assets/clip.medium.webm", mime: "video/webm" } },
    },
  };
  const raster: FootagePathAsset = {
    path: "assets/anim.medium.webm",
    meta: {
      footageKind: "animated-raster",
      originalPath: "assets/anim.webp",
      proxies: { medium: { path: "assets/anim.medium.webm" } },
    },
  };
  const bare: FootagePathAsset = { path: "assets/plain.mp4" };

  it("footageKindOf defaults to native when unset", () => {
    expect(footageKindOf(native)).toBe("native");
    expect(footageKindOf(raster)).toBe("animated-raster");
    expect(footageKindOf(bare)).toBe("native");
  });

  it("resolveOriginalPath prefers meta.originalPath, else path", () => {
    expect(resolveOriginalPath(native)).toBe("assets/clip.mp4");
    expect(resolveOriginalPath(raster)).toBe("assets/anim.webp");
    expect(resolveOriginalPath(bare)).toBe("assets/plain.mp4");
  });

  it("video path uses proxy when present, falls back to original otherwise", () => {
    expect(resolveFootageVideoPath(native, "medium")).toBe("assets/clip.medium.webm");
    // no 'low' proxy → fall back to original
    expect(resolveFootageVideoPath(native, "low")).toBe("assets/clip.mp4");
    // original quality always original
    expect(resolveFootageVideoPath(native, "original")).toBe("assets/clip.mp4");
    // bare asset with no proxies → always original regardless of tier
    expect(resolveFootageVideoPath(bare, "garbage")).toBe("assets/plain.mp4");
  });

  it("audio path is quality-independent and always original; raster has no audio", () => {
    expect(resolveFootageAudioPath(native)).toBe("assets/clip.mp4");
    expect(resolveFootageAudioPath(bare)).toBe("assets/plain.mp4");
    expect(resolveFootageAudioPath(raster)).toBeNull();
  });

  it("getProxyEntry returns null for original and missing tiers", () => {
    expect(getProxyEntry(native, "original")).toBeNull();
    expect(getProxyEntry(native, "low")).toBeNull();
    expect(getProxyEntry(native, "medium")?.path).toBe("assets/clip.medium.webm");
  });
});
