import { describe, expect, it } from "vitest";
import { videoLayerOutPoint } from "../src/editor/videoLayerOutPoint";

describe("videoLayerOutPoint", () => {
  it("trims to source duration when shorter than comp", () => {
    expect(videoLayerOutPoint({ duration: 2 }, 30, 150)).toBe(60);
  });

  it("uses comp duration when source is longer", () => {
    expect(videoLayerOutPoint({ duration: 10 }, 30, 150)).toBe(150);
  });

  it("falls back to comp duration when meta missing", () => {
    expect(videoLayerOutPoint(undefined, 30, 150)).toBe(150);
    expect(videoLayerOutPoint({}, 30, 150)).toBe(150);
    expect(videoLayerOutPoint({ duration: 0 }, 30, 150)).toBe(150);
  });

  it("rounds fractional seconds to frames", () => {
    expect(videoLayerOutPoint({ duration: 1.04 }, 30, 150)).toBe(31);
  });

  it("minimum one frame when source is tiny", () => {
    expect(videoLayerOutPoint({ duration: 0.001 }, 30, 150)).toBe(1);
  });
});
