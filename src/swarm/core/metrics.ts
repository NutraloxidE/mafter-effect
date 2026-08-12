import { Ewma } from "./benchmark";
import type { SwarmMetricsSnapshot } from "./types";

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
  noteAdoptedRemoteFrame(): void { this.adoptedRemoteFrames += 1; }
  noteIneligibleJob(): void { this.ineligibleJobs += 1; }
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
    };
  }
}
