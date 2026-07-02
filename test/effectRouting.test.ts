import { describe, expect, it } from "vitest";
import {
  hasEnabledDisplacement,
  hasEnabledFullDisplacement,
  needsSvgDisplaceCapture,
} from "../src/runtime/effectRouting";

describe("effectRouting", () => {
  it("hasEnabledDisplacement includes Fast* distortion", () => {
    expect(hasEnabledDisplacement([{ type: "fastWave", enabled: true }])).toBe(true);
    expect(hasEnabledDisplacement([{ type: "blur", enabled: true }])).toBe(false);
  });

  it("hasEnabledFullDisplacement excludes Fast* and opticsCompensation", () => {
    expect(hasEnabledFullDisplacement([{ type: "fastWave", enabled: true }])).toBe(false);
    expect(hasEnabledFullDisplacement([{ type: "fastTurbulentDisplace", enabled: true }])).toBe(false);
    expect(hasEnabledFullDisplacement([{ type: "opticsCompensation", enabled: true }])).toBe(false);
    expect(hasEnabledFullDisplacement([{ type: "wave", enabled: true }])).toBe(true);
    expect(hasEnabledFullDisplacement([{ type: "turbulentDisplace", enabled: true }])).toBe(true);
    expect(hasEnabledFullDisplacement([{ type: "blur", enabled: true }])).toBe(false);
  });

  it("needsSvgDisplaceCapture: 通常レイヤー + fast* → false（live・§27.12 改定3）", () => {
    expect(
      needsSvgDisplaceCapture({
        effects: [{ type: "fastTurbulentDisplace", enabled: true }],
      }),
    ).toBe(false);
  });

  it("needsSvgDisplaceCapture: 通常レイヤー + full displacement(wave) → true", () => {
    expect(
      needsSvgDisplaceCapture({
        effects: [{ type: "wave", enabled: true }],
      }),
    ).toBe(true);
  });

  it("needsSvgDisplaceCapture: 通常レイヤー + opticsCompensation → false（live）", () => {
    expect(
      needsSvgDisplaceCapture({
        effects: [{ type: "opticsCompensation", enabled: true }],
      }),
    ).toBe(false);
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

  it("needsSvgDisplaceCapture: Live調整 + fast* → false（live backdrop・§27.12 改定3）", () => {
    expect(
      needsSvgDisplaceCapture({
        isAdjustment: true,
        adjustmentMode: "live",
        effects: [{ type: "fastWave", enabled: true }],
      }),
    ).toBe(false);
  });

  it("needsSvgDisplaceCapture: Live調整 + full displacement → true", () => {
    expect(
      needsSvgDisplaceCapture({
        isAdjustment: true,
        adjustmentMode: "live",
        effects: [{ type: "ripple", enabled: true }],
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
});
