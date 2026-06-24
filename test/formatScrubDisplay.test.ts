import { describe, expect, it } from "vitest";
import {
  formatScrubDisplay,
  formatScrubEdit,
  formatScrubTitle,
  trimTrailingZeros,
} from "../src/editor/formatScrubDisplay";

describe("trimTrailingZeros", () => {
  it("removes trailing zeros and decimal point", () => {
    expect(trimTrailingZeros("1.50")).toBe("1.5");
    expect(trimTrailingZeros("100.00")).toBe("100");
    expect(trimTrailingZeros("0.50")).toBe("0.5");
    expect(trimTrailingZeros("1920")).toBe("1920");
  });
});

describe("formatScrubDisplay", () => {
  it("shows zero without decimals", () => {
    expect(formatScrubDisplay(0)).toBe("0");
  });

  it("formats large values with minimal decimals", () => {
    expect(formatScrubDisplay(1920)).toBe("1920");
    expect(formatScrubDisplay(100.5)).toBe("100.5");
    expect(formatScrubDisplay(100.04)).toBe("100.04");
  });

  it("formats mid-range values", () => {
    expect(formatScrubDisplay(1.5)).toBe("1.5");
    expect(formatScrubDisplay(3.25)).toBe("3.25");
  });

  it("formats normalized values", () => {
    expect(formatScrubDisplay(0.5)).toBe("0.5");
    expect(formatScrubDisplay(0.03)).toBe("0.03");
  });

  it("shows small values with extra precision", () => {
    expect(formatScrubDisplay(0.003)).toBe("0.003");
    expect(formatScrubDisplay(0.0003)).toBe("0.0003");
    expect(formatScrubDisplay(-0.007)).toBe("-0.007");
  });

  it("handles non-finite values", () => {
    expect(formatScrubDisplay(NaN)).toBe("0");
    expect(formatScrubDisplay(Infinity)).toBe("0");
  });
});

describe("formatScrubEdit", () => {
  it("preserves full precision for editing", () => {
    expect(formatScrubEdit(0.003)).toBe("0.003");
    expect(formatScrubEdit(100.04)).toBe("100.04");
    expect(formatScrubEdit(0)).toBe("0");
  });
});

describe("formatScrubTitle", () => {
  it("shows high precision for tooltip", () => {
    expect(formatScrubTitle(0.003)).toBe("0.003");
    expect(formatScrubTitle(100.04)).toBe("100.04");
  });
});
