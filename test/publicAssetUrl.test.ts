import { describe, expect, it } from "vitest";
import { resolvePublicAssetUrl } from "../src/runtime/publicAssetUrl";

describe("resolvePublicAssetUrl", () => {
  it("resolves against an http origin when base is '/' (web build)", () => {
    expect(resolvePublicAssetUrl("/subject-extract/mediapipe/wasm", "/", "https://host/index.html")).toBe(
      "https://host/subject-extract/mediapipe/wasm",
    );
  });

  it("resolves relative to the loaded document when base is './' (Electron file build)", () => {
    expect(
      resolvePublicAssetUrl(
        "/subject-extract/mediapipe/wasm",
        "./",
        "file:///C:/app/dist/index.html",
      ),
    ).toBe("file:///C:/app/dist/subject-extract/mediapipe/wasm");
  });

  it("collapses multiple leading slashes", () => {
    expect(resolvePublicAssetUrl("//fonts", "/", "https://host/index.html")).toBe(
      "https://host/fonts",
    );
  });

  it("does not append a trailing slash (MediaPipe concatenates its own file names)", () => {
    const url = resolvePublicAssetUrl("motion-track/pkg", "./", "file:///C:/app/dist/index.html");
    expect(url.endsWith("/")).toBe(false);
    expect(url).toBe("file:///C:/app/dist/motion-track/pkg");
  });
});
