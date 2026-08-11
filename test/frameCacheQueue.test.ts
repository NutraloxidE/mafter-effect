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

  it("runs one frame at a time by default and overlaps up to the remote capacity", async () => {
    const peakInFlight = async (concurrency: number): Promise<number> => {
      const q = new FrameCacheQueue();
      q.setConcurrency(concurrency);
      q.enqueueRange(0, 6, "background");
      let inFlight = 0;
      let peak = 0;
      let finished = 0;
      q.pump(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        finished += 1;
      });
      while (finished < 6) await new Promise((r) => setTimeout(r, 5));
      return peak;
    };

    // Local capture must stay serial: one CPU, one capture context.
    expect(await peakInFlight(1)).toBe(1);
    // With workers connected several frames may be rendering remotely at once.
    const parallel = await peakInFlight(3);
    expect(parallel).toBeGreaterThan(1);
    expect(parallel).toBeLessThanOrEqual(3);
  });
});
