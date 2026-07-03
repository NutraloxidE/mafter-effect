import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIDEO_BITRATE,
  MAX_VIDEO_BITRATE,
  MIN_VIDEO_BITRATE,
  presetVideoBitrate,
  resolveExportVideoEncode,
} from "../src/runtime/exportVideoEncode";

describe("resolveExportVideoEncode", () => {
  it("omitted fields match current 8 Mbps / no latencyMode", () => {
    expect(resolveExportVideoEncode({})).toEqual({
      bitrate: DEFAULT_VIDEO_BITRATE,
      latencyMode: undefined,
    });
  });

  it("maps presets", () => {
    expect(resolveExportVideoEncode({ videoQuality: "low" }).bitrate).toBe(1_000_000);
    expect(resolveExportVideoEncode({ videoQuality: "medium" }).bitrate).toBe(4_000_000);
    expect(resolveExportVideoEncode({ videoQuality: "high" }).bitrate).toBe(8_000_000);
    expect(resolveExportVideoEncode({ videoQuality: "max" }).bitrate).toBe(20_000_000);
  });

  it("custom uses videoBitrate with clamp", () => {
    expect(resolveExportVideoEncode({
      videoQuality: "custom",
      videoBitrate: 100_000,
    }).bitrate).toBe(100_000);
    expect(resolveExportVideoEncode({
      videoQuality: "custom",
      videoBitrate: 1,
    }).bitrate).toBe(MIN_VIDEO_BITRATE);
    expect(resolveExportVideoEncode({
      videoQuality: "custom",
      videoBitrate: 999_999_999,
    }).bitrate).toBe(MAX_VIDEO_BITRATE);
  });

  it("custom without videoBitrate falls back to 8 Mbps", () => {
    expect(resolveExportVideoEncode({ videoQuality: "custom" }).bitrate).toBe(DEFAULT_VIDEO_BITRATE);
  });

  it("passes encodeLatencyMode through", () => {
    expect(resolveExportVideoEncode({ encodeLatencyMode: "quality" }).latencyMode).toBe("quality");
    expect(resolveExportVideoEncode({ encodeLatencyMode: "realtime" }).latencyMode).toBe("realtime");
  });

  it("presetVideoBitrate matches resolve", () => {
    expect(presetVideoBitrate("max")).toBe(20_000_000);
  });
});
