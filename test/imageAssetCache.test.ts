import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../src/core/createProject";
import { MemoryFs } from "../src/fs/MemoryFs";
import { IndexedDbFs } from "../src/fs/IndexedDbFs";
import { ImageAssetCache, mimeFromPath, probeImageFile } from "../src/runtime/imageAssetCache";

describe("SVG image probing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the image decoder and SVG MIME even when the OS supplies an incorrect type", async () => {
    const bitmap = vi.fn().mockRejectedValue(new Error("SVG not supported"));
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    vi.stubGlobal("createImageBitmap", bitmap);
    vi.stubGlobal("Image", class {
      src = "";
      naturalWidth = 640;
      naturalHeight = 320;
      decode = async () => {};
    });
    const file = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"/>'], "art.SVG", { type: "application/octet-stream" });
    expect(await probeImageFile(file)).toEqual({ width: 640, height: 320, mime: "image/svg+xml" });
    expect(bitmap).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledOnce();
    revoke.mockRestore();
  });

  it("releases the temporary URL when SVG decoding fails", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    vi.stubGlobal("Image", class {
      src = "";
      decode = async () => { throw new Error("Invalid SVG"); };
    });
    await expect(probeImageFile(new File(["broken"], "broken.svg"))).rejects.toThrow("Invalid SVG");
    expect(revoke).toHaveBeenCalledOnce();
    revoke.mockRestore();
  });
});

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

  it("proxyMaxDim keeps natural size and does not downscale images within the cap", async () => {
    const fs = new MemoryFs();
    await fs.write("assets/img1.png", tinyPngBytes());

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
    // longest side (1) is well within the cap → no proxy, full-res data URL, natural size preserved.
    await cache.loadFromProject(project, fs, { proxyMaxDim: 1920 });

    expect(cache.getUrl("01ASSET00000000000000001")).toMatch(/^data:image\/png;base64,/);
    expect(cache.getSize("01ASSET00000000000000001")).toEqual({ width: 1, height: 1 });
  });

  it("loadFromProject builds blob URL for video assets", async () => {
    const fs = new MemoryFs();
    const bytes = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
    await fs.write("assets/vid1.mp4", bytes);

    const project = createProject({ name: "Test" });
    project.assets = [
      {
        id: "01ASSET00000000000000002",
        path: "assets/vid1.mp4",
        kind: "video",
        meta: { width: 1920, height: 1080, duration: 5, mime: "video/mp4" },
      },
    ];

    const cache = new ImageAssetCache();
    await cache.loadFromProject(project, fs);

    const url = cache.getUrl("01ASSET00000000000000002");
    expect(url).toMatch(/^blob:/);
    expect(cache.getSize("01ASSET00000000000000002")).toEqual({ width: 1920, height: 1080 });
    cache.evictAsset("01ASSET00000000000000002");
    expect(cache.getUrl("01ASSET00000000000000002")).toBeNull();
  });

  it("§Phase3: priorityAssetIds reorders load without changing final byId contents", async () => {
    const fs = new MemoryFs();
    const ids = ["01ASSET00000000000000010", "01ASSET00000000000000011", "01ASSET00000000000000012"];
    const project = createProject({ name: "Test" });
    project.assets = ids.map((id, i) => ({
      id,
      path: `assets/vid${i}.mp4`,
      kind: "video" as const,
      meta: { width: 100 + i, height: 200 + i, duration: 5, mime: "video/mp4" },
    }));
    for (const asset of project.assets) {
      await fs.write(asset.path, new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
    }

    // 優先集合はロード順序だけを変える。中央の asset を優先しても最終的な byId 内容は不変。
    const cache = new ImageAssetCache();
    await cache.loadFromProject(project, fs, { priorityAssetIds: new Set([ids[1]!]) });

    ids.forEach((id, i) => {
      expect(cache.getUrl(id)).toMatch(/^blob:/);
      expect(cache.getSize(id)).toEqual({ width: 100 + i, height: 200 + i });
    });
  });

  it("§Phase3: loadFromProject with IndexedDbFs resolves assets spanning multiple batches", async () => {
    const fs = new IndexedDbFs("test-imageAssetCache-batching");
    // LOAD_BATCH_SIZE(3) を跨ぐよう 5 件用意する（readBatch 経路 + バッチ間 yield ループの統合確認）。
    const count = 5;
    const project = createProject({ name: "Test" });
    project.assets = Array.from({ length: count }, (_, i) => ({
      id: `01ASSET0000000000000002${i}`,
      path: `assets/vid${i}.mp4`,
      kind: "video" as const,
      meta: { width: 320 + i, height: 240, duration: 5, mime: "video/mp4" },
    }));
    for (const asset of project.assets) {
      await fs.write(asset.path, new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
    }

    const cache = new ImageAssetCache();
    await cache.loadFromProject(project, fs);

    for (let i = 0; i < count; i++) {
      const id = `01ASSET0000000000000002${i}`;
      expect(cache.getUrl(id)).toMatch(/^blob:/);
      expect(cache.getSize(id)).toEqual({ width: 320 + i, height: 240 });
    }
  });

  it("§16.2b getPackedAlphaLayoutForQuality: proxy tier uses proxy layout, others fall back to original", () => {
    const project = createProject({ name: "Test" });
    project.assets = [
      {
        id: "01ASSETPACKED00000000001",
        path: "assets/packed.webm",
        kind: "video",
        meta: {
          hasAlpha: true,
          alphaMode: "packed",
          packedLayout: "topBottom",
          contentHeight: 1000,
          gutterPx: 8,
          width: 800,
          height: 1000,
          proxies: {
            low: {
              path: "assets/packed.low.webm",
              mime: "video/webm",
              width: 400,
              height: 900,
              contentHeight: 440,
              gutterPx: 4,
            },
          },
        },
      },
    ];

    const cache = new ImageAssetCache();
    // registerProjectUrls is synchronous (no video decode) — exercises the same
    // registerPackedProxyLayoutIfPresent wiring bundle export uses, without browser APIs.
    cache.registerProjectUrls(project, (p) => `/rel/${p}`);

    expect(cache.getPackedAlphaLayout("01ASSETPACKED00000000001")).toEqual({ contentHeight: 1000, gutterPx: 8 });
    expect(cache.getPackedAlphaLayoutForQuality("01ASSETPACKED00000000001", "low")).toEqual({
      contentHeight: 440,
      gutterPx: 4,
    });
    // original quality → always original layout.
    expect(cache.getPackedAlphaLayoutForQuality("01ASSETPACKED00000000001", "original")).toEqual({
      contentHeight: 1000,
      gutterPx: 8,
    });
    // proxy tier with no registered proxy layout (not generated yet) → falls back to original,
    // matching getUrlForQuality's own fallback (URL and layout stay paired).
    expect(cache.getPackedAlphaLayoutForQuality("01ASSETPACKED00000000001", "medium")).toEqual({
      contentHeight: 1000,
      gutterPx: 8,
    });
  });
});
