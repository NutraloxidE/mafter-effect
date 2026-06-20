import { describe, expect, it } from "vitest";
import {
  buildPrecompFrameCacheKey,
  parsePrecompFrameKey,
  precompChildToParentFrame,
  precompFrameCachePrefix,
  PRECOMP_FRAME_CACHE_PREFIX,
} from "../src/cache/precompFrameKey";

// §28.11 precomp comp 単位ラスターキャッシュキー（content hash 基準）。
describe("precompFrameKey — build/parse round-trip", () => {
  it("build したキーを parse すると compId と childFrame が復元できる", () => {
    const key = buildPrecompFrameCacheKey({ compId: "01COMP", childFrame: 42, contentHash: "abcd1234" });
    expect(key.startsWith(precompFrameCachePrefix("01COMP"))).toBe(true);
    expect(key.startsWith(PRECOMP_FRAME_CACHE_PREFIX)).toBe(true);
    expect(parsePrecompFrameKey(key)).toEqual({ compId: "01COMP", childFrame: 42 });
  });

  it("layer/comp 等の非該当キーは null", () => {
    expect(parsePrecompFrameKey("comp:C1:f10:rev3:qdraft")).toBeNull();
    expect(parsePrecompFrameKey("layer:01ABC:f5:hashfx")).toBeNull();
    expect(parsePrecompFrameKey("precomp:01COMP:nope")).toBeNull();
    expect(parsePrecompFrameKey("")).toBeNull();
  });

  it("childFrame=0 も parse できる", () => {
    const key = buildPrecompFrameCacheKey({ compId: "X", childFrame: 0, contentHash: "h" });
    expect(parsePrecompFrameKey(key)?.childFrame).toBe(0);
  });
});

// §28.11 緑線写像: childFrame → comp(B) parentFrame（§23.2 の逆）。
describe("precompChildToParentFrame — child→parent 写像", () => {
  it("inPoint/trimStart=0 は 1:1", () => {
    expect(precompChildToParentFrame(10, 0, 0)).toBe(10);
  });

  it("inPoint を加算する", () => {
    expect(precompChildToParentFrame(10, 0, 20)).toBe(30);
  });

  it("trimStart を減算する（§23.2 childFrame = parent − inPoint + trimStart の逆）", () => {
    // parentFrame=30, inPoint=10, trimStart=5 → childFrame = 30-10+5 = 25
    expect(precompChildToParentFrame(25, 5, 10)).toBe(30);
  });
});
