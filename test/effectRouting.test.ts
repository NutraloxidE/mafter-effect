import { describe, expect, it } from "vitest";
import {
  allowsFastDisplaceDirect,
  hasEnabledDisplacement,
  needsSvgDisplaceCapture,
} from "../src/runtime/effectRouting";

describe("effectRouting", () => {
  it("hasEnabledDisplacement includes Fast* distortion", () => {
    expect(hasEnabledDisplacement([{ type: "fastWave", enabled: true }])).toBe(true);
    expect(hasEnabledDisplacement([{ type: "blur", enabled: true }])).toBe(false);
  });

  it("needsSvgDisplaceCapture: 通常レイヤー + fast* → true", () => {
    expect(
      needsSvgDisplaceCapture({
        effects: [{ type: "fastTurbulentDisplace", enabled: true }],
      }),
    ).toBe(true);
  });

  it("needsSvgDisplaceCapture: Live調整 + blur only → false", () => {
    expect(
      needsSvgDisplaceCapture({
        isAdjustment: true,
        adjustmentMode: "live",
        effects: [{ type: "blur", enabled: true }],
        hasLiveFilterTokens: true,
      }),
    ).toBe(false);
  });

  it("needsSvgDisplaceCapture: Live調整 + fast* → true", () => {
    expect(
      needsSvgDisplaceCapture({
        isAdjustment: true,
        adjustmentMode: "live",
        effects: [{ type: "fastWave", enabled: true }],
      }),
    ).toBe(true);
  });

  it("needsSvgDisplaceCapture: Raster調整 + blur → true", () => {
    expect(
      needsSvgDisplaceCapture({
        isAdjustment: true,
        adjustmentMode: "raster",
        effects: [{ type: "blur", enabled: true }],
        hasLiveFilterTokens: true,
      }),
    ).toBe(true);
  });

  it("allowsFastDisplaceDirect is always false after drift fix", () => {
    expect(allowsFastDisplaceDirect()).toBe(false);
  });
});
