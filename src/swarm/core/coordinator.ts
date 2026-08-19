import { Ewma, normalizedBenchmarkScore } from "./benchmark";
import { getHostRenderCost, hostMsPerFrame } from "../../runtime/hostRenderCost";
import { isSwarmJobSelfContained } from "./jobFiles";
import { ResultChunkAssembler, splitAssetIntoChunks } from "../transport/assetChunks";
import { isWorkerCompatible } from "./capability";
import { createChallengeNonce, verifyChallenge, type DeviceIdentity } from "./identity";
import { createSwarmMessage, isSwarmMessageType } from "./protocol";
import { SwarmMetrics } from "./metrics";
import { SwarmScheduler } from "./scheduler";
import { validateSwarmRenderResult } from "./cacheKey";
import { WebRtcPeer } from "../transport/WebRtcPeer";
import { ackBudgetMs, classifyWatchdogFailure, renderStallBudgetMs, transferStallBudgetMs } from "./liveness";
import type { SwarmSignalingBackend } from "../signaling/SignalingBackend";
import type {
  SwarmMessageEnvelope,
  SwarmHelloPayload,
  SwarmAssetManifestReadyPayload,
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
  SwarmJobFailureReason,
  SwarmJobPhase,
  SwarmHostTiming,
  SwarmJobTimeline,
  WorkerSnapshot,
} from "./types";

/** Legacy caller budget. It is an opportunity-cost hint, not the job deadline. */
export const SWARM_DEFAULT_JOB_TIMEOUT_MS = 4_000;
export const SWARM_HARD_DEADLINE_CEILING_MS = 30_000;
export const SWARM_BOOTSTRAP_SAFETY_FACTOR = 1.5;
// Signaling can take several long-poll turns before ICE completes. This is a connection TTL,
// not a render/job deadline; keep it bounded without making a healthy remote peer retry mid-ICE.
export const SWARM_HANDSHAKE_TIMEOUT_MS = 45_000;
export const SWARM_WATCHDOG_INTERVAL_MS = 250;

let assetManifestCounter = 0;

function newAssetManifestGeneration(): string {
  assetManifestCounter += 1;
  return `asset-manifest-${Date.now()}-${assetManifestCounter}`;
}

function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

function hostNow(): number {
  return performance.now();
}

function emptyHostTiming(): SwarmHostTiming {
  return {
    queueWaitMs: 0,
    assetReadyWaitMs: 0,
    offerToAckMs: 0,
    firstChunkLatencyMs: 0,
    transferMs: 0,
    transferredBytes: 0,
    reassemblyMs: 0,
    base64DecodeMs: 0,
    zipDecodeMs: 0,
    pngDecodeMs: 0,
    verificationMs: 0,
    adoptionDelayMs: 0,
  };
}

interface PendingJob {
  job: SwarmRenderJob;
  resolve: (result: SwarmRenderResult | null) => void;
  offeredAt: number;
  queuedAtMs: number;
  offerPreparationStartedAtMs?: number;
  offerSentAtMs?: number;
  acceptedAt?: number;
  acceptedAtMs?: number;
  lastProgressAt?: number;
  firstResultChunkAt?: number;
  lastResultChunkAt?: number;
  firstResultChunkAtMs?: number;
  lastResultChunkAtMs?: number;
  resultCompletedAtMs?: number;
  assetReadyWaitMs: number;
  reassemblyMs: number;
  verificationMs: number;
  renderedFrames: number;
  phase: SwarmJobPhase;
  hardDeadlineAt: number;
  callerBudgetMs?: number;
  ackDeadlineAt: number;
  renderBudgetMs: number;
  transferBudgetMs: number;
  workerSlotId?: string;
  probe: boolean;
  settled: boolean;
  settledAt?: number;
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
  /** Measured cost of one real frame on this worker, smoothed across jobs. */
  renderMsPerFrame: Ewma;
  transportMsPerFrame: Ewma;
  ackRttMs: Ewma;
  probeCompleted: boolean;
  failureCount: number;
  handshakeTimer: number | null;
  snapshot: WorkerSnapshot;
  /** Content hashes the worker has acknowledged after hash verification and cache insertion. */
  cachedAssetHashes: Set<string>;
  /** One in-flight transfer promise per content hash; concurrent callers share the same send. */
  assetInflight: Map<string, Promise<boolean>>;
  /** Resolves when the worker has finished verifying a content-addressed transfer. */
  assetReadyWaiters: Map<string, (ok: boolean) => void>;
  /** Resolves after the worker reports the cache state for a manifest generation. */
  assetManifestStateWaiters: Map<string, (cachedContentHashes: string[]) => void>;
  /** Resolves only after the worker has validated the complete manifest against its LRU. */
  assetManifestReadyWaiters: Map<string, (payload: SwarmAssetManifestReadyPayload) => void>;
  /** Serializes manifest handshakes so a concurrent preload cannot overwrite its generation. */
  assetSyncInFlight: Promise<boolean> | null;
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
      this.watchJobs(Date.now());
      this.pumpJobs();
      this.emitChange();
    }, SWARM_WATCHDOG_INTERVAL_MS);
  }

  stop(): void {
    this.unsubscribeSignaling?.();
    this.unsubscribeSignaling = null;
    if (this.leaseTimer !== null) window.clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    for (const worker of this.workers.values()) {
      if (worker.handshakeTimer !== null) window.clearTimeout(worker.handshakeTimer);
      this.cancelAssetInflight(worker);
      worker.peer.close();
    }
    this.workers.clear();
    this.pending.clear();
    for (const job of this.jobs.values()) if (!job.settled) job.resolve(null);
    this.jobs.clear();
    this.resultChunks.clear();
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
    this.metrics.setHostRenderStats(getHostRenderCost().frames);
    return this.metrics.snapshot();
  }

  getAvailableCompute(): number {
    let total = 1;
    for (const worker of this.workers.values()) {
      if (worker.snapshot.state !== "ready") continue;
      if (worker.snapshot.performance?.measurement !== "measured") continue;
      total += worker.snapshot.performance.benchmarkScore;
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
        renderMsPerFrame: new Ewma(),
        transportMsPerFrame: new Ewma(),
        ackRttMs: new Ewma(),
        probeCompleted: false,
        failureCount: 0,
        handshakeTimer: null,
        snapshot: {
          slotId: `pending-${peer.peerId}`,
          peerId: peer.peerId,
          deviceId: peer.deviceId,
          label: peer.label,
          state: "connecting",
          health: "unknown",
          transport: "unknown",
        },
        cachedAssetHashes: new Set<string>(),
        assetInflight: new Map<string, Promise<boolean>>(),
        assetReadyWaiters: new Map<string, (ok: boolean) => void>(),
        assetManifestStateWaiters: new Map<string, (cachedContentHashes: string[]) => void>(),
        assetManifestReadyWaiters: new Map<string, (payload: SwarmAssetManifestReadyPayload) => void>(),
        assetSyncInFlight: null,
      };
      this.workers.set(peer.peerId, worker);
      worker.handshakeTimer = window.setTimeout(() => {
        if (worker.slotId !== undefined || !this.workers.has(peer.peerId)) return;
        this.removeWorkerConnection(worker, "no-ack");
      }, SWARM_HANDSHAKE_TIMEOUT_MS);
      webRtc.onSignal = (signal) => void this.sendSignal(peer.peerId, signal);
      webRtc.onMessage = (message) => void this.handleWorkerMessage(worker, message);
      webRtc.onStateChange = (state) => {
        this.handlePeerState(worker, state);
      };
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
  async preloadAssets(assets: SwarmAssetTransfer[]): Promise<boolean> {
    const eligible = [...this.workers.values()].filter((worker) => this.canSyncAssets(worker));
    const results = await Promise.all(eligible.map((worker) => {
      const previous = worker.assetSyncInFlight ?? Promise.resolve(true);
      const sync = (async (): Promise<boolean> => {
        // A failed generation must not poison the dirty queue; the next snapshot is the recovery attempt.
        await previous.catch(() => false);
        return await this.syncWorkerAssets(worker, assets);
      })();
      worker.assetSyncInFlight = sync;
      void sync.then(() => {
        if (worker.assetSyncInFlight === sync) worker.assetSyncInFlight = null;
      }, () => {
        if (worker.assetSyncInFlight === sync) worker.assetSyncInFlight = null;
      });
      return sync;
    }));
    this.pumpJobs();
    this.emitChange();
    return results.length > 0 && results.every(Boolean);
  }

  private async syncWorkerAssets(worker: ConnectedWorker, assets: SwarmAssetTransfer[]): Promise<boolean> {
    const generation = newAssetManifestGeneration();
    const protocol = worker.peer.protocol;
    if (!protocol) return false;
    const manifestState = new Promise<string[]>((resolve) => {
      worker.assetManifestStateWaiters.set(generation, resolve);
    });
    const manifestReady = new Promise<SwarmAssetManifestReadyPayload>((resolve) => {
      worker.assetManifestReadyWaiters.set(generation, resolve);
    });
    worker.snapshot.state = "syncing";
    const results: boolean[] = [];
    try {
      await protocol.send(createSwarmMessage("asset-manifest", {
        generation,
        assets: assets.map((asset) => ({
          contentHash: asset.contentHash,
          byteLength: base64ByteLength(asset.bytesBase64),
        })),
      }));
      worker.cachedAssetHashes = new Set(await manifestState);
      // Keep one ordered file stream on the data channel. ensureAsset remains promise-shared, so
      // concurrent callers still coalesce, but a preload cannot interleave two large files.
      for (const asset of assets) results.push(await this.ensureAsset(worker, asset));
      if (!results.every(Boolean)) {
        worker.snapshot.health = "degraded";
        return false;
      }
      await protocol.send(createSwarmMessage("asset-sync-complete", { generation }));
      const ready = await manifestReady;
      worker.cachedAssetHashes = new Set(ready.cachedContentHashes);
      if (!ready.ok || !assets.every((asset) => worker.cachedAssetHashes.has(asset.contentHash))) {
        worker.snapshot.health = "degraded";
        return false;
      }
      worker.snapshot.state = "ready";
      return true;
    } catch {
      worker.snapshot.health = "degraded";
      return false;
    } finally {
      worker.assetManifestStateWaiters.delete(generation);
      worker.assetManifestReadyWaiters.delete(generation);
    }
  }

  hasAvailableWorker(): boolean {
    return [...this.workers.values()].some((worker) => this.isWorkerReady(worker));
  }

  /** Dispatches work only when a worker can beat, or is allowed to probe against, local work. */
  async renderPreviewFrame(job: SwarmRenderJob, timeoutMs?: number): Promise<SwarmRenderResult | null> {
    if (!this.hasAvailableWorker()) return null;
    if (!this.isEligibleJob(job)) {
      this.metrics.noteIneligibleJob();
      return null;
    }
    if (!this.canDispatchJob(job)) return null;
    this.scheduler.enqueue(job);
    const result = await new Promise<SwarmRenderResult | null>((resolve) => {
      this.jobs.set(job.id, {
        job,
        resolve,
        offeredAt: 0,
        queuedAtMs: hostNow(),
        phase: "queued",
        hardDeadlineAt: 0,
        ackDeadlineAt: 0,
        renderBudgetMs: 0,
        transferBudgetMs: 0,
        assetReadyWaitMs: 0,
        reassemblyMs: 0,
        verificationMs: 0,
        renderedFrames: 0,
        probe: false,
        settled: false,
        ...(timeoutMs !== undefined && timeoutMs > 0 ? { callerBudgetMs: timeoutMs } : {}),
      });
      this.pumpJobs();
    });
    return result;
  }

  /**
   * Ends a job that cannot be delivered. Without this the caller keeps waiting for the full
   * deadline even though the frame is already known to be lost.
   */
  private releaseJob(worker: ConnectedWorker, jobId: SwarmJobId, reason: SwarmJobFailureReason = "worker-failed"): void {
    this.resultChunks.drop(jobId);
    if (worker.snapshot.currentJobId === jobId) worker.snapshot.currentJobId = undefined;
    const waiter = this.jobs.get(jobId);
    const newlySettled = Boolean(waiter && !waiter.settled);
    if (waiter && !waiter.settled) {
      this.noteFailedJobTimeline(worker, waiter, reason);
      waiter.settled = true;
      waiter.settledAt = Date.now();
      waiter.phase = "completed";
      this.scheduler.abandon(jobId);
      this.metrics.noteLocalFallback();
      waiter.resolve(null);
    }
    // A watchdog may have already reclaimed this job; its later job-failed is a completion signal,
    // not a second worker failure. Avoid charging the same incident twice.
    if (newlySettled || !waiter) this.noteWorkerFailure(worker, reason);
    this.pumpJobs();
    this.emitChange();
  }

  private isWorkerReady(worker: ConnectedWorker): worker is ConnectedWorker & { slotId: string } {
    return worker.slotId !== undefined
      && worker.snapshot.state === "ready"
      && worker.snapshot.health !== "unusable"
      && worker.snapshot.available !== false;
  }

  private canSyncAssets(worker: ConnectedWorker): boolean {
    return worker.slotId !== undefined
      && (worker.snapshot.state === "syncing" || worker.snapshot.state === "ready")
      && worker.snapshot.health !== "unusable"
      && worker.snapshot.available !== false;
  }

  /** Sends an asset once and resolves only after the worker has verified and cached it. */
  private ensureAsset(worker: ConnectedWorker, asset: SwarmAssetTransfer): Promise<boolean> {
    if (worker.cachedAssetHashes.has(asset.contentHash)) return Promise.resolve(true);
    if (!asset.bytesBase64) return Promise.resolve(false);
    const existing = worker.assetInflight.get(asset.contentHash);
    if (existing) return existing;

    let resolveReady!: (ok: boolean) => void;
    const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });
    const transfer = (async () => {
      worker.assetReadyWaiters.set(asset.contentHash, resolveReady);
      try {
        const protocol = worker.peer.protocol;
        if (!protocol) return false;
        for (const chunk of splitAssetIntoChunks(asset)) {
          await protocol.send(createSwarmMessage("asset-chunk", chunk));
        }
        const ok = await ready;
        if (ok) worker.cachedAssetHashes.add(asset.contentHash);
        return ok;
      } catch (error) {
        worker.assetReadyWaiters.delete(asset.contentHash);
        resolveReady(false);
        console.warn("[swarm] asset transfer failed", {
          worker: worker.snapshot.label,
          path: asset.path,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      } finally {
        if (worker.assetReadyWaiters.get(asset.contentHash) === resolveReady) worker.assetReadyWaiters.delete(asset.contentHash);
      }
    })();
    worker.assetInflight.set(asset.contentHash, transfer);
    void transfer.then(() => {
      if (worker.assetInflight.get(asset.contentHash) === transfer) worker.assetInflight.delete(asset.contentHash);
    });
    return transfer;
  }

  private cancelAssetInflight(worker: ConnectedWorker): void {
    for (const resolve of worker.assetReadyWaiters.values()) resolve(false);
    worker.assetReadyWaiters.clear();
    for (const resolve of worker.assetManifestStateWaiters.values()) resolve([]);
    worker.assetManifestStateWaiters.clear();
    for (const [generation, resolve] of worker.assetManifestReadyWaiters) {
      resolve({ generation, ok: false, cachedContentHashes: [], message: "Worker connection closed" });
    }
    worker.assetManifestReadyWaiters.clear();
  }

  private isEligibleJob(job: SwarmRenderJob): boolean {
    const comp = job.project.compositions.find((candidate) => candidate.id === job.compositionId);
    if (!comp || comp.kind !== "timeline") return false;
    // Assets and expression scripts are allowed as long as their bytes travel with the job; a job
    // whose footage or script could not be attached renders locally instead of losing content.
    return isSwarmJobSelfContained(job, comp);
  }

  /**
   * Streams any not-yet-delivered footage as chunks, then offers the job carrying references only.
   * Sending bytes inline on every job would re-transmit the same file for each frame and would cap
   * footage at one data-channel message.
   */
  private async offerJob(worker: ConnectedWorker, job: SwarmRenderJob): Promise<void> {
    const assets = job.assets ?? [];
    const pending = this.jobs.get(job.id);
    if (pending) pending.offerPreparationStartedAtMs = hostNow();
    const assetStartedAtMs = hostNow();
    let assetWaitRecorded = false;
    const recordAssetWait = (): void => {
      if (assetWaitRecorded) return;
      assetWaitRecorded = true;
      if (pending) pending.assetReadyWaitMs += Math.max(0, hostNow() - assetStartedAtMs);
    };
    try {
      for (const asset of assets) {
        if (!await this.ensureAsset(worker, asset)) throw new Error(`Worker did not cache asset: ${asset.path}`);
      }
      const references = assets.map((asset) => ({ ...asset, bytesBase64: "" }));
      if (pending && !pending.settled) {
        pending.offerSentAtMs = hostNow();
        pending.offeredAt = Date.now();
        pending.phase = "offered";
        pending.ackDeadlineAt = pending.offeredAt + ackBudgetMs(worker.ackRttMs.get() ?? undefined);
      }
      await worker.peer.protocol?.send(createSwarmMessage("job-offer", { job: { ...job, assets: references } }));
    } catch {
      recordAssetWait();
      if (worker.slotId) this.scheduler.fail(job.id, worker.slotId);
      this.releaseJob(worker, job.id, "worker-failed");
    } finally {
      recordAssetWait();
    }
  }

  private frameCount(job: SwarmRenderJob): number {
    return Math.max(1, job.frameEnd - job.frameStart);
  }

  private predictedLocalMs(job: SwarmRenderJob, pending?: PendingJob): number {
    const measured = hostMsPerFrame();
    if (measured !== null) return measured * this.frameCount(job);
    if (pending?.callerBudgetMs !== undefined && pending.callerBudgetMs > 0) return pending.callerBudgetMs;
    return SWARM_DEFAULT_JOB_TIMEOUT_MS;
  }

  private shouldUseWorker(worker: ConnectedWorker, job: SwarmRenderJob): boolean {
    if (!this.isWorkerReady(worker) || worker.snapshot.currentJobId) return false;
    const performance = worker.snapshot.performance;
    const measurement = performance?.measurement ?? "unknown";
    if (measurement !== "measured") {
      // A playhead request is critical path work. Unknown workers get one background/visible probe,
      // never the frame the user is waiting to see.
      return !worker.probeCompleted && job.priority !== "playhead" && job.priority !== "upcoming";
    }
    const workerMs = worker.renderMsPerFrame.get();
    const localMs = hostMsPerFrame();
    if (workerMs === null || localMs === null) return true;
    const frames = this.frameCount(job);
    const transportMs = (worker.transportMsPerFrame.get() ?? 0) * frames;
    return workerMs * frames + transportMs < localMs * frames;
  }

  private canDispatchJob(job: SwarmRenderJob): boolean {
    return [...this.workers.values()].some((worker) => this.shouldUseWorker(worker, job));
  }

  private configurePendingJob(worker: ConnectedWorker, pending: PendingJob, now: number): void {
    const frames = this.frameCount(pending.job);
    const measuredRenderMs = worker.renderMsPerFrame.get();
    const localBlockCost = this.predictedLocalMs(pending.job, pending);
    const predictedRenderMs = measuredRenderMs === null
      ? localBlockCost * SWARM_BOOTSTRAP_SAFETY_FACTOR
      : measuredRenderMs * frames;
    const predictedTransportMs = (worker.transportMsPerFrame.get() ?? 250) * frames;
    const ackMs = ackBudgetMs(worker.ackRttMs.get() ?? undefined);
    const softDeadline = Math.max(ackMs + 1_000, predictedRenderMs + predictedTransportMs + 1_000);
    const callerBudget = pending.callerBudgetMs;
    const bounded = callerBudget !== undefined && callerBudget > 0
      ? Math.min(softDeadline, Math.max(ackMs + 1_000, callerBudget))
      : softDeadline;
    pending.hardDeadlineAt = now + Math.min(SWARM_HARD_DEADLINE_CEILING_MS, bounded);
    pending.renderBudgetMs = renderStallBudgetMs(predictedRenderMs);
    pending.transferBudgetMs = transferStallBudgetMs(predictedTransportMs);
    pending.probe = (worker.snapshot.performance?.measurement ?? "unknown") !== "measured";
    pending.workerSlotId = worker.slotId;
    if (pending.probe) {
      worker.snapshot.performance = {
        measurement: "probing",
        benchmarkScore: 0,
        recentFramesPerSecond: 0,
        recentRenderMs: 0,
        reliability: worker.snapshot.performance?.reliability ?? 1,
        lastUpdatedAt: now,
      };
      worker.snapshot.health = "probing";
      this.metrics.noteProbeStarted();
    }
  }

  /**
   * Re-scores a worker from the block it just rendered. The synthetic benchmark measures an empty
   * 320x180 comp, which is not the workload being distributed — a worker once scored 2.7x local on
   * it while being 1.4x slower than the host on the real composition. A completed job carries the
   * worker's own render time for real frames, and `hostMsPerFrame()` is this machine's cost for the
   * same frames, so the ratio is finally quoted in the same units.
   *
   * Render time only. Transport is a property of the link, not of the worker's capacity, and it is
   * the scheduler's job (WP §25) to price it.
   */
  private scoreFromRealWork(worker: ConnectedWorker, result: SwarmRenderResult): boolean {
    const frames = Math.max(1, result.frameEnd - result.frameStart);
    const localMs = hostMsPerFrame();
    if (result.renderMs === undefined || result.renderMs <= 0) return false;
    const workerMs = worker.renderMsPerFrame.update(result.renderMs / frames);
    if (workerMs <= 0) return false;
    const score = localMs === null
      ? (worker.snapshot.performance?.benchmarkScore ?? 1)
      : normalizedBenchmarkScore(1 / workerMs, 1 / localMs);
    const previousReliability = worker.snapshot.performance?.reliability ?? 1;
    worker.snapshot.performance = {
      benchmarkScore: score,
      measurement: "measured",
      measured: true,
      estimatedScore: worker.snapshot.performance?.estimatedScore,
      recentFramesPerSecond: 1000 / workerMs,
      recentRenderMs: workerMs,
      reliability: previousReliability,
      lastUpdatedAt: Date.now(),
    };
    worker.probeCompleted = true;
    if (worker.snapshot.health !== "unusable") {
      worker.snapshot.health = "healthy";
      worker.failureCount = 0;
    }
    if (worker.slotId) {
      this.scheduler.updateWorker({
        slotId: worker.slotId,
        score,
        reliability: worker.snapshot.performance.reliability,
        connected: true,
      });
    }
    return true;
  }

  private learnTransportCost(worker: ConnectedWorker, pending: PendingJob): void {
    // Only the host-side transfer/reassembly interval is scheduler transport evidence. Worker
    // render duration uses a different clock and must never be subtracted from a host timestamp.
    if (pending.firstResultChunkAtMs === undefined || pending.lastResultChunkAtMs === undefined) return;
    const transportMs = Math.max(0, pending.lastResultChunkAtMs - pending.firstResultChunkAtMs) + pending.reassemblyMs;
    worker.transportMsPerFrame.update(transportMs / this.frameCount(pending.job));
  }

  private pumpJobs(): void {
    for (const worker of this.workers.values()) {
      if (!this.isWorkerReady(worker) || worker.snapshot.currentJobId) continue;
      const next = this.scheduler.peekNextPending();
      if (!next || !this.shouldUseWorker(worker, next)) continue;
      const pending = this.jobs.get(next.id);
      if (!pending || pending.settled) continue;
      const now = Date.now();
      this.configurePendingJob(worker, pending, now);
      // The lease is only a stale-result guard. The liveness watchdog below owns reclaim timing.
      const leased = this.scheduler.requestJob(worker.slotId, now, () => Math.max(1, pending.hardDeadlineAt - now));
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
    if (isSwarmMessageType(message, "asset-manifest-state")) {
      const resolve = worker.assetManifestStateWaiters.get(message.payload.generation);
      if (resolve) {
        worker.assetManifestStateWaiters.delete(message.payload.generation);
        resolve(message.payload.cachedContentHashes);
      }
      this.emitChange();
      return;
    }
    if (isSwarmMessageType(message, "asset-manifest-ready")) {
      const resolve = worker.assetManifestReadyWaiters.get(message.payload.generation);
      if (resolve) {
        worker.assetManifestReadyWaiters.delete(message.payload.generation);
        resolve(message.payload);
      }
      this.emitChange();
      return;
    }
    if (isSwarmMessageType(message, "asset-ready")) {
      const resolve = worker.assetReadyWaiters.get(message.payload.contentHash);
      if (resolve) {
        worker.assetReadyWaiters.delete(message.payload.contentHash);
        resolve(message.payload.ok);
      }
      this.emitChange();
      return;
    }
    if (isSwarmMessageType(message, "challenge-response")) {
      await this.handleChallengeResponse(worker, message.payload.nonce, message.payload.signatureBase64);
      return;
    }
    if (isSwarmMessageType(message, "job-accepted")) {
      const pending = this.jobs.get(message.payload.jobId);
      const now = Date.now();
      if (pending && !pending.settled) {
        const acceptedAtMs = hostNow();
        pending.acceptedAt = now;
        pending.acceptedAtMs = acceptedAtMs;
        pending.lastProgressAt = now;
        pending.phase = "accepted";
        worker.ackRttMs.update(Math.max(0, now - pending.offeredAt));
        worker.snapshot.health = worker.snapshot.health === "unknown" ? "probing" : worker.snapshot.health;
      }
      if (worker.slotId) this.scheduler.markRendering(message.payload.jobId, worker.slotId);
      this.emitChange();
      return;
    }
    if (isSwarmMessageType(message, "job-progress")) {
      const pending = this.jobs.get(message.payload.jobId);
      if (pending) {
        pending.renderedFrames = Math.max(
          pending.renderedFrames,
          Math.min(this.frameCount(pending.job), Math.max(0, Math.floor(message.payload.completedFrames))),
        );
      }
      if (pending && !pending.settled) {
        pending.lastProgressAt = Date.now();
        // A completed render is still not a transfer. Transfer starts only when the first result
        // chunk arrives; otherwise a worker that rendered but never uploaded is misclassified.
        pending.phase = "rendering";
      }
      if (worker.slotId) this.scheduler.markRendering(message.payload.jobId, worker.slotId);
      this.emitChange();
      return;
    }
    if (isSwarmMessageType(message, "job-result-chunk")) {
      const pending = this.jobs.get(message.payload.jobId);
      const now = Date.now();
      if (pending) {
        pending.firstResultChunkAt ??= now;
        pending.lastResultChunkAt = now;
        pending.firstResultChunkAtMs ??= hostNow();
        pending.lastResultChunkAtMs = hostNow();
        if (!pending.settled) {
          pending.lastProgressAt = now;
          pending.phase = "transferring";
        }
      }
      if (pending) this.resultChunks.accept(message.payload);
      else this.resultChunks.drop(message.payload.jobId);
      this.emitChange();
      return;
    }
    if (isSwarmMessageType(message, "job-result")) {
      const pending = this.jobs.get(message.payload.jobId);
      const inlineBytes = message.payload.bytesBase64;
      const reassemblyStartedAtMs = hostNow();
      const assembledBytes = inlineBytes || this.resultChunks.take(message.payload.jobId) || "";
      const assembledAtMs = hostNow();
      if (pending) {
        pending.resultCompletedAtMs = assembledAtMs;
        pending.reassemblyMs = inlineBytes
          ? 0
          : Math.max(0, assembledAtMs - reassemblyStartedAtMs);
      }
      const bytesBase64 = assembledBytes;
      await this.handleResult(worker, { ...message.payload, bytesBase64 });
      return;
    }
    if (isSwarmMessageType(message, "job-failed")) {
      // The worker already knows why it could not render this block, and the host is the only
      // place anyone is watching. Dropping the reason here cost several sessions of guessing at
      // failures that the worker had described precisely.
      console.warn("[swarm] worker declined a job", {
        worker: worker.snapshot.label,
        jobId: message.payload.jobId,
        reason: message.payload.message,
      });
      const reason = message.payload.reason ?? "worker-failed";
      if (worker.slotId) this.scheduler.fail(message.payload.jobId, worker.slotId);
      this.releaseJob(worker, message.payload.jobId, reason);
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
      this.cancelAssetInflight(worker);
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
    if (worker.handshakeTimer !== null) window.clearTimeout(worker.handshakeTimer);
    worker.handshakeTimer = null;
    worker.snapshot.state = "syncing";
    worker.snapshot.health = "unknown";
    this.scheduler.registerWorker({ slotId, score: 0, reliability: 1, connected: true });
    this.emitChange();
    this.pumpJobs();
  }

  private makeJobTimeline(
    worker: ConnectedWorker,
    pending: PendingJob,
    result: SwarmRenderResult,
    late: boolean,
  ): SwarmJobTimeline {
    const frames = Math.max(1, result.frameEnd - result.frameStart);
    const offerSentAtMs = pending.offerSentAtMs ?? pending.queuedAtMs;
    const completedAtMs = pending.resultCompletedAtMs ?? hostNow();
    const firstChunkAtMs = pending.firstResultChunkAtMs;
    const lastChunkAtMs = pending.lastResultChunkAtMs;
    const host: SwarmHostTiming = {
      ...emptyHostTiming(),
      queueWaitMs: Math.max(0, (pending.offerPreparationStartedAtMs ?? offerSentAtMs) - pending.queuedAtMs),
      assetReadyWaitMs: Math.max(0, pending.assetReadyWaitMs),
      offerToAckMs: pending.acceptedAtMs === undefined ? 0 : Math.max(0, pending.acceptedAtMs - offerSentAtMs),
      firstChunkLatencyMs: firstChunkAtMs === undefined ? 0 : Math.max(0, firstChunkAtMs - offerSentAtMs),
      transferMs: firstChunkAtMs === undefined || lastChunkAtMs === undefined
        ? 0
        : Math.max(0, lastChunkAtMs - firstChunkAtMs),
      transferredBytes: result.byteLength,
      reassemblyMs: Math.max(0, pending.reassemblyMs),
      verificationMs: Math.max(0, pending.verificationMs),
    };
    const timeline: SwarmJobTimeline = {
      jobId: result.jobId,
      frameStart: result.frameStart,
      frameEnd: result.frameEnd,
      ...(worker.slotId ? { workerSlotId: worker.slotId } : {}),
      ...(result.workerTiming ? { worker: { ...result.workerTiming } } : {}),
      ...(result.workerSeek ? { workerSeek: { ...result.workerSeek } } : {}),
      host,
      remoteWallMs: Math.max(0, completedAtMs - offerSentAtMs),
      // A complete valid result proves that every frame in the job was rendered even if the
      // throttled progress channel did not get a chance to report its final count.
      remoteRenderedFrames: frames,
      remoteReceivedFrames: frames,
      remoteAdoptedFrames: 0,
      verifiedRemoteFrames: frames,
      lateRemoteFrames: late ? frames : 0,
      complete: true,
    };
    result.hostTiming = host;
    result.timeline = timeline;
    return timeline;
  }

  private noteFailedJobTimeline(worker: ConnectedWorker | undefined, pending: PendingJob, reason: SwarmJobFailureReason): void {
    const now = hostNow();
    const offerSentAtMs = pending.offerSentAtMs ?? pending.queuedAtMs;
    const host: SwarmHostTiming = {
      ...emptyHostTiming(),
      queueWaitMs: Math.max(0, (pending.offerPreparationStartedAtMs ?? offerSentAtMs) - pending.queuedAtMs),
      assetReadyWaitMs: Math.max(0, pending.assetReadyWaitMs),
      offerToAckMs: pending.acceptedAtMs === undefined ? 0 : Math.max(0, pending.acceptedAtMs - offerSentAtMs),
      firstChunkLatencyMs: pending.firstResultChunkAtMs === undefined ? 0 : Math.max(0, pending.firstResultChunkAtMs - offerSentAtMs),
      transferMs: pending.firstResultChunkAtMs === undefined || pending.lastResultChunkAtMs === undefined
        ? 0
        : Math.max(0, pending.lastResultChunkAtMs - pending.firstResultChunkAtMs),
      transferredBytes: 0,
      reassemblyMs: pending.reassemblyMs,
      verificationMs: Math.max(0, pending.verificationMs),
    };
    this.metrics.noteJobTimeline({
      jobId: pending.job.id,
      frameStart: pending.job.frameStart,
      frameEnd: pending.job.frameEnd,
      ...(worker?.slotId ? { workerSlotId: worker.slotId } : {}),
      host,
      remoteWallMs: Math.max(0, now - offerSentAtMs),
      remoteRenderedFrames: Math.min(this.frameCount(pending.job), pending.renderedFrames),
      remoteReceivedFrames: 0,
      remoteAdoptedFrames: 0,
      verifiedRemoteFrames: 0,
      lateRemoteFrames: 0,
      complete: false,
      failureReason: reason,
    });
  }

  private async handleResult(worker: ConnectedWorker, result: SwarmRenderResult): Promise<void> {
    // The final metadata message closes the chunk stream. If it arrived with inline bytes or an
    // invalid/stale payload, no partial assembler entry may survive this job's lifecycle.
    this.resultChunks.drop(result.jobId);
    const waiter = this.jobs.get(result.jobId);
    const job = this.scheduler.get(result.jobId);
    const verificationStartedAtMs = hostNow();
    const valid = job !== undefined && validateSwarmRenderResult(result, {
      jobId: result.jobId,
      renderRevision: job.renderRevision,
      compositionId: job.compositionId,
      frame: job.frameStart,
      profile: job.profile,
      runtimeVersion: job.runtimeVersion,
    });
    if (waiter) waiter.verificationMs += Math.max(0, hostNow() - verificationStartedAtMs);
    // The frame missed its deadline and was rendered locally instead, but it is still a valid
    // frame for this revision: cache it rather than throwing the worker's effort away.
    if (waiter && waiter.settled && valid) {
      const frames = Math.max(1, result.frameEnd - result.frameStart);
      const timeline = this.makeJobTimeline(worker, waiter, result, true);
      this.metrics.noteLateValidResult(frames);
      this.metrics.noteJobTimeline(timeline);
      this.learnTransportCost(worker, waiter);
      if (this.scoreFromRealWork(worker, result) && waiter.probe) {
        waiter.probe = false;
        this.metrics.noteProbeSuccess();
      }
      this.options.onLateResult?.(result);
      if (worker.snapshot.currentJobId === result.jobId) worker.snapshot.currentJobId = undefined;
      this.pumpJobs();
      return;
    }
    if (waiter?.settled && !valid) {
      this.metrics.noteStaleResult();
      this.noteWorkerFailure(worker, "invalid-result");
      if (worker.snapshot.currentJobId === result.jobId) {
        worker.snapshot.currentJobId = undefined;
        this.pumpJobs();
      }
      this.emitChange();
      return;
    }
    if (!waiter || waiter.settled || !job || !worker.slotId || !valid) {
      if (waiter && !waiter.settled && worker.slotId) {
        this.scheduler.fail(result.jobId, worker.slotId);
        this.releaseJob(worker, result.jobId, "invalid-result");
        return;
      }
      this.metrics.noteStaleResult();
      if (worker.snapshot.currentJobId === result.jobId) {
        worker.snapshot.currentJobId = undefined;
        this.pumpJobs();
      }
      this.emitChange();
      return;
    }
    if (!this.scheduler.commit(result.jobId, worker.slotId)) {
      if (worker.snapshot.currentJobId === result.jobId) {
        worker.snapshot.currentJobId = undefined;
        this.pumpJobs();
      }
      this.emitChange();
      return;
    }
    const timeline = this.makeJobTimeline(worker, waiter, result, false);
    this.metrics.noteJobTimeline(timeline);
    this.learnTransportCost(worker, waiter);
    if (this.scoreFromRealWork(worker, result) && waiter.probe) {
      waiter.probe = false;
      this.metrics.noteProbeSuccess();
    }
    waiter.settled = true;
    waiter.settledAt = Date.now();
    waiter.phase = "completed";
    worker.snapshot.currentJobId = undefined;
    waiter.resolve(result);
    this.pumpJobs();
    this.emitChange();
  }

  private handlePeerState(worker: ConnectedWorker, state: RTCPeerConnectionState | "connected" | "disconnected"): void {
    if (state === "connected") {
      if (worker.snapshot.state === "connecting") worker.snapshot.state = "authenticating";
    } else if (state === "disconnected" || state === "failed" || state === "closed") {
      worker.snapshot.state = "reconnecting";
      worker.snapshot.health = "degraded";
      this.cancelAssetInflight(worker);
      if (worker.slotId) {
        const jobId = worker.snapshot.currentJobId;
        if (jobId) {
          this.failJob(worker, jobId, "disconnected");
          this.noteWorkerFailure(worker, "disconnected");
        }
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

  private noteWorkerFailure(worker: ConnectedWorker, reason: SwarmJobFailureReason): void {
    worker.failureCount += 1;
    if (worker.snapshot.performance?.measurement !== "measured") worker.probeCompleted = true;
    const reliability = Math.max(0, (worker.snapshot.performance?.reliability ?? 1) * 0.5);
    worker.snapshot.lastFailure = reason;
    worker.snapshot.health = reason === "invalid-result" || worker.failureCount >= 2 ? "unusable" : "degraded";
    worker.snapshot.performance = {
      measurement: worker.snapshot.performance?.measurement ?? "unknown",
      benchmarkScore: 0,
      estimatedScore: worker.snapshot.performance?.estimatedScore,
      recentFramesPerSecond: worker.snapshot.performance?.recentFramesPerSecond ?? 0,
      recentRenderMs: worker.snapshot.performance?.recentRenderMs ?? 0,
      reliability,
      lastUpdatedAt: Date.now(),
    };
    this.metrics.noteJobFailure(reason);
    if (worker.snapshot.health === "unusable" && worker.slotId) this.scheduler.removeWorker(worker.slotId);
  }

  private failJob(worker: ConnectedWorker, jobId: SwarmJobId, reason: SwarmJobFailureReason = "worker-failed"): void {
    const pending = this.jobs.get(jobId);
    if (!pending || pending.settled) return;
    pending.settled = true;
    pending.settledAt = Date.now();
    pending.phase = "completed";
    this.noteFailedJobTimeline(worker, pending, reason);
    this.scheduler.abandon(jobId);
    this.resultChunks.dropPartial(jobId);
    // The WorkerRuntime has no cancellation guarantee yet. Keep its current job id so the
    // scheduler quarantines this worker until the late result or failure proves the render ended.
    if (worker.snapshot.currentJobId === undefined) worker.snapshot.currentJobId = jobId;
    this.metrics.noteLocalFallback();
    pending.resolve(null);
  }

  /** Separates no-ACK, render stall, transfer stall, and hard deadline instead of charging one
   * opaque 60-second timer. Settled jobs stay briefly for valid late-result measurement. */
  private watchJobs(now: number): void {
    for (const pending of this.jobs.values()) {
      if (pending.settled) {
        if (pending.settledAt !== undefined && now - pending.settledAt > 60_000) {
          this.resultChunks.drop(pending.job.id);
          this.jobs.delete(pending.job.id);
        }
        continue;
      }
      const worker = pending.workerSlotId
        ? [...this.workers.values()].find((candidate) => candidate.slotId === pending.workerSlotId)
        : undefined;
      const failure = classifyWatchdogFailure(pending, now, {
        renderMs: pending.renderBudgetMs,
        transferMs: pending.transferBudgetMs,
      });
      if (!failure) continue;
      if (worker) {
        this.failJob(worker, pending.job.id, failure);
        this.noteWorkerFailure(worker, failure);
      } else {
        this.noteFailedJobTimeline(undefined, pending, failure);
        pending.settled = true;
        pending.settledAt = now;
        pending.phase = "completed";
        this.scheduler.abandon(pending.job.id);
        this.metrics.noteLocalFallback();
        this.metrics.noteJobFailure(failure);
        pending.resolve(null);
      }
      this.emitChange();
    }
  }

  private removeWorkerConnection(worker: ConnectedWorker, reason: SwarmJobFailureReason): void {
    if (worker.handshakeTimer !== null) window.clearTimeout(worker.handshakeTimer);
    worker.handshakeTimer = null;
    this.cancelAssetInflight(worker);
    worker.snapshot.state = "offline";
    worker.snapshot.health = "unusable";
    if (worker.snapshot.currentJobId) this.failJob(worker, worker.snapshot.currentJobId, reason);
    if (worker.slotId) this.scheduler.removeWorker(worker.slotId);
    worker.peer.close();
    for (const [peerId, candidate] of this.workers) if (candidate === worker) this.workers.delete(peerId);
    this.noteWorkerFailure(worker, reason);
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
      // A worker that re-asks gets a new peer id and abandons the old one. Keeping the old entry
      // leaves the panel listing Offline workers and, worse, lets the scheduler lease frames to a
      // peer nobody is listening on. Only a connection that has proved its identity is kept.
      for (const [peerId, worker] of this.workers) {
        if (worker.descriptor.deviceId !== event.peer.deviceId || worker.slotId !== undefined) continue;
        worker.peer.close();
        this.workers.delete(peerId);
      }
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
