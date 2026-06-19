import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { MemoryFs } from "../src/fs/MemoryFs";
import { ImageAssetCache, mimeFromPath } from "../src/runtime/imageAssetCache";

/** 1×1 赤 PNG */
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function tinyPngBytes(): Uint8Array {
  const bin = atob(TINY_PNG_B64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

describe("ImageAssetCache", () => {
  it("mimeFromPath maps common extensions", () => {
    expect(mimeFromPath("assets/foo.jpg")).toBe("image/jpeg");
    expect(mimeFromPath("assets/foo.png")).toBe("image/png");
    expect(mimeFromPath("assets/foo.webp")).toBe("image/webp");
  });

  it("loadFromProject builds data URL and size from meta", async () => {
    const fs = new MemoryFs();
    const png = tinyPngBytes();
    await fs.write("assets/img1.png", png);

    const project = createProject({ name: "Test" });
    project.assets = [
      {
        id: "01ASSET00000000000000001",
        path: "assets/img1.png",
        kind: "image",
        meta: { width: 1, height: 1, mime: "image/png" },
      },
    ];

    const cache = new ImageAssetCache();
    await cache.loadFromProject(project, fs);

    const url = cache.getUrl("01ASSET00000000000000001");
    expect(url).toMatch(/^data:image\/png;base64,/);
    expect(cache.getSize("01ASSET00000000000000001")).toEqual({ width: 1, height: 1 });
  });

  it("sizeFromMeta returns null for invalid meta", () => {
    expect(ImageAssetCache.sizeFromMeta(undefined)).toBeNull();
    expect(ImageAssetCache.sizeFromMeta({ width: 0, height: 10 })).toBeNull();
  });
});
