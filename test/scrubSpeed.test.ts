import { describe, expect, it } from "vitest";
import { resolveScrubDecimals, resolveScrubSpeed } from "../src/editor/ScrubNumber";

describe("resolveScrubSpeed", () => {
  it("uses range/100 for normalized 0..1 properties", () => {
    expect(resolveScrubSpeed(1, 0, 1)).toBe(0.01);
    expect(resolveScrubSpeed(1, 0, 0.5)).toBe(0.005);
  });

  it("prefers step when within normalized range", () => {
    expect(resolveScrubSpeed(1, 0, 1, 0.01)).toBe(0.01);
  });

  it("keeps default speed for wide ranges", () => {
    expect(resolveScrubSpeed(1, 0, 500)).toBe(1);
    expect(resolveScrubSpeed(2, 0, 100)).toBe(2);
  });

  it("resolveScrubDecimals uses 2 decimals for normalized range", () => {
    expect(resolveScrubDecimals(1, undefined, 0, 1)).toBe(2);
    expect(resolveScrubDecimals(1, undefined, 0, 500)).toBe(1);
  });
});
