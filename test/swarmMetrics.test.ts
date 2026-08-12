import { describe, expect, it } from "vitest";
import { SwarmMetrics } from "../src/swarm/core/metrics";

describe("swarm metrics", () => {
  // Received and adopted are compared against each other to decide whether remote work was useful,
  // so both must be counted in frames. Counting results made a run report "15 adopted of 3 received".
  it("counts received work in frames, not results", () => {
    const metrics = new SwarmMetrics();
    metrics.noteRemoteFrame(8);
    metrics.noteRemoteFrame(7);
    for (let i = 0; i < 15; i += 1) metrics.noteAdoptedRemoteFrame();
    const snapshot = metrics.snapshot();
    expect(snapshot.remoteFrames).toBe(15);
    expect(snapshot.adoptedRemoteFrames).toBeLessThanOrEqual(snapshot.remoteFrames);
  });
});

describe("host render cost", () => {
  // Capacity is a ratio, so both sides must be measured on the same workload. Scoring a worker's
  // real-composition frames against the host's empty-comp frames once reported 2.7x for a worker
  // that was 1.4x slower on the actual job.
  it("reports mean cost per frame, and nothing from a single sample", async () => {
    const { resetHostRenderCost, noteHostRenderedFrame, hostMsPerFrame, getHostRenderCost } =
      await import("../src/runtime/hostRenderCost");
    resetHostRenderCost();
    expect(hostMsPerFrame()).toBeNull();
    noteHostRenderedFrame(100);
    expect(hostMsPerFrame()).toBeNull();
    noteHostRenderedFrame(300);
    expect(hostMsPerFrame()).toBe(200);
    expect(getHostRenderCost().frames).toBe(2);
    resetHostRenderCost();
    expect(getHostRenderCost()).toEqual({ frames: 0, ms: 0 });
  });
});
