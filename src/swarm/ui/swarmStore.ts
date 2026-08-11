import { previewCacheService } from "../../editor/previewCacheService";
import { useEditorStore } from "../../editor/store";
import { attachJobFilesCached } from "../core/jobFiles";
import type { ExportSwarmHooks } from "../../runtime/exporter";
import { loadOrCreateDeviceIdentity } from "../core/identity";
import { SwarmCoordinator } from "../core/coordinator";
import { createSignalingBackend } from "../signaling/SignalingService";
import type { SwarmAssetTransfer, SwarmMetricsSnapshot, SwarmRenderJob, SwarmRenderResult, SwarmSessionDescriptor, SwarmPeerDescriptor, WorkerSnapshot } from "../core/types";

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
      // A fixed code lets a host restart without stranding its workers: they keep retrying the
      // same code and reattach on their own. Same device only — see the durable session core.
      const joinCode = globalThis.localStorage?.getItem("mafter.swarm.hostCode")?.trim().toUpperCase();
      const session = await this.backend.createSession({
        hostPeerId,
        hostDeviceId: identity.deviceId,
        hostLabel: typeof navigator !== "undefined" ? navigator.platform || "Mafter Host" : "Mafter Host",
        ...(joinCode ? { joinCode } : {}),
      });
      const coordinator = new SwarmCoordinator({
        backend: this.backend,
        session,
        hostPeerId,
        hostIdentity: identity,
        hostLabel: "Mafter Host",
        runtimeVersion: "mafter-render-runtime-v1",
        onLateResult: (result) => void this.storeLateResult(result),
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

  async preloadAssets(assets: SwarmAssetTransfer[]): Promise<void> {
    await this.coordinator?.preloadAssets(assets);
  }

  async renderPreviewFrame(job: SwarmRenderJob, timeoutMs?: number): Promise<SwarmRenderResult | null> {
    return this.coordinator?.renderPreviewFrame(job, timeoutMs) ?? null;
  }

  private async storeLateResult(result: SwarmRenderResult): Promise<void> {
    const text = atob(result.bytesBase64);
    const png = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) png[i] = text.charCodeAt(i);
    await previewCacheService.acceptLateRemoteFrame(result.renderRevision, result.frameStart, png, result.width, result.height);
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

/**
 * Export-time swarm hooks, or undefined when no worker is connected — an export with no workers
 * must take exactly the path it always took.
 */
export function swarmExportHooks(): ExportSwarmHooks | undefined {
  // A distributed export is not byte-identical to a local one when the composition has footage,
  // because browsers decode video differently depending on how many decoders are alive. That is
  // rasterization fidelity, which INV-2 allows to differ by means; scene values still match and
  // missing content is rejected. See "Frame identity under parallel production" in the spec.
  // Set "mafter.swarm.export" to "0" to keep an export fully local.
  if (globalThis.localStorage?.getItem("mafter.swarm.export") === "0") return undefined;
  const snapshot = swarmUiStore.getSnapshot();
  const workerCount = snapshot.workers.filter((worker) => worker.state === "connected" && worker.available !== false).length;
  if (workerCount === 0) return undefined;
  return {
    workerCount,
    preload: async (project, comp) => {
      const state = useEditorStore.getState();
      const job = { project, compositionId: comp.id } as unknown as Parameters<typeof attachJobFilesCached>[0];
      const withFiles = await attachJobFilesCached(job, comp, state.getFs(), String(state.projectRevision ?? 0));
      await swarmUiStore.preloadAssets(withFiles.assets ?? []);
    },
    submit: async (job, timeoutMs) => {
      const comp = job.project.compositions.find((candidate) => candidate.id === job.compositionId);
      if (!comp || comp.kind !== "timeline") return null;
      // Export jobs need their footage and scripts attached exactly like preview jobs do;
      // without this every job is declined as not self-contained.
      const state = useEditorStore.getState();
      const withFiles = await attachJobFilesCached(job, comp, state.getFs(), String(state.projectRevision ?? 0));
      return swarmUiStore.renderPreviewFrame(withFiles, timeoutMs);
    },
  };
}
