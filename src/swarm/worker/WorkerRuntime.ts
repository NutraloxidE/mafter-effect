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

/** How long a worker waits for approval before asking again with a fresh peer id. */
const WORKER_APPROVAL_TIMEOUT_MS = 20_000;

export type WorkerRuntimeState = "idle" | "joining" | "waiting-approval" | "connecting" | "connected" | "rendering" | "stopped" | "error";

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
    this.stopped = false;
    this.lastJoinCode = joinCode.trim().toUpperCase();
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
    this.peer = peer;
    peer.onSignal = (signal) => void this.backend.sendSignal(this.session!.sessionId, workerPeerId, hostPeerId, signal);
    peer.onMessage = (message) => void this.handleMessage(message);
    peer.onTransportKind = (kind) => {
      this.connectionKind = kind;
      this.setState(this.state);
    };
    peer.onStateChange = (state) => {
      if (state === "connected") {
        // P2P is up: stop long-polling the signaling server (server req/min must reach 0).
        this.unsubscribeSignaling?.();
        this.unsubscribeSignaling = null;
        this.reconnectAttempts = 0;
        this.setState("connected");
        void this.sendHello();
        // Background tabs are throttled hard enough that leased frames always miss their
        // deadline; tell the host to stop sending work instead of wasting it.
        this.bindVisibilityReporting();
      }
      if (state === "disconnected" || state === "failed" || state === "closed") {
        this.setState("error");
        this.scheduleReconnect();
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
  private scheduleReconnect(): void {
    if (this.stopped || !this.lastJoinCode || this.reconnectTimer !== null) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(5, this.reconnectAttempts - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
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
      return;
    }
    if (isSwarmMessageType(message, "asset-chunk")) {
      const transfer = this.assembler.accept(message.payload);
      if (transfer) await this.executor.cacheAsset(transfer);
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
      try {
        const result = await this.executor.render(message.payload.job);
        await this.sendResult(result);
      } catch (error) {
        await this.peer.protocol.send(createSwarmMessage("job-failed", {
          jobId: message.payload.job.id,
          message: error instanceof Error ? error.message : "Worker render failed",
        }));
      } finally {
        this.currentJobId = null;
        this.setState("connected");
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
}
