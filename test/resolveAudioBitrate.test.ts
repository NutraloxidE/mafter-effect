import { describe, expect, it } from "vitest";
import { resolveAudioBitrate } from "../src/runtime/exporter";

describe("resolveAudioBitrate", () => {
  it("defaults to 192k when unset/invalid", () => {
    expect(resolveAudioBitrate(undefined)).toBe(192_000);
    expect(resolveAudioBitrate(NaN)).toBe(192_000);
  });
  it("passes valid values through", () => {
    expect(resolveAudioBitrate(128_000)).toBe(128_000);
    expect(resolveAudioBitrate(320_000)).toBe(320_000);
  });
  it("clamps to 32k..320k", () => {
    expect(resolveAudioBitrate(1_000)).toBe(32_000);
    expect(resolveAudioBitrate(999_000)).toBe(320_000);
  });
});
