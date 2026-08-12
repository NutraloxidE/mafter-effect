import { Ewma } from "./benchmark";
import type { SwarmJobFailureReason, SwarmMetricsSnapshot } from "./types";

export class SwarmMetrics {
  private signalingRequests = 0;
  private p2pMessages = 0;
  private p2pRxBytes = 0;
  private p2pTxBytes = 0;
  private queuedJobs = 0;
  private leasedJobs = 0;
  private localFallbackJobs = 0;
  private staleResultsDiscarded = 0;
  private remoteFrames = 0;
  private adoptedRemoteFrames = 0;
  private ineligibleJobs = 0;
  private probeJobs = 0;
  private probeSuccesses = 0;
  private jobAckTimeouts = 0;
  private jobRenderStalls = 0;
  private jobTransferStalls = 0;
  private jobHardTimeouts = 0;
  private lateValidResults = 0;
  private lateMeasuredFrames = 0;
  private workerJobFailures = 0;
  private hostRenderedFrames = 0;
  private localFramesAvoided = 0;
  readonly throughput = new Ewma();

  noteSignalingRequest(): void { this.signalingRequests += 1; }
  noteP2pMessage(direction: "rx" | "tx", bytes: number): void {
    this.p2pMessages += 1;
    if (direction === "rx") this.p2pRxBytes += bytes;
    else this.p2pTxBytes += bytes;
  }
  setJobs(queued: number, leased: number): void { this.queuedJobs = queued; this.leasedJobs = leased; }
  noteLocalFallback(): void { this.localFallbackJobs += 1; }
  noteStaleResult(): void { this.staleResultsDiscarded += 1; }
  /**
   * Frames arrived. Says nothing about whether their pixels reached the file — see below. Counted
   * in frames, not results: a result carries a whole block, and counting results made the panel
   * report "15 of 3 received", which cannot be read against the adopted count at all.
   */
  noteRemoteFrame(frames = 1): void { this.remoteFrames += frames; }
  /**
   * A frame a worker drew was written to the output. Counting arrivals instead once made a session
   * report ten frames of distributed work when the host had re-rendered every one of them.
   */
  noteAdoptedRemoteFrame(): void {
    this.adoptedRemoteFrames += 1;
    this.localFramesAvoided += 1;
  }
  noteIneligibleJob(): void { this.ineligibleJobs += 1; }
  noteProbeStarted(): void { this.probeJobs += 1; }
  noteProbeSuccess(): void { this.probeSuccesses += 1; }
  noteJobFailure(reason: SwarmJobFailureReason): void {
    this.workerJobFailures += 1;
    if (reason === "no-ack") this.jobAckTimeouts += 1;
    if (reason === "render-stall") this.jobRenderStalls += 1;
    if (reason === "transfer-stall") this.jobTransferStalls += 1;
    if (reason === "hard-deadline") this.jobHardTimeouts += 1;
  }
  noteLateValidResult(frames: number): void {
    this.lateValidResults += 1;
    this.lateMeasuredFrames += Math.max(1, frames);
  }
  noteHostRenderedFrame(): void { this.hostRenderedFrames += 1; }
  setHostRenderStats(frames: number): void { this.hostRenderedFrames = Math.max(0, frames); }
  snapshot(): SwarmMetricsSnapshot {
    return {
      signalingRequests: this.signalingRequests,
      p2pMessages: this.p2pMessages,
      p2pRxBytes: this.p2pRxBytes,
      p2pTxBytes: this.p2pTxBytes,
      queuedJobs: this.queuedJobs,
      leasedJobs: this.leasedJobs,
      localFallbackJobs: this.localFallbackJobs,
      staleResultsDiscarded: this.staleResultsDiscarded,
      remoteFrames: this.remoteFrames,
      adoptedRemoteFrames: this.adoptedRemoteFrames,
      ineligibleJobs: this.ineligibleJobs,
      probeJobs: this.probeJobs,
      probeSuccesses: this.probeSuccesses,
      jobAckTimeouts: this.jobAckTimeouts,
      jobRenderStalls: this.jobRenderStalls,
      jobTransferStalls: this.jobTransferStalls,
      jobHardTimeouts: this.jobHardTimeouts,
      lateValidResults: this.lateValidResults,
      lateMeasuredFrames: this.lateMeasuredFrames,
      workerJobFailures: this.workerJobFailures,
      hostRenderedFrames: this.hostRenderedFrames,
      localFramesAvoided: this.localFramesAvoided,
      remoteReceived: this.remoteFrames,
      remoteAdopted: this.adoptedRemoteFrames,
    };
  }
}
