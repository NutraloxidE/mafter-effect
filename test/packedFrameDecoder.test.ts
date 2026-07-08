import { describe, expect, it, vi } from "vitest";
import {
  keyframeIndexFor,
  nextKeyframeBoundary,
  PackedFrameLruCache,
  shouldCreatePackedFrameDecoder,
} from "../src/runtime/packedFrameDecoder";

describe("keyframeIndexFor", () => {
  const keyframes = [0, 30, 60, 90];

  it("returns the exact keyframe when target is a keyframe", () => {
    expect(keyframeIndexFor(keyframes, 0)).toBe(0);
    expect(keyframeIndexFor(keyframes, 30)).toBe(30);
    expect(keyframeIndexFor(keyframes, 90)).toBe(90);
  });

  it("returns the nearest preceding keyframe for non-keyframe targets", () => {
    expect(keyframeIndexFor(keyframes, 1)).toBe(0);
    expect(keyframeIndexFor(keyframes, 29)).toBe(0);
    expect(keyframeIndexFor(keyframes, 31)).toBe(30);
    expect(keyframeIndexFor(keyframes, 89)).toBe(60);
    expect(keyframeIndexFor(keyframes, 200)).toBe(90);
  });

  it("handles an extra (encoder-inserted) keyframe outside the assumed GOP grid", () => {
    // GOP=30を仮定しない: 実測どおりindex20にも追加keyframeがある場合。
    const withExtra = [0, 20, 30, 60];
    expect(keyframeIndexFor(withExtra, 25)).toBe(20);
    expect(keyframeIndexFor(withExtra, 19)).toBe(0);
  });
});

describe("nextKeyframeBoundary", () => {
  it("finds the next keyframe strictly after the given one", () => {
    const keyframes = [0, 30, 60];
    expect(nextKeyframeBoundary(keyframes, 0)).toBe(30);
    expect(nextKeyframeBoundary(keyframes, 30)).toBe(60);
  });

  it("returns Infinity when there is no later keyframe", () => {
    const keyframes = [0, 30, 60];
    expect(nextKeyframeBoundary(keyframes, 60)).toBe(Infinity);
  });
});

describe("PackedFrameLruCache", () => {
  function fakeFrame() {
    return { close: vi.fn() };
  }

  it("evicts the oldest entry and calls close() when capacity is exceeded", () => {
    const cache = new PackedFrameLruCache<ReturnType<typeof fakeFrame>>(2);
    const f0 = fakeFrame();
    const f1 = fakeFrame();
    const f2 = fakeFrame();
    cache.set(0, f0);
    cache.set(1, f1);
    expect(cache.size).toBe(2);
    cache.set(2, f2);
    expect(cache.size).toBe(2);
    expect(f0.close).toHaveBeenCalledTimes(1);
    expect(f1.close).not.toHaveBeenCalled();
    expect(f2.close).not.toHaveBeenCalled();
    expect(cache.has(0)).toBe(false);
    expect(cache.has(1)).toBe(true);
    expect(cache.has(2)).toBe(true);
  });

  it("get() bumps recency so the touched entry survives eviction", () => {
    const cache = new PackedFrameLruCache<ReturnType<typeof fakeFrame>>(2);
    const f0 = fakeFrame();
    const f1 = fakeFrame();
    const f2 = fakeFrame();
    cache.set(0, f0);
    cache.set(1, f1);
    cache.get(0); // 0 を最近使用として繰り上げる → 次の evict 対象は 1 になる
    cache.set(2, f2);
    expect(f1.close).toHaveBeenCalledTimes(1);
    expect(f0.close).not.toHaveBeenCalled();
    expect(cache.has(0)).toBe(true);
    expect(cache.has(1)).toBe(false);
  });

  it("overwriting an existing key closes the old value before replacing it", () => {
    const cache = new PackedFrameLruCache<ReturnType<typeof fakeFrame>>(2);
    const f0a = fakeFrame();
    const f0b = fakeFrame();
    cache.set(0, f0a);
    cache.set(0, f0b);
    expect(f0a.close).toHaveBeenCalledTimes(1);
    expect(f0b.close).not.toHaveBeenCalled();
    expect(cache.size).toBe(1);
  });

  it("clear() closes every remaining entry", () => {
    const cache = new PackedFrameLruCache<ReturnType<typeof fakeFrame>>(4);
    const frames = [fakeFrame(), fakeFrame(), fakeFrame()];
    frames.forEach((f, i) => cache.set(i, f));
    cache.clear();
    for (const f of frames) expect(f.close).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
  });
});

describe("shouldCreatePackedFrameDecoder", () => {
  it("refuses when a decoder already exists for the key", () => {
    expect(
      shouldCreatePackedFrameDecoder({ alreadyHasDecoder: true, activeCount: 0, maxDecoders: 4, killSwitchActive: false }),
    ).toBe(false);
  });

  it("refuses when the kill switch is active regardless of budget", () => {
    expect(
      shouldCreatePackedFrameDecoder({ alreadyHasDecoder: false, activeCount: 0, maxDecoders: 4, killSwitchActive: true }),
    ).toBe(false);
  });

  it("refuses when the budget is exhausted", () => {
    expect(
      shouldCreatePackedFrameDecoder({ alreadyHasDecoder: false, activeCount: 4, maxDecoders: 4, killSwitchActive: false }),
    ).toBe(false);
  });

  it("allows creation when budget has room and kill switch is off", () => {
    expect(
      shouldCreatePackedFrameDecoder({ alreadyHasDecoder: false, activeCount: 2, maxDecoders: 4, killSwitchActive: false }),
    ).toBe(true);
  });
});
