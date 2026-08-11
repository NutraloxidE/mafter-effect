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
  | "connected"
  | "reconnecting"
  | "offline"
  | "incompatible";

export interface WorkerPerformance {
  benchmarkScore: number;
  recentFramesPerSecond: number;
  recentRenderMs: number;
  reliability: number;
  lastUpdatedAt: number;
}

export interface WorkerSnapshot {
  slotId: WorkerSlotId;
  peerId: SwarmPeerId;
  deviceId: SwarmDeviceId;
  label: string;
  state: WorkerConnectionState;
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

export interface RenderProfile {
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
  jobId: SwarmJobId;
  renderRevision: string;
  compositionId: string;
  frameStart: number;
  frameEnd: number;
  width: number;
  height: number;
  format: "png";
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
  /** Frames actually rendered by a worker and accepted into the preview cache. */
  remoteFrames: number;
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
}
