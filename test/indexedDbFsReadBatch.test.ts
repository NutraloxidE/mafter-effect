import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IndexedDbFs } from "../src/fs/IndexedDbFs";

describe("IndexedDbFs.readBatch", () => {
  it("returns a Map with existing keys and omits missing ones", async () => {
    const fs = new IndexedDbFs("test-readbatch-1");
    await fs.write("assets/a.mp4", new Uint8Array([1, 2, 3]));
    await fs.write("assets/b.mp4", new Uint8Array([4, 5]));

    const out = await fs.readBatch(["assets/a.mp4", "assets/missing.mp4", "assets/b.mp4"]);

    expect(out.size).toBe(2);
    expect(out.get("assets/a.mp4")).toEqual(new Uint8Array([1, 2, 3]));
    expect(out.get("assets/b.mp4")).toEqual(new Uint8Array([4, 5]));
    expect(out.has("assets/missing.mp4")).toBe(false);
  });

  it("returns an empty Map for an empty path list", async () => {
    const fs = new IndexedDbFs("test-readbatch-2");
    const out = await fs.readBatch([]);
    expect(out.size).toBe(0);
  });

  it("matches bytes returned by the existing single read()", async () => {
    const fs = new IndexedDbFs("test-readbatch-3");
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    await fs.write("assets/c.mp4", bytes);

    const viaRead = await fs.read("assets/c.mp4");
    const viaBatch = (await fs.readBatch(["assets/c.mp4"])).get("assets/c.mp4");

    expect(viaBatch).toEqual(viaRead);
  });
});
