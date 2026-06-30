import { describe, expect, it } from "vitest";
import {
  DEFAULT_FOOTAGE_QUALITY,
  FOOTAGE_QUALITY_TIERS,
  PROXY_TIER_PARAMS,
  QUALITY_UI_GROUPS,
  footageQualityLabel,
  isProxyTier,
  normalizeFootageQuality,
  type ProxyTier,
} from "../src/runtime/footageQuality";
import {
  footageKindOf,
  getProxyEntry,
  resolveFootageAudioPath,
  resolveFootageVideoPath,
  resolveOriginalPath,
  type FootagePathAsset,
} from "../src/runtime/footagePlayback";

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
