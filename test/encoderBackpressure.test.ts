import { describe, expect, it } from "vitest";
import { waitForEncoderQueueAtMost } from "../src/runtime/encoderBackpressure";

class FakeEncoderQueue extends EventTarget {
  encodeQueueSize: number;
  state: "unconfigured" | "configured" | "closed" = "configured";

  constructor(size: number) {
    super();
    this.encodeQueueSize = size;
  }

  dequeue(nextSize: number): void {
    this.encodeQueueSize = nextSize;
    this.dispatchEvent(new Event("dequeue"));
  }
}

describe("waitForEncoderQueueAtMost", () => {
  it("resolves immediately when the queue is within the bound", async () => {
    await expect(waitForEncoderQueueAtMost(new FakeEncoderQueue(6), 6)).resolves.toBeUndefined();
  });

  it("waits for enough dequeue events without polling", async () => {
    const encoder = new FakeEncoderQueue(8);
    let resolved = false;
    const waiting = waitForEncoderQueueAtMost(encoder, 6).then(() => { resolved = true; });

    encoder.dequeue(7);
    await Promise.resolve();
    expect(resolved).toBe(false);

    encoder.dequeue(6);
    await waiting;
    expect(resolved).toBe(true);
  });

  it("rejects and removes the dequeue wait when aborted", async () => {
    const encoder = new FakeEncoderQueue(8);
    const controller = new AbortController();
    const waiting = waitForEncoderQueueAtMost(encoder, 6, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
  });

  it("rejects when the encoder closes while waiting", async () => {
    const encoder = new FakeEncoderQueue(8);
    const waiting = waitForEncoderQueueAtMost(encoder, 6);
    encoder.state = "closed";
    encoder.dispatchEvent(new Event("dequeue"));
    await expect(waiting).rejects.toThrow("closed while waiting");
  });
});
