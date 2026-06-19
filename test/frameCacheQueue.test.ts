import { describe, expect, it } from "vitest";
import { FrameCacheQueue } from "../src/cache/frameCacheQueue";

describe("FrameCacheQueue", () => {
  it("processes scrub before background", async () => {
    const q = new FrameCacheQueue();
    const order: number[] = [];
    q.enqueueRange(0, 5, "background");
    q.enqueue(3, "scrub");
    q.enqueue(1, "scrub");
    q.pump(async (frame) => {
      order.push(frame);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(order[0]).toBe(3);
    expect(order[1]).toBe(1);
    expect(order.slice(2)).toEqual([0, 2, 4]);
  });

  it("upgrades priority for the same frame", async () => {
    const q = new FrameCacheQueue();
    const order: number[] = [];
    q.enqueue(2, "background");
    q.enqueue(2, "scrub");
    q.pump(async (frame) => {
      order.push(frame);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([2]);
  });

  it("aborts pending jobs", async () => {
    const q = new FrameCacheQueue();
    const order: number[] = [];
    q.enqueueRange(0, 10, "background");
    q.pump(async (frame, gen) => {
      if (frame === 0) q.abort();
      if (gen !== q.getGeneration()) return;
      order.push(frame);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(order.length).toBeLessThanOrEqual(1);
  });
});
