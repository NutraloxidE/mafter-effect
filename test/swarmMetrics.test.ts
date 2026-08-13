import { describe, expect, it } from "vitest";
import { SwarmMetrics } from "../src/swarm/core/metrics";
import type { SwarmJobTimeline } from "../src/swarm/core/types";

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

  it("keeps liveness failure classes and late-work evidence separate", () => {
    const metrics = new SwarmMetrics();
    metrics.noteProbeStarted();
    metrics.noteProbeSuccess();
    metrics.noteJobFailure("no-ack");
    metrics.noteJobFailure("render-stall");
    metrics.noteJobFailure("transfer-stall");
    metrics.noteJobFailure("hard-deadline");
    metrics.noteLateValidResult(8);
    const snapshot = metrics.snapshot();
    expect(snapshot.probeJobs).toBe(1);
    expect(snapshot.probeSuccesses).toBe(1);
    expect(snapshot.jobAckTimeouts).toBe(1);
    expect(snapshot.jobRenderStalls).toBe(1);
    expect(snapshot.jobTransferStalls).toBe(1);
    expect(snapshot.jobHardTimeouts).toBe(1);
    expect(snapshot.lateValidResults).toBe(1);
    expect(snapshot.lateMeasuredFrames).toBe(8);
  });

  it("retains one canonical job timeline while return-path measurements finish", () => {
    const metrics = new SwarmMetrics();
    const timeline: SwarmJobTimeline = {
      jobId: "job-1",
      frameStart: 10,
      frameEnd: 18,
      host: {
        queueWaitMs: 2,
        assetReadyWaitMs: 3,
        offerToAckMs: 4,
        firstChunkLatencyMs: 5,
        transferMs: 6,
        transferredBytes: 7,
        reassemblyMs: 8,
        base64DecodeMs: 0,
        zipDecodeMs: 0,
        pngDecodeMs: 0,
        verificationMs: 0,
        adoptionDelayMs: 0,
      },
      remoteWallMs: 30,
      remoteRenderedFrames: 8,
      remoteReceivedFrames: 8,
      remoteAdoptedFrames: 0,
      verifiedRemoteFrames: 8,
      lateRemoteFrames: 0,
      complete: true,
    };
    metrics.noteJobTimeline(timeline);
    timeline.host.pngDecodeMs = 9;
    timeline.remoteAdoptedFrames = 2;
    metrics.noteJobTimeline(timeline);
    metrics.noteExportTimeline({
      exportElapsedMs: 100,
      consumerWaitMs: 11,
      exportTailWaitMs: 12,
      timeHostFinishedUsefulLocalWork: 70,
      timeLastRequiredRemoteFrameReady: 82,
      localFramesAvoided: 2,
      remoteFramesAdopted: 2,
      remoteRenderedFrames: 8,
      remoteReceivedFrames: 8,
      verifiedRemoteFrames: 8,
      lateRemoteFrames: 0,
    });
    const snapshot = metrics.snapshot();
    expect(snapshot.jobTimelines).toHaveLength(1);
    expect(snapshot.jobTimelines[0]?.host.pngDecodeMs).toBe(9);
    expect(snapshot.jobTimelines[0]?.remoteAdoptedFrames).toBe(2);
    expect(snapshot.remoteRenderedFrames).toBe(8);
    expect(snapshot.remoteReceivedFrames).toBe(8);
    expect(snapshot.verifiedRemoteFrames).toBe(8);
    expect(snapshot.exportTimelines[0]?.exportTailWaitMs).toBe(12);
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
