import type { Project } from "../../core/schema";

export const SWARM_PROTOCOL_VERSION = 1 as const;
export const SWARM_RUNTIME_VERSION = "mafter-render-runtime-v1";

export type SwarmPeerId = string;
export type SwarmDeviceId = string;
export type WorkerSlotId = string;
export type SwarmJobId = string;

export interface SwarmSessionDescriptor {
  sessionId: string;
  joinCode: string;
  expiresAt: number;
}

export interface SwarmPeerDescriptor {
  peerId: SwarmPeerId;
  deviceId: SwarmDeviceId;
  label: string;
  publicKeyJwk: JsonWebKey;
  requestedAt: number;
}

export interface CreateSwarmSessionInput {
  hostPeerId: SwarmPeerId;
  hostDeviceId: SwarmDeviceId;
  hostLabel: string;
  expiresInMs?: number;
  /**
   * Reattach to this join code instead of minting a new one. A host that restarts otherwise
   * strands every connected worker on a code that no longer exists, which makes an unattended
   * measurement loop impossible.
   */
  joinCode?: string;
}

export interface JoinSwarmSessionInput {
  joinCode: string;
  peer: SwarmPeerDescriptor;
}

export interface JoinSwarmSessionResult {
  session: SwarmSessionDescriptor;
  peer: SwarmPeerDescriptor;
}

export type SwarmSignal =
  | { kind: "description"; description: RTCSessionDescriptionInit }
  | { kind: "candidate"; candidate: RTCIceCandidateInit };

export type SwarmSignalingEvent =
  | { type: "peer-join-request"; peer: SwarmPeerDescriptor }
  | { type: "peer-approved"; peer: SwarmPeerDescriptor; hostPeerId: SwarmPeerId }
  | { type: "peer-rejected"; peerId: SwarmPeerId; reason?: string }
  | { type: "signal"; fromPeerId: SwarmPeerId; payload: SwarmSignal }
  | { type: "peer-left"; peerId: SwarmPeerId }
  | { type: "session-expired" };

export interface WorkerCapabilities {
  browser: string;
  userAgent?: string;
  logicalCores?: number;
  memoryGiB?: number;
  webgl: boolean;
  webgl2: boolean;
  webCodecs: boolean;
  offscreenCanvas: boolean;
  maxCanvasDimension?: number;
  runtimeVersion: string;
  protocolVersion: number;
}

export type WorkerConnectionState =
  | "pending"
  | "connecting"
  | "authenticating"
  | "syncing"
  | "ready"
  | "connected"
  | "reconnecting"
  | "offline"
  | "incompatible";

export interface WorkerPerformance {
  measurement: WorkerMeasurementState;
  benchmarkScore: number;
  /**
   * Compatibility flag for existing UI/harness consumers. It is true only after a real job on the
   * distributed composition has completed; synthetic benchmarks never set it.
   */
  measured?: boolean;
  /** Synthetic benchmark output is diagnostic only and never drives dispatch. */
  estimatedScore?: number;
  recentFramesPerSecond: number;
  recentRenderMs: number;
  reliability: number;
  lastUpdatedAt: number;
}

export type WorkerMeasurementState = "unknown" | "probing" | "measured";
export type WorkerHealthState = "unknown" | "probing" | "healthy" | "degraded" | "unusable";

export interface WorkerSnapshot {
  slotId: WorkerSlotId;
  peerId: SwarmPeerId;
  deviceId: SwarmDeviceId;
  label: string;
  state: WorkerConnectionState;
  health?: WorkerHealthState;
  lastFailure?: SwarmJobFailureReason;
  capabilities?: WorkerCapabilities;
  performance?: WorkerPerformance;
  currentJobId?: SwarmJobId;
  transport: "unknown" | "direct" | "relay";
  /** false while the worker page is hidden: browsers throttle background tabs so heavily that
   * leased frames miss every deadline and the work is discarded. */
  available?: boolean;
}

export type RenderJobPriority = "playhead" | "upcoming" | "previous" | "visible" | "background";
export type RenderJobState = "pending" | "leased" | "rendering" | "uploading" | "committed";
export type SwarmJobPhase = "queued" | "offered" | "accepted" | "rendering" | "transferring" | "completed";
export type SwarmJobFailureReason =
  | "no-ack"
  | "render-stall"
  | "transfer-stall"
  | "worker-failed"
  | "disconnected"
  | "hard-deadline"
  | "invalid-result";

/**
 * Worker-local durations. These values are measured on the worker and travel with the result;
 * they are never subtracted from a host clock. Keeping the phase names explicit makes the
 * accounting useful even when a phase overlaps a transport or host phase.
 */
export interface SwarmWorkerTiming {
  sessionPrepareMs: number;
  footageWarmupMs: number;
  renderMs: number;
  pngEncodeMs: number;
  zipFinalizeMs: number;
  base64Ms: number;
  hashMs: number;
}

/** Host-side round-trip and return-path timings for one remote job. */
export interface SwarmHostTiming {
  queueWaitMs: number;
  assetReadyWaitMs: number;
  offerToAckMs: number;
  firstChunkLatencyMs: number;
  transferMs: number;
  transferredBytes: number;
  reassemblyMs: number;
  base64DecodeMs: number;
  zipDecodeMs: number;
  pngDecodeMs: number;
  verificationMs: number;
  adoptionDelayMs: number;
}

/** One canonical, runtime-only accounting record for a remote job. */
export interface SwarmJobTimeline {
  jobId: SwarmJobId;
  frameStart: number;
  frameEnd: number;
  workerSlotId?: WorkerSlotId;
  worker?: SwarmWorkerTiming;
  host: SwarmHostTiming;
  /** Host offer-to-result-complete wall time, measured only with the host clock. */
  remoteWallMs: number;
  remoteRenderedFrames: number;
  remoteReceivedFrames: number;
  remoteAdoptedFrames: number;
  verifiedRemoteFrames: number;
  lateRemoteFrames: number;
  complete: boolean;
  failureReason?: SwarmJobFailureReason;
}

/** Runtime-only export-level tail and useful-work accounting. */
export interface SwarmExportTimeline {
  exportElapsedMs: number;
  consumerWaitMs: number;
  exportTailWaitMs: number;
  timeHostFinishedUsefulLocalWork: number | null;
  timeLastRequiredRemoteFrameReady: number | null;
  localFramesAvoided: number;
  remoteFramesAdopted: number;
  remoteRenderedFrames: number;
  remoteReceivedFrames: number;
  verifiedRemoteFrames: number;
  lateRemoteFrames: number;
}

export interface RenderProfile {
  /**
   * Export alpha setting. Without it a worker falls back to "unset background = transparent",
   * while an opaque export composites onto black — the same frame, rendered on two devices,
   * with different backgrounds.
   */
  alpha?: boolean;
  quality: "draft" | "precise";
  proxy: string;
  width: number;
  height: number;
}

export interface SwarmAssetTransfer {
  path: string;
  contentHash: string;
  mimeType?: string;
  bytesBase64: string;
}

export interface SwarmRenderJob {
  id: SwarmJobId;
  kind: "preview-frame";
  renderRevision: string;
  compositionId: string;
  frameStart: number;
  frameEnd: number;
  priority: RenderJobPriority;
  profile: RenderProfile;
  runtimeVersion: string;
  project: Project;
  assets?: SwarmAssetTransfer[];
  createdAt: number;
}

export interface SwarmRenderResult {
  /** Worker-side render time. Separates render cost from transport cost in the host's timing. */
  renderMs?: number;
  /** Worker-local phase accounting. Runtime-only; ignored by result validation. */
  workerTiming?: SwarmWorkerTiming;
  /** Host fills this after result validation so the export return path can complete the record. */
  hostTiming?: SwarmHostTiming;
  /** Host-only reference used to finish the same record after export-side verification/adoption. */
  timeline?: SwarmJobTimeline;
  jobId: SwarmJobId;
  renderRevision: string;
  compositionId: string;
  frameStart: number;
  frameEnd: number;
  width: number;
  height: number;
  format: "png" | "png-zip";
  bytesBase64: string;
  byteLength: number;
  contentHash?: string;
  runtimeVersion: string;
}

export interface JobLease {
  workerId: WorkerSlotId;
  leasedAt: number;
  deadline: number;
}

export interface LeasedRenderJob extends SwarmRenderJob {
  state: RenderJobState;
  attempts: number;
  lease?: JobLease;
}

export interface SwarmMetricsSnapshot {
  /** Results a worker returned that passed validation. Not a measure of work saved. */
  remoteFrames: number;
  /**
   * Frames a worker drew that were written to the export. This is the number that says whether
   * distributing the render did anything: an export can receive results for every block and still
   * adopt none of them, having re-rendered each one here.
   */
  adoptedRemoteFrames: number;
  /** Preview frames the swarm declined, e.g. files that could not travel with the job. */
  ineligibleJobs: number;
  signalingRequests: number;
  p2pMessages: number;
  p2pRxBytes: number;
  p2pTxBytes: number;
  queuedJobs: number;
  leasedJobs: number;
  localFallbackJobs: number;
  staleResultsDiscarded: number;
  probeJobs: number;
  probeSuccesses: number;
  jobAckTimeouts: number;
  jobRenderStalls: number;
  jobTransferStalls: number;
  jobHardTimeouts: number;
  lateValidResults: number;
  lateMeasuredFrames: number;
  workerJobFailures: number;
  hostRenderedFrames: number;
  localFramesAvoided: number;
  remoteReceived: number;
  remoteAdopted: number;
  /** Explicit names used by LOOP 4 accounting; the legacy aliases above remain for the HUD. */
  remoteRenderedFrames: number;
  remoteReceivedFrames: number;
  remoteAdoptedFrames: number;
  verifiedRemoteFrames: number;
  lateRemoteFrames: number;
  jobTimelines: SwarmJobTimeline[];
  exportTimelines: SwarmExportTimeline[];
}
