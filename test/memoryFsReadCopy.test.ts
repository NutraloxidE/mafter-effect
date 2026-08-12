import { describe, expect, it } from "vitest";
import { MemoryFs } from "../src/fs/MemoryFs";

describe("MemoryFs read semantics", () => {
  it("returns an independent copy, so a reader cannot destroy the stored file", async () => {
    const fs = new MemoryFs();
    await fs.write("assets/clip.mp4", new Uint8Array([1, 2, 3, 4]));

    // A reader is free to transfer the buffer it was handed — decodeVideoBlobUrl posts it to a
    // Web Worker, which detaches it. Handing out the stored array made that destroy the file: a
    // composition using the same video on two layers read nothing the second time, and its
    // <video> sat at readyState 0 with no error, which is not a failure anyone can diagnose.
    const first = await fs.read("assets/clip.mp4");
    structuredClone(first.buffer, { transfer: [first.buffer] });
    expect(first.byteLength).toBe(0);

    const second = await fs.read("assets/clip.mp4");
    expect([...second]).toEqual([1, 2, 3, 4]);
  });

  it("does not let a caller mutate stored bytes through the value it read", async () => {
    const fs = new MemoryFs();
    await fs.write("a.bin", new Uint8Array([9, 9]));
    (await fs.read("a.bin"))[0] = 0;
    expect([...(await fs.read("a.bin"))]).toEqual([9, 9]);
  });
});
