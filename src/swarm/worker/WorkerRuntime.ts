import { collectWorkerCapabilities } from "../core/capability";
import { loadOrCreateDeviceIdentity, signChallenge, type DeviceIdentity } from "../core/identity";
import { createSwarmMessage, isSwarmMessageType } from "../core/protocol";
import { WebRtcPeer } from "../transport/WebRtcPeer";
import { AssetChunkAssembler, splitResultBytes } from "../transport/assetChunks";
import type { SwarmSignalingBackend } from "../signaling/SignalingBackend";
import { WorkerRenderExecutor } from "./workerRenderExecutor";
import type { SwarmRenderResult, SwarmSessionDescriptor, SwarmPeerDescriptor, SwarmSignalingEvent } from "../core/types";

export interface WorkerRuntimeOptions {
  backend: SwarmSignalingBackend;
  identity?: DeviceIdentity;
  label: string;
  executor?: WorkerRenderExecutor;
}

type SwarmFaultMode = "no-ack" | "accepted-hang" | "transfer-stall" | "slow-late";

interface SwarmFaultInjection {
  mode: SwarmFaultMode;
  delayMs?: number;
}

function devFaultInjection(): SwarmFaultInjection | null {
  if (!import.meta.env.DEV) return null;
  const value = (globalThis as { __mafterSwarmFault?: unknown }).__mafterSwarmFault;
  if (!value || typeof value !== "object") return null;
  const mode = (value as { mode?: unknown }).mode;
  if (mode !== "no-ack" && mode !== "accepted-hang" && mode !== "transfer-stall" && mode !== "slow-late") return null;
  const delayMs = (value as { delayMs?: unknown }).delayMs;
  return { mode, ...(typeof delayMs === "number" && Number.isFinite(delayMs) ? { delayMs } : {}) };
}

/** How long a worker waits for approval before asking again with a fresh peer id. */
const WORKER_APPROVAL_TIMEOUT_MS = 45_000;

export type WorkerRuntimeState = "idle" | "joining" | "waiting-approval" | "connecting" | "authenticating" | "syncing" | "ready" | "connected" | "rendering" | "stopped" | "error";

export class WorkerRuntime {
  private readonly backend: SwarmSignalingBackend;
  private readonly executor: WorkerRenderExecutor;
  private identity: DeviceIdentity | null;
  private peer: WebRtcPeer | null = null;
  private unsubscribeSignaling: (() => void) | null = null;
  private session: SwarmSessionDescriptor | null = null;
  private state: WorkerRuntimeState = "idle";
  private listeners = new Set<() => void>();
  private currentJobId: string | null = null;
  private readonly assembler = new AssetChunkAssembler();
  /** Hash verification/cache writes are async; duplicate callers share the same in-flight write. */
  private readonly assetInflight = new Map<string, Promise<boolean>>();
  private assetManifestGeneration: string | null = null;
  private assetManifestHashes = new Set<string>();
  private assetManifestPending = false;
  private unbindVisibility: (() => void) | null = null;
  private lastJoinCode = "";
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private approvalTimer: ReturnType<typeof setTimeout> | null = null;
  private approvalAttempts = 0;
  private connectionKind: "unknown" | "direct" | "relay" = "unknown";
  private lastError: string | null = null;
  private snapshot = { state: this.state, currentJobId: this.currentJobId, connection: this.connectionKind, error: this.lastError, session: this.session };

  constructor(private readonly options: WorkerRuntimeOptions) {
    this.backend = options.backend;
    this.executor = options.executor ?? new WorkerRenderExecutor();
    this.identity = options.identity ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot = () => this.snapshot;

  async join(joinCode: string): Promise<void> {
    const normalizedCode = joinCode.trim().toUpperCase();
    const activeStates: WorkerRuntimeState[] = [
      "joining", "waiting-approval", "connecting", "authenticating", "syncing", "ready", "rendering",
    ];
    // React development StrictMode and reconnect timers can both call join while the previous
    // request is still alive. One worker identity must not create two approved peers.
    if (normalizedCode === this.lastJoinCode && activeStates.includes(this.state)) return;
    this.stopped = false;
    this.lastJoinCode = normalizedCode;
    this.setState("joining");
    // Re-joining replaces the peer id, so the previous long poll is for an identity nobody will
    // send to; leaving it running keeps hitting the signaling server for nothing.
    this.unsubscribeSignaling?.();
    this.unsubscribeSignaling = null;
    try {
      this.identity ??= await loadOrCreateDeviceIdentity(localStorage);
      const peer: SwarmPeerDescriptor = {
        peerId: globalThis.crypto?.randomUUID?.() ?? `peer-${Date.now()}`,
        deviceId: this.identity.deviceId,
        label: this.options.label,
        publicKeyJwk: this.identity.publicKeyJwk,
        requestedAt: Date.now(),
      };
      const result = await this.backend.joinSession({ joinCode: joinCode.trim().toUpperCase(), peer });
      this.session = result.session;
      this.unsubscribeSignaling = await this.backend.subscribe(result.session.sessionId, peer.peerId, (event) => this.handleSignalingEvent(event));
      this.setState("waiting-approval");
      this.armApprovalTimeout();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Unable to join swarm";
      this.setState("error");
      // The host may simply be restarting; with a fixed join code it will come back on the same
      // one, so keep trying instead of stranding a worker someone has to reopen by hand.
      this.scheduleReconnect();
      throw error;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearApprovalTimeout();
    this.unbindVisibility?.();
    this.unbindVisibility = null;
    this.unsubscribeSignaling?.();
    this.unsubscribeSignaling = null;
    this.peer?.close();
    this.peer = null;
    this.assembler.reset();
    this.assetInflight.clear();
    this.setState("stopped");
  }

  private handleSignalingEvent(event: SwarmSignalingEvent): void {
    if (event.type === "peer-approved") {
      this.clearApprovalTimeout();
      this.startPeer(event.hostPeerId, event.peer.peerId);
      return;
    }
    if (event.type === "peer-rejected") {
      this.lastError = event.reason ?? "Host rejected this worker";
      this.setState("error");
      return;
    }
    if (event.type === "signal") {
      void this.peer?.applySignal(event.payload);
      return;
    }
    if (event.type === "session-expired") {
      this.lastError = "This worker session expired";
      this.setState("error");
      this.scheduleReconnect();
    }
  }

  private startPeer(hostPeerId: string, workerPeerId: string): void {
    if (!this.session || !this.identity) return;
    this.setState("connecting");
    const peer = new WebRtcPeer({ initiator: false });
    const previousPeer = this.peer;
    this.peer = peer;
    previousPeer?.close();
    peer.onSignal = (signal) => {
      if (this.peer !== peer) return;
      void this.backend.sendSignal(this.session!.sessionId, workerPeerId, hostPeerId, signal);
    };
    peer.onMessage = (message) => {
      if (this.peer === peer) void this.handleMessage(message);
    };
    peer.onTransportKind = (kind) => {
      if (this.peer !== peer) return;
      this.connectionKind = kind;
      this.setState(this.state);
    };
    peer.onStateChange = (state) => {
      if (this.peer !== peer) return;
      if (state === "connected") {
        // P2P is up: stop long-polling the signaling server (server req/min must reach 0).
        this.unsubscribeSignaling?.();
        this.unsubscribeSignaling = null;
        this.reconnectAttempts = 0;
        this.setState("authenticating");
        void this.sendHello();
        // Background tabs are throttled hard enough that leased frames always miss their
        // deadline; tell the host to stop sending work instead of wasting it.
        this.bindVisibilityReporting();
      }
      if (state === "disconnected" || state === "failed" || state === "closed") {
        this.setState("error");
        this.scheduleReconnect(peer);
      }
    };
  }

  /**
   * A join request is queued against whichever host peer id was current at the time, so a host
   * that restarts never sees it — and joining succeeded, so nothing else retries. Rather than have
   * the server replay peers (which resurrects ids the worker has already abandoned), ask again
   * from here: a fresh request always carries a peer id someone is actually listening on.
   */
  private armApprovalTimeout(): void {
    if (this.approvalTimer !== null) clearTimeout(this.approvalTimer);
    // Backs off: asking again abandons the peer id the host may be answering right now, so a tight
    // retry can outrun its own approval and leave a trail of half-open connections behind.
    const delay = Math.min(
      WORKER_APPROVAL_TIMEOUT_MS * 6,
      WORKER_APPROVAL_TIMEOUT_MS * 2 ** Math.min(3, this.approvalAttempts),
    );
    this.approvalTimer = setTimeout(() => {
      this.approvalTimer = null;
      if (this.stopped || this.state !== "waiting-approval" || !this.lastJoinCode) return;
      this.approvalAttempts += 1;
      void this.join(this.lastJoinCode).catch(() => this.scheduleReconnect());
    }, delay);
  }

  private clearApprovalTimeout(): void {
    if (this.approvalTimer !== null) clearTimeout(this.approvalTimer);
    this.approvalTimer = null;
    this.approvalAttempts = 0;
  }

  /**
   * Rejoins after a drop. A worker that silently stays disconnected means someone has to notice
   * and re-approve by hand, which is the main cost of running a swarm during development.
   */
  private scheduleReconnect(expectedPeer?: WebRtcPeer): void {
    if (expectedPeer && this.peer !== expectedPeer) return;
    if (this.stopped || !this.lastJoinCode || this.reconnectTimer !== null) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(5, this.reconnectAttempts - 1));
    const peer = this.peer;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || (peer && this.peer !== peer)) return;
      this.peer?.close();
      this.peer = null;
      void this.join(this.lastJoinCode).catch(() => this.scheduleReconnect());
    }, delay);
  }

  /**
   * A rendered frame is far larger than a data channel message, so the pixels travel as chunks and
   * the result itself carries only its metadata. Sending it whole silently delivered nothing.
   */
  private async sendResult(result: SwarmRenderResult): Promise<void> {
    const protocol = this.peer?.protocol;
    if (!protocol) return;
    const chunks = splitResultBytes(result.jobId, result.bytesBase64);
    if (devFaultInjection()?.mode === "transfer-stall") {
      const first = chunks[0];
      if (first) await protocol.send(createSwarmMessage("job-result-chunk", first));
      return;
    }
    for (const chunk of chunks) await protocol.send(createSwarmMessage("job-result-chunk", chunk));
    await protocol.send(createSwarmMessage("job-result", { ...result, bytesBase64: "" }));
  }

  private bindVisibilityReporting(): void {
    if (this.unbindVisibility || typeof document === "undefined") return;
    const report = (): void => {
      void this.peer?.protocol?.send(createSwarmMessage("worker-availability", {
        available: document.visibilityState === "visible",
        reason: "page-visibility",
      }));
    };
    document.addEventListener("visibilitychange", report);
    this.unbindVisibility = () => document.removeEventListener("visibilitychange", report);
    report();
  }

  private async sendHello(): Promise<void> {
    if (!this.peer?.protocol || !this.identity) return;
    await this.peer.protocol.send(createSwarmMessage("hello", {
      deviceId: this.identity.deviceId,
      label: this.options.label,
      publicKeyJwk: this.identity.publicKeyJwk,
      runtimeVersion: collectWorkerCapabilities().runtimeVersion,
      protocolVersion: collectWorkerCapabilities().protocolVersion,
    }));
    await this.peer.protocol.send(createSwarmMessage("capabilities", collectWorkerCapabilities()));
  }

  private async handleMessage(message: Parameters<NonNullable<WebRtcPeer["onMessage"]>>[0]): Promise<void> {
    if (isSwarmMessageType(message, "challenge")) {
      if (!this.identity || !this.peer?.protocol) return;
      const signatureBase64 = await signChallenge(this.identity, message.payload.nonce);
      await this.peer.protocol.send(createSwarmMessage("challenge-response", { nonce: message.payload.nonce, signatureBase64 }));
      // The host still has to synchronize the files this worker will render. READY is sent only
      // after the host receives a manifest-level READY for the exact cache state.
      this.assetManifestGeneration = null;
      this.assetManifestHashes.clear();
      this.assetManifestPending = false;
      this.setState("syncing");
      return;
    }
    if (isSwarmMessageType(message, "asset-manifest")) {
      if (!this.peer?.protocol) return;
      this.assetManifestGeneration = message.payload.generation;
      this.assetManifestHashes = new Set(message.payload.assets.map((asset) => asset.contentHash));
      this.assetManifestPending = true;
      const cachedContentHashes = this.cachedAssetHashes();
      await this.peer.protocol.send(createSwarmMessage("asset-manifest-state", {
        generation: message.payload.generation,
        cachedContentHashes,
      }));
      if (this.currentJobId === null) this.setState("syncing");
      return;
    }
    if (isSwarmMessageType(message, "asset-chunk")) {
      const transfer = this.assembler.accept(message.payload);
      if (transfer) {
        const cached = this.cacheAsset(transfer);
        const ok = await cached.catch(() => false);
        await this.peer?.protocol?.send(createSwarmMessage("asset-ready", {
          contentHash: transfer.contentHash,
          ok,
          ...(ok ? {} : { message: `Worker rejected asset: ${transfer.path}` }),
        }));
      }
      return;
    }
    if (isSwarmMessageType(message, "asset-sync-complete")) {
      if (message.payload.generation !== this.assetManifestGeneration || !this.peer?.protocol) return;
      const cachedContentHashes = this.cachedAssetHashes();
      const cached = new Set(cachedContentHashes);
      const missing = [...this.assetManifestHashes].filter((hash) => !cached.has(hash));
      const ok = missing.length === 0;
      await this.peer.protocol.send(createSwarmMessage("asset-manifest-ready", {
        generation: message.payload.generation,
        ok,
        cachedContentHashes,
        ...(ok ? {} : { message: `Worker cache is missing ${missing.length} manifest asset(s)` }),
      }));
      if (ok) {
        this.assetManifestPending = false;
        if (this.currentJobId === null) this.setState("ready");
      } else if (this.currentJobId === null) {
        this.setState("syncing");
      }
      return;
    }
    if (isSwarmMessageType(message, "benchmark-request")) {
      if (!message.payload.job || !this.peer?.protocol) return;
      const result = await this.executor.benchmark(message.payload.job);
      await this.peer.protocol.send(createSwarmMessage("benchmark-result", result));
      return;
    }
    if (isSwarmMessageType(message, "job-offer")) {
      if (!this.peer?.protocol) return;
      const fault = devFaultInjection();
      if (fault?.mode === "no-ack") return;
      // Two renders sharing one capture context corrupt each other and both get slower, so a
      // re-offer that arrives mid-render is refused rather than started.
      if (this.currentJobId !== null) {
        await this.peer.protocol.send(createSwarmMessage("job-failed", {
          jobId: message.payload.job.id,
          message: "Worker is already rendering another frame",
        }));
        return;
      }
      this.currentJobId = message.payload.job.id;
      this.setState("rendering");
      await this.peer.protocol.send(createSwarmMessage("job-accepted", { jobId: this.currentJobId }));
      if (fault?.mode === "accepted-hang") return;
      try {
        let lastProgressAt = 0;
        let lastCompleted = 0;
        let progressChain: Promise<void> = Promise.resolve();
        const reportProgress = (completedFrames: number, totalFrames: number): void => {
          const boundedCompleted = Math.max(lastCompleted, Math.min(totalFrames, completedFrames));
          if (boundedCompleted <= lastCompleted) return;
          const now = Date.now();
          if (boundedCompleted < totalFrames && now - lastProgressAt < 250) return;
          lastProgressAt = now;
          lastCompleted = boundedCompleted;
          progressChain = progressChain.then(async () => {
            if (!this.peer?.protocol) return;
            await this.peer.protocol.send(createSwarmMessage("job-progress", {
              jobId: message.payload.job.id,
              completedFrames: boundedCompleted,
              totalFrames,
            }));
          });
        };
        const result = await this.executor.render(message.payload.job, reportProgress);
        reportProgress(message.payload.job.frameEnd - message.payload.job.frameStart, message.payload.job.frameEnd - message.payload.job.frameStart);
        await progressChain;
        if (fault?.mode === "slow-late") {
          await new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, fault.delayMs ?? 5_000)));
        }
        await this.sendResult(result);
      } catch (error) {
        await this.peer.protocol.send(createSwarmMessage("job-failed", {
          jobId: message.payload.job.id,
          message: error instanceof Error ? error.message : "Worker render failed",
          reason: "worker-failed",
        }));
      } finally {
        this.currentJobId = null;
        this.setState(this.assetManifestPending ? "syncing" : "ready");
      }
      return;
    }
    if (isSwarmMessageType(message, "ping")) {
      await this.peer?.protocol?.send(createSwarmMessage("pong", { at: Date.now() }));
    }
  }

  private setState(state: WorkerRuntimeState): void {
    this.state = state;
    this.snapshot = { state: this.state, currentJobId: this.currentJobId, connection: this.connectionKind, error: this.lastError, session: this.session };
    for (const listener of this.listeners) listener();
  }

  private cacheAsset(transfer: Parameters<WorkerRenderExecutor["cacheAsset"]>[0]): Promise<boolean> {
    const existing = this.assetInflight.get(transfer.contentHash);
    if (existing) return existing;
    let promise: Promise<boolean>;
    promise = this.executor.cacheAsset(transfer).finally(() => {
      if (this.assetInflight.get(transfer.contentHash) === promise) this.assetInflight.delete(transfer.contentHash);
    });
    this.assetInflight.set(transfer.contentHash, promise);
    return promise;
  }

  private cachedAssetHashes(): string[] {
    return typeof this.executor.cachedAssetHashes === "function"
      ? this.executor.cachedAssetHashes()
      : [];
  }
}
