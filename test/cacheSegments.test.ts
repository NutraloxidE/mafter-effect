import { describe, expect, it } from "vitest";
import { framesToSegments } from "../src/editor/cacheSegments";

// §28.10: 緑バー/緑線共有の run マージ。frameToPercent は線形（1 frame = 1%）で検証。
const pct = (f: number): number => f; // 直接 % へ写像

describe("framesToSegments — run マージ（§28.10）", () => {
  it("連続フレームは 1 セグメントに畳まれ、右端は最終フレーム+1", () => {
    const segs = framesToSegments([3, 4, 5], { start: 0, end: 100 }, pct);
    expect(segs).toEqual([{ left: 3, width: 3 }]); // [3,6)
  });

  it("ギャップで複数セグメントに分割される", () => {
    const segs = framesToSegments([0, 1, 5, 6, 7], { start: 0, end: 100 }, pct);
    expect(segs).toEqual([
      { left: 0, width: 2 }, // [0,2)
      { left: 5, width: 3 }, // [5,8)
    ]);
  });

  it("viewRange 外のフレームは除外される", () => {
    const segs = framesToSegments([1, 2, 50, 51], { start: 10, end: 40 }, pct);
    expect(segs).toEqual([]);
  });

  it("単一フレームでも最小幅 0.2 を保証", () => {
    const segs = framesToSegments([10], { start: 0, end: 100 }, () => 0);
    expect(segs).toEqual([{ left: 0, width: 0.2 }]);
  });

  it("順不同・重複入力でもソート/マージされる", () => {
    const segs = framesToSegments([5, 3, 4, 4], { start: 0, end: 100 }, pct);
    expect(segs).toEqual([{ left: 3, width: 3 }]);
  });

  it("空集合は空配列", () => {
    expect(framesToSegments([], { start: 0, end: 100 }, pct)).toEqual([]);
  });
});
