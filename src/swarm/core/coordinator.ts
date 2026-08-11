import { createBenchmarkJob, normalizedBenchmarkScore } from "./benchmark";
import { isSwarmJobSelfContained } from "./jobFiles";
import { ResultChunkAssembler, splitAssetIntoChunks } from "../transport/assetChunks";
import { WorkerRenderExecutor } from "../worker/workerRenderExecutor";
import { isWorkerCompatible } from "./capability";
import { createChallengeNonce, verifyChallenge, type DeviceIdentity } from "./identity";
import { createSwarmMessage, isSwarmMessageType } from "./protocol";
import { SwarmMetrics } from "./metrics";
import { SwarmScheduler } from "./scheduler";
import { validateSwarmRenderResult } from "./cacheKey";
import { WebRtcPeer } from "../transport/WebRtcPeer";
import type { SwarmSignalingBackend } from "../signaling/SignalingBackend";
import type {
  SwarmMessageEnvelope,
  SwarmHelloPayload,
} from "./protocol";
import type {
  SwarmPeerDescriptor,
  SwarmRenderJob,
  SwarmRenderResult,
  SwarmSessionDescriptor,
  SwarmSignalingEvent,
  SwarmSignal,
  SwarmAssetTransfer,
  SwarmJobId,
  SwarmMetricsSnapshot,
  WorkerSnapshot,
} from "./types";

/** Floor and ceiling for how long a preview frame may stay with a worker. */
export const SWARM_DEFAULT_JOB_TIMEOUT_MS = 4_000;
export const SWARM_MAX_JOB_TIMEOUT_MS = 60_000;

interface PendingJob {
  job: SwarmRenderJob;
  resolve: (result: SwarmRenderResult | null) => void;
  timeoutId: number;
  /** Lease長 = 呼び出し側が待つ時間。短いリースは描画中のジョブを再配布してしまう。 */
  leaseMs: number;
}

interface TrustedWorker {
  deviceId: string;
  publicKeyJwk: JsonWebKey;
  slotId: string;
  label: string;
}

interface ConnectedWorker {
  peer: WebRtcPeer;
  descriptor: SwarmPeerDescriptor;
  slotId?: string;
  challengeNonce?: string;
  benchmarkInFlight: boolean;
  snapshot: WorkerSnapshot;
  /** Content hashes already streamed to this worker, so footage is sent once and not per frame. */
  sentAssetHashes: Set<string>;
}

export interface SwarmCoordinatorOptions {
  backend: SwarmSignalingBackend;
  session: SwarmSessionDescriptor;
  hostPeerId: string;
  hostIdentity: DeviceIdentity;
  hostLabel: string;
  runtimeVersion: string;
  /** Receives frames that arrive after their deadline, so a slow worker's render is still used. */
  onLateResult?: (result: SwarmRenderResult) => void;
}

export class SwarmCoordinator {
  readonly scheduler = new SwarmScheduler();
  readonly metrics = new SwarmMetrics();
  private readonly workers = new Map<string, ConnectedWorker>();
  private readonly pending = new Map<string, SwarmPeerDescriptor>();
  private readonly jobs = new Map<SwarmJobId, PendingJob>();
  private readonly trusted = new Map<string, TrustedWorker>();
  private readonly listeners = new Set<() => void>();
  private unsubscribeSignaling: (() => void) | null = null;
  private leaseTimer: number | null = null;
  private localBenchmarkScore: Promise<number> | null = null;
  private readonly resultChunks = new ResultChunkAssembler();

  constructor(private readonly options: SwarmCoordinatorOptions) {
    this.loadTrust();
  }

  async start(): Promise<void> {
    this.unsubscribeSignaling = await this.options.backend.subscribe(
      this.options.session.sessionId,
      this.options.hostPeerId,
      (event) => this.handleSignalingEvent(event),
    );
    this.leaseTimer = window.setInterval(() => {
      this.scheduler.reclaimExpired(Date.now());
      this.pumpJobs();
      this.emitChange();
    }, 1_000);
  }

  stop(): void {
    this.unsubscribeSignaling?.();
    this.unsubscribeSignaling = null;
    if (this.leaseTimer !== null) window.clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    for (const worker of this.workers.values()) worker.peer.close();
    this.workers.clear();
    this.pending.clear();
    for (const job of this.jobs.values()) {
      window.clearTimeout(job.timeoutId);
      job.resolve(null);
    }
    this.jobs.clear();
    this.emitChange();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get session(): SwarmSessionDescriptor {
    return this.options.session;
  }

  getPendingWorkers(): SwarmPeerDescriptor[] {
    return [...this.pending.values()];
  }

  getWorkers(): WorkerSnapshot[] {
    return [...this.workers.values()].map((worker) => worker.snapshot);
  }

  getMetrics(): SwarmMetricsSnapshot {
    return this.metrics.snapshot();
  }

  getAvailableCompute(): number {
    let total = 1;
    for (const worker of this.workers.values()) {
      if (worker.snapshot.state !== "connected") continue;
      total += worker.snapshot.performance?.benchmarkScore ?? 0;
    }
    return total;
  }

  async approveWorker(peerId: string, approved: boolean): Promise<void> {
    const peer = this.pending.get(peerId);
    if (!peer) return;
    await this.options.backend.approveJoin(this.options.session.sessionId, this.options.hostPeerId, peerId, approved);
    this.pending.delete(peerId);
    if (!approved) this.emitChange();
    if (approved) {
      const webRtc = new WebRtcPeer({ initiator: true });
      const worker: ConnectedWorker = {
        peer: webRtc,
        descriptor: peer,
        benchmarkInFlight: false,
        sentAssetHashes: new Set<string>(),
        snapshot: {
          slotId: `pending-${peer.peerId}`,
          peerId: peer.peerId,
          deviceId: peer.deviceId,
          label: peer.label,
          state: "connecting",
          transport: "unknown",
        },
      };
      this.workers.set(peer.peerId, worker);
      webRtc.onSignal = (signal) => void this.sendSignal(peer.peerId, signal);
      webRtc.onMessage = (message) => void this.handleWorkerMessage(worker, message);
      webRtc.onStateChange = (state) => this.handlePeerState(worker, state);
      webRtc.onTransportKind = (kind) => {
        worker.snapshot.transport = kind;
        this.emitChange();
      };
      await webRtc.start();
      this.emitChange();
    }
  }

  /**
   * Streams footage to every connected worker up front. Transferring inside a job makes the first
   * frame absorb the whole file and miss its deadline, which wastes the transfer and the render.
   */
  async preloadAssets(assets: SwarmAssetTransfer[]): Promise<void> {
    await Promise.all([...this.workers.values()].map(async (worker) => {
      if (!this.isWorkerReady(worker)) return;
      for (const asset of assets) {
        if (!asset.bytesBase64 || worker.sentAssetHashes.has(asset.contentHash)) continue;
        try {
          for (const chunk of splitAssetIntoChunks(asset)) {
            await worker.peer.protocol?.send(createSwarmMessage("asset-chunk", chunk));
          }
          worker.sentAssetHashes.add(asset.contentHash);
        } catch {
          worker.sentAssetHashes.delete(asset.contentHash);
          return;
        }
      }
    }));
  }

  hasAvailableWorker(): boolean {
    return [...this.workers.values()].some((worker) => this.isWorkerReady(worker));
  }

  /**
   * @param timeoutMs deadline before the frame is rendered locally instead. A fixed short deadline
   * makes heavy comps — the ones that need help — always fall back while the worker keeps
   * rendering a result nobody waits for, so callers pass a deadline derived from what the frame
   * actually costs.
   */
  async renderPreviewFrame(job: SwarmRenderJob, timeoutMs = SWARM_DEFAULT_JOB_TIMEOUT_MS): Promise<SwarmRenderResult | null> {
    if (!this.hasAvailableWorker()) return null;
    if (!this.isEligibleJob(job)) {
      this.metrics.noteIneligibleJob();
      return null;
    }
    this.scheduler.enqueue(job);
    const result = await new Promise<SwarmRenderResult | null>((resolve) => {
      const timeoutId = window.setTimeout(() => {
        this.jobs.delete(job.id);
        this.scheduler.reclaimExpired(Date.now());
        this.metrics.noteLocalFallback();
        resolve(null);
      }, Math.min(SWARM_MAX_JOB_TIMEOUT_MS, Math.max(SWARM_DEFAULT_JOB_TIMEOUT_MS, timeoutMs)));
      this.jobs.set(job.id, { job, resolve, timeoutId, leaseMs: Math.min(SWARM_MAX_JOB_TIMEOUT_MS, Math.max(SWARM_DEFAULT_JOB_TIMEOUT_MS, timeoutMs)) });
      this.requestBenchmarks(job);
      this.pumpJobs();
    });
    return result;
  }

  /**
   * Ends a job that cannot be delivered. Without this the caller keeps waiting for the full
   * deadline even though the frame is already known to be lost.
   */
  private releaseJob(worker: ConnectedWorker, jobId: SwarmJobId): void {
    worker.snapshot.currentJobId = undefined;
    const waiter = this.jobs.get(jobId);
    if (waiter) {
      window.clearTimeout(waiter.timeoutId);
      this.jobs.delete(jobId);
      this.metrics.noteLocalFallback();
      waiter.resolve(null);
    }
    this.pumpJobs();
    this.emitChange();
  }

  private isWorkerReady(worker: ConnectedWorker): worker is ConnectedWorker & { slotId: string } {
    return worker.slotId !== undefined
      && worker.snapshot.state === "connected"
      && worker.snapshot.available !== false;
  }

  private isEligibleJob(job: SwarmRenderJob): boolean {
    const comp = job.project.compositions.find((candidate) => candidate.id === job.compositionId);
    if (!comp || comp.kind !== "timeline") return false;
    // Assets and expression scripts are allowed as long as their bytes travel with the job; a job
    // whose footage or script could not be attached renders locally instead of losing content.
    return isSwarmJobSelfContained(job, comp);
  }

  private nextLeaseMs(): number {
    let leaseMs = SWARM_DEFAULT_JOB_TIMEOUT_MS;
    for (const pending of this.jobs.values()) leaseMs = Math.max(leaseMs, pending.leaseMs);
    return leaseMs;
  }

  private ensureLocalBenchmarkScore(): Promise<number> {
    this.localBenchmarkScore ??= new WorkerRenderExecutor()
      .benchmark(createBenchmarkJob(this.options.runtimeVersion))
      .then((result) => result.score)
      .catch(() => 0);
    return this.localBenchmarkScore;
  }

  /**
   * Streams any not-yet-delivered footage as chunks, then offers the job carrying references only.
   * Sending bytes inline on every job would re-transmit the same file for each frame and would cap
   * footage at one data-channel message.
   */
  private async offerJob(worker: ConnectedWorker, job: SwarmRenderJob): Promise<void> {
    const assets = job.assets ?? [];
    try {
      for (const asset of assets) {
        if (!asset.bytesBase64 || worker.sentAssetHashes.has(asset.contentHash)) continue;
        for (const chunk of splitAssetIntoChunks(asset)) {
          await worker.peer.protocol?.send(createSwarmMessage("asset-chunk", chunk));
        }
        worker.sentAssetHashes.add(asset.contentHash);
      }
      const references = assets.map((asset) => ({ ...asset, bytesBase64: "" }));
      await worker.peer.protocol?.send(createSwarmMessage("job-offer", { job: { ...job, assets: references } }));
    } catch {
      // A half-sent file must not be remembered as delivered.
      for (const asset of assets) worker.sentAssetHashes.delete(asset.contentHash);
      if (worker.slotId) this.scheduler.fail(job.id, worker.slotId);
      this.releaseJob(worker, job.id);
    }
  }

  private requestBenchmarks(job: SwarmRenderJob): void {
    for (const worker of this.workers.values()) {
      if (worker.slotId === undefined || worker.snapshot.state !== "connected" || worker.snapshot.performance || worker.benchmarkInFlight) continue;
      worker.benchmarkInFlight = true;
      void worker.peer.protocol?.send(createSwarmMessage("benchmark-request", { job }));
    }
  }

  private pumpJobs(): void {
    for (const worker of this.workers.values()) {
      if (!this.isWorkerReady(worker) || worker.snapshot.currentJobId) continue;
      // The lease must outlive the render: expiring it mid-render re-offers the same frame and the
      // worker ends up drawing it several times at once, which only makes it slower still.
      const leased = this.scheduler.requestJob(worker.slotId, Date.now(), this.nextLeaseMs());
      if (!leased) continue;
      worker.snapshot.currentJobId = leased.id;
      this.metrics.setJobs(this.scheduler.getSnapshot().pending, this.scheduler.getSnapshot().leased);
      void this.offerJob(worker, leased);
      this.emitChange();
    }
  }

  private async handleWorkerMessage(worker: ConnectedWorker, message: SwarmMessageEnvelope): Promise<void> {
    if (isSwarmMessageType(message, "hello")) {
      await this.handleHello(worker, message.payload);
      return;
    }
    if (isSwarmMessageType(message, "capabilities")) {
      worker.snapshot.capabilities = message.payload;
      if (!isWorkerCompatible(message.payload, this.options.runtimeVersion)) {
        worker.snapshot.state = "incompatible";
        await worker.peer.protocol?.send(createSwarmMessage("worker-draining", { reason: "incompatible-runtime" }));
        this.emitChange();
      }
      return;
    }
    if (isSwarmMessageType(message, "worker-availability")) {
      worker.snapshot.available = message.payload.available;
      this.emitChange();
      if (message.payload.available) this.pumpJobs();
      return;
    }
    if (isSwarmMessageType(message, "challenge-response")) {
      await this.handleChallengeResponse(worker, message.payload.nonce, message.payload.signatureBase64);
      return;
    }
    if (isSwarmMessageType(message, "benchmark-result")) {
      worker.benchmarkInFlight = false;
      // Scores are frames/second on that device; compute is only meaningful relative to the host,
      // so normalize against the host running the identical benchmark job.
      const localScore = await this.ensureLocalBenchmarkScore();
      const relativeScore = normalizedBenchmarkScore(message.payload.score, localScore);
      worker.snapshot.performance = {
        benchmarkScore: relativeScore,
        recentFramesPerSecond: message.payload.framesPerSecond,
        recentRenderMs: message.payload.renderMs,
        reliability: 1,
        lastUpdatedAt: Date.now(),
      };
      if (worker.slotId) this.scheduler.updateWorker({ slotId: worker.slotId, score: relativeScore, reliability: 1, connected: true });
      this.emitChange();
      this.pumpJobs();
      return;
    }
    if (isSwarmMessageType(message, "job-accepted")) {
      if (worker.slotId) this.scheduler.markRendering(message.payload.jobId, worker.slotId);
      return;
    }
    if (isSwarmMessageType(message, "job-progress")) {
      if (worker.slotId) this.scheduler.markRendering(message.payload.jobId, worker.slotId);
      return;
    }
    if (isSwarmMessageType(message, "job-result-chunk")) {
      this.resultChunks.accept(message.payload);
      return;
    }
    if (isSwarmMessageType(message, "job-result")) {
      const bytesBase64 = message.payload.bytesBase64 || this.resultChunks.take(message.payload.jobId) || "";
      await this.handleResult(worker, { ...message.payload, bytesBase64 });
      return;
    }
    if (isSwarmMessageType(message, "job-failed")) {
      if (worker.slotId) this.scheduler.fail(message.payload.jobId, worker.slotId);
      this.releaseJob(worker, message.payload.jobId);
    }
  }

  private async handleHello(worker: ConnectedWorker, hello: SwarmHelloPayload): Promise<void> {
    if (hello.deviceId !== worker.descriptor.deviceId) {
      worker.snapshot.state = "offline";
      worker.peer.close();
      return;
    }
    worker.descriptor = { ...worker.descriptor, label: hello.label, publicKeyJwk: hello.publicKeyJwk };
    worker.snapshot.label = hello.label;
    worker.challengeNonce = createChallengeNonce();
    await worker.peer.protocol?.send(createSwarmMessage("challenge", { nonce: worker.challengeNonce }));
    this.emitChange();
  }

  /**
   * Drops an earlier connection from the same device. A worker page that reloads or reconnects
   * arrives as a new peer, and leaving the stale one registered makes the panel show an Offline
   * worker and lets the scheduler lease frames to a slot nobody is serving.
   */
  private dropStaleConnections(keep: ConnectedWorker): void {
    for (const [peerId, worker] of this.workers) {
      if (worker === keep || worker.descriptor.deviceId !== keep.descriptor.deviceId) continue;
      if (worker.slotId) this.scheduler.removeWorker(worker.slotId);
      worker.peer.close();
      this.workers.delete(peerId);
    }
  }

  private async handleChallengeResponse(worker: ConnectedWorker, nonce: string, signatureBase64: string): Promise<void> {
    if (!worker.challengeNonce || nonce !== worker.challengeNonce) return;
    const verified = await verifyChallenge(worker.descriptor.publicKeyJwk, nonce, signatureBase64);
    if (!verified) {
      worker.snapshot.state = "offline";
      await worker.peer.protocol?.send(createSwarmMessage("worker-draining", { reason: "identity-proof-failed" }));
      worker.peer.close();
      this.emitChange();
      return;
    }
    const existing = this.trusted.get(worker.descriptor.deviceId);
    const slotId = existing?.slotId ?? `worker-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    this.trusted.set(worker.descriptor.deviceId, {
      deviceId: worker.descriptor.deviceId,
      publicKeyJwk: worker.descriptor.publicKeyJwk,
      slotId,
      label: worker.descriptor.label,
    });
    this.saveTrust();
    this.dropStaleConnections(worker);
    worker.slotId = slotId;
    worker.snapshot.slotId = slotId;
    worker.snapshot.state = "connected";
    this.scheduler.registerWorker({ slotId, score: 1, reliability: 1, connected: true });
    this.emitChange();
    // Score the worker now; otherwise available compute stays at 1.0x local until the first
    // distributable preview job happens to be submitted.
    this.requestBenchmarks(createBenchmarkJob(this.options.runtimeVersion));
    this.pumpJobs();
  }

  private async handleResult(worker: ConnectedWorker, result: SwarmRenderResult): Promise<void> {
    const waiter = this.jobs.get(result.jobId);
    const job = this.scheduler.get(result.jobId);
    const valid = job !== undefined && validateSwarmRenderResult(result, {
      jobId: result.jobId,
      renderRevision: job.renderRevision,
      compositionId: job.compositionId,
      frame: job.frameStart,
      profile: job.profile,
      runtimeVersion: job.runtimeVersion,
    });
    // The frame missed its deadline and was rendered locally instead, but it is still a valid
    // frame for this revision: cache it rather than throwing the worker's effort away.
    if (!waiter && valid) {
      this.metrics.noteRemoteFrame();
      this.options.onLateResult?.(result);
      worker.snapshot.currentJobId = undefined;
      this.pumpJobs();
      return;
    }
    if (!waiter || !job || !worker.slotId || !validateSwarmRenderResult(result, {
      jobId: result.jobId,
      renderRevision: job.renderRevision,
      compositionId: job.compositionId,
      frame: job.frameStart,
      profile: job.profile,
      runtimeVersion: job.runtimeVersion,
    })) {
      this.metrics.noteStaleResult();
      return;
    }
    if (!this.scheduler.commit(result.jobId, worker.slotId)) return;
    this.metrics.noteRemoteFrame();
    window.clearTimeout(waiter.timeoutId);
    this.jobs.delete(result.jobId);
    worker.snapshot.currentJobId = undefined;
    waiter.resolve(result);
    this.pumpJobs();
    this.emitChange();
  }

  private handlePeerState(worker: ConnectedWorker, state: RTCPeerConnectionState | "connected" | "disconnected"): void {
    if (state === "connected") {
      worker.snapshot.state = "connecting";
    } else if (state === "disconnected" || state === "failed" || state === "closed") {
      worker.snapshot.state = "reconnecting";
      if (worker.slotId) {
        this.scheduler.removeWorker(worker.slotId);
        worker.snapshot.currentJobId = undefined;
      }
      window.setTimeout(() => {
        if (worker.snapshot.state === "reconnecting") {
          worker.snapshot.state = "offline";
          this.emitChange();
        }
      }, 10_000);
    }
    this.emitChange();
  }

  private async sendSignal(peerId: string, signal: SwarmSignal): Promise<void> {
    const worker = this.workers.get(peerId);
    if (!worker) return;
    await this.options.backend.sendSignal(this.options.session.sessionId, this.options.hostPeerId, peerId, signal);
    this.metrics.noteSignalingRequest();
  }

  private handleSignalingEvent(event: SwarmSignalingEvent): void {
    if (event.type === "peer-join-request") {
      this.pending.set(event.peer.peerId, event.peer);
      this.emitChange();
      // Re-approving a device that was already approved in this session adds no safety and makes
      // every reconnect need a human.
      if (this.trusted.has(event.peer.deviceId)) void this.approveWorker(event.peer.peerId, true);
      return;
    }
    if (event.type === "signal") {
      const worker = this.workers.get(event.fromPeerId);
      if (worker) void worker.peer.applySignal(event.payload);
      return;
    }
    if (event.type === "peer-left") {
      const worker = this.workers.get(event.peerId);
      if (worker) this.handlePeerState(worker, "disconnected");
      return;
    }
    if (event.type === "session-expired") {
      for (const worker of this.workers.values()) worker.snapshot.state = "offline";
      this.emitChange();
    }
  }

  private loadTrust(): void {
    try {
      const raw = localStorage.getItem(this.trustKey());
      const values = raw ? JSON.parse(raw) as TrustedWorker[] : [];
      for (const value of values) this.trusted.set(value.deviceId, value);
    } catch {
      /* trust is best effort and session-local */
    }
  }

  private saveTrust(): void {
    try { localStorage.setItem(this.trustKey(), JSON.stringify([...this.trusted.values()])); } catch { /* ignore */ }
  }

  private trustKey(): string {
    return `mafter-render-swarm-trust:${this.options.session.sessionId}`;
  }

  private emitChange(): void {
    this.metrics.setJobs(this.scheduler.getSnapshot().pending, this.scheduler.getSnapshot().leased);
    for (const listener of this.listeners) listener();
  }
}
