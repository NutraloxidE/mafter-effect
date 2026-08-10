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
    };
  }
}
