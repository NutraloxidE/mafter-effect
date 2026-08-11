import { collectWorkerCapabilities } from "../core/capability";
import { loadOrCreateDeviceIdentity, signChallenge, type DeviceIdentity } from "../core/identity";
import { createSwarmMessage, isSwarmMessageType } from "../core/protocol";
import { WebRtcPeer } from "../transport/WebRtcPeer";
import type { SwarmSignalingBackend } from "../signaling/SignalingBackend";
import { WorkerRenderExecutor } from "./workerRenderExecutor";
import type { SwarmSessionDescriptor, SwarmPeerDescriptor, SwarmSignalingEvent } from "../core/types";

export interface WorkerRuntimeOptions {
  backend: SwarmSignalingBackend;
  identity?: DeviceIdentity;
  label: string;
  executor?: WorkerRenderExecutor;
}

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
    this.setState("joining");
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
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Unable to join swarm";
      this.setState("error");
      throw error;
    }
  }

  stop(): void {
    this.unsubscribeSignaling?.();
    this.unsubscribeSignaling = null;
    this.peer?.close();
    this.peer = null;
    this.setState("stopped");
  }

  private handleSignalingEvent(event: SwarmSignalingEvent): void {
    if (event.type === "peer-approved") {
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
        this.setState("connected");
        void this.sendHello();
      }
      if (state === "disconnected" || state === "failed" || state === "closed") this.setState("error");
    };
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
    if (isSwarmMessageType(message, "benchmark-request")) {
      if (!message.payload.job || !this.peer?.protocol) return;
      const result = await this.executor.benchmark(message.payload.job);
      await this.peer.protocol.send(createSwarmMessage("benchmark-result", result));
      return;
    }
    if (isSwarmMessageType(message, "job-offer")) {
      if (!this.peer?.protocol) return;
      this.currentJobId = message.payload.job.id;
      this.setState("rendering");
      await this.peer.protocol.send(createSwarmMessage("job-accepted", { jobId: this.currentJobId }));
      try {
        const result = await this.executor.render(message.payload.job);
        await this.peer.protocol.send(createSwarmMessage("job-result", result));
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
