import { describe, expect, it } from "vitest";
import { chromaOffsetPx } from "../src/runtime/effectSvg";

describe("chromaOffsetPx (pure)", () => {
  it("angle=0 → +x only", () => {
    const { dx, dy } = chromaOffsetPx(10, 0);
    expect(dx).toBeCloseTo(10, 10);
    expect(dy).toBeCloseTo(0, 10);
  });

  it("angle=90 → +y only", () => {
    const { dx, dy } = chromaOffsetPx(10, 90);
    expect(dx).toBeCloseTo(0, 10);
    expect(dy).toBeCloseTo(10, 10);
  });

  it("angle=180 → -x", () => {
    const { dx, dy } = chromaOffsetPx(10, 180);
    expect(dx).toBeCloseTo(-10, 10);
    expect(dy).toBeCloseTo(0, 10);
  });

  it("angle=45 scales both axes equally", () => {
    const { dx, dy } = chromaOffsetPx(10, 45);
    const expected = 10 * Math.SQRT1_2;
    expect(dx).toBeCloseTo(expected, 10);
    expect(dy).toBeCloseTo(expected, 10);
  });
});
