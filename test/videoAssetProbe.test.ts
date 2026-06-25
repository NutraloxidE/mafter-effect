import { describe, expect, it } from "vitest";
import { videoMimeFromPath } from "../src/runtime/videoAssetProbe";

describe("videoAssetProbe", () => {
  it("videoMimeFromPath maps common extensions", () => {
    expect(videoMimeFromPath("assets/x.mp4")).toBe("video/mp4");
    expect(videoMimeFromPath("assets/x.webm")).toBe("video/webm");
    expect(videoMimeFromPath("assets/x.mov")).toBe("video/quicktime");
    expect(videoMimeFromPath("assets/x.m4v")).toBe("video/mp4");
  });
});
