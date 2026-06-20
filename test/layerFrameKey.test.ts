import { describe, expect, it } from "vitest";
import {
  buildLayerFrameCacheKey,
  layerFrameCachePrefix,
  parseLayerFrameKey,
  LAYER_FRAME_CACHE_PREFIX,
} from "../src/cache/layerFrameKey";

// §28.10 per-layer raster キャッシュキー（local frame 基準）。
describe("layerFrameKey — build/parse round-trip", () => {
  it("build したキーを parse すると objectId と localFrame が復元できる", () => {
    const key = buildLayerFrameCacheKey({ objectId: "01ABC", frame: 42, propsHash: "wave:1:{}" });
    expect(key.startsWith(layerFrameCachePrefix("01ABC"))).toBe(true);
    expect(key.startsWith(LAYER_FRAME_CACHE_PREFIX)).toBe(true);
    const parsed = parseLayerFrameKey(key);
    expect(parsed).toEqual({ objectId: "01ABC", localFrame: 42 });
  });

  it("comp キー等の非該当キーは null", () => {
    expect(parseLayerFrameKey("comp:C1:f10:rev3:qdraft")).toBeNull();
    expect(parseLayerFrameKey("layer:01ABC:nope")).toBeNull();
    expect(parseLayerFrameKey("")).toBeNull();
  });

  it("localFrame=0 も parse できる", () => {
    const key = buildLayerFrameCacheKey({ objectId: "X", frame: 0, propsHash: "h" });
    expect(parseLayerFrameKey(key)?.localFrame).toBe(0);
  });
});

// スライド（move）不変性: compFrame と inPoint が同量 Δ シフトしても localFrame は不変。
// DomRenderer が用いる localFrame = max(0, compFrame - inPoint) を純関数として表明。
describe("layerFrameKey — slide invariance of local frame (§28.10)", () => {
  const localFrame = (compFrame: number, inPoint: number) => Math.max(0, compFrame - inPoint);

  it("Δ スライドで localFrame は変わらない → 同一キーで HIT", () => {
    const inPoint0 = 10;
    const compFrame0 = 25; // 表示中
    const delta = 7;
    const lf0 = localFrame(compFrame0, inPoint0);
    const lf1 = localFrame(compFrame0 + delta, inPoint0 + delta);
    expect(lf1).toBe(lf0);

    const key0 = buildLayerFrameCacheKey({ objectId: "L", frame: lf0, propsHash: "fx" });
    const key1 = buildLayerFrameCacheKey({ objectId: "L", frame: lf1, propsHash: "fx" });
    expect(key1).toBe(key0);
  });

  it("inPoint より前のフレームは 0 にクランプされる（負の local frame を作らない）", () => {
    expect(localFrame(5, 10)).toBe(0);
  });
});
