import { loadOrCreateDeviceIdentity } from "../core/identity";
import { SwarmCoordinator } from "../core/coordinator";
import { createSignalingBackend } from "../signaling/SignalingService";
import type { SwarmMetricsSnapshot, SwarmRenderJob, SwarmRenderResult, SwarmSessionDescriptor, SwarmPeerDescriptor, WorkerSnapshot } from "../core/types";

export interface SwarmUiSnapshot {
  status: "idle" | "starting" | "active" | "error";
  session: SwarmSessionDescriptor | null;
  joinUrl: string | null;
  pendingWorkers: SwarmPeerDescriptor[];
  workers: WorkerSnapshot[];
  availableCompute: number;
  metrics: SwarmMetricsSnapshot | null;
  error: string | null;
}

class SwarmUiStore {
  private snapshot: SwarmUiSnapshot = {
    status: "idle",
    session: null,
    joinUrl: null,
    pendingWorkers: [],
    workers: [],
    availableCompute: 1,
    metrics: null,
    error: null,
  };
  private listeners = new Set<() => void>();
  private coordinator: SwarmCoordinator | null = null;
  private backend = createSignalingBackend({
    useInMemory: import.meta.env.VITE_SWARM_USE_IN_MEMORY === "1",
  });

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot = (): SwarmUiSnapshot => this.snapshot;

  async start(): Promise<void> {
    if (this.coordinator || this.snapshot.status === "starting") return;
    this.update({ status: "starting", error: null });
    try {
      const identity = await loadOrCreateDeviceIdentity(localStorage);
      const hostPeerId = globalThis.crypto?.randomUUID?.() ?? `host-${Date.now()}`;
      const session = await this.backend.createSession({
        hostPeerId,
        hostDeviceId: identity.deviceId,
        hostLabel: typeof navigator !== "undefined" ? navigator.platform || "Mafter Host" : "Mafter Host",
      });
      const coordinator = new SwarmCoordinator({
        backend: this.backend,
        session,
        hostPeerId,
        hostIdentity: identity,
        hostLabel: "Mafter Host",
        runtimeVersion: "mafter-render-runtime-v1",
      });
      coordinator.subscribe(() => this.refresh(coordinator));
      await coordinator.start();
      this.coordinator = coordinator;
      this.update({
        status: "active",
        session,
        joinUrl: `${window.location.origin}/w/${session.joinCode}`,
        pendingWorkers: [],
        workers: [],
        availableCompute: 1,
        error: null,
      });
    } catch (error) {
      this.update({ status: "error", error: error instanceof Error ? error.message : "Worker service is temporarily unavailable." });
    }
  }

  async approveWorker(peerId: string, approved: boolean): Promise<void> {
    await this.coordinator?.approveWorker(peerId, approved);
    this.refresh(this.coordinator);
  }

  stop(): void {
    this.coordinator?.stop();
    this.coordinator = null;
    this.update({ status: "idle", session: null, joinUrl: null, pendingWorkers: [], workers: [], availableCompute: 1, error: null });
  }

  async renderPreviewFrame(job: SwarmRenderJob): Promise<SwarmRenderResult | null> {
    return this.coordinator?.renderPreviewFrame(job) ?? null;
  }

  private refresh(coordinator: SwarmCoordinator | null): void {
    if (!coordinator) return;
    this.update({
      status: "active",
      session: coordinator.session,
      joinUrl: `${window.location.origin}/w/${coordinator.session.joinCode}`,
      pendingWorkers: coordinator.getPendingWorkers(),
      workers: coordinator.getWorkers(),
      availableCompute: coordinator.getAvailableCompute(),
      metrics: coordinator.getMetrics(),
      error: null,
    });
  }

  private update(patch: Partial<SwarmUiSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export const swarmUiStore = new SwarmUiStore();
