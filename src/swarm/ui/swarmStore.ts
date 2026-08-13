import { previewCacheService } from "../../editor/previewCacheService";
import { useEditorStore } from "../../editor/store";
import { attachJobFilesCached, collectJobFilePaths } from "../core/jobFiles";
import type { ExportSwarmHooks } from "../../runtime/exporter";
import { loadOrCreateDeviceIdentity } from "../core/identity";
import { SwarmCoordinator } from "../core/coordinator";
import { createSignalingBackend } from "../signaling/SignalingService";
import type {
  SwarmAssetTransfer,
  SwarmExportTimeline,
  SwarmJobTimeline,
  SwarmMetricsSnapshot,
  SwarmRenderJob,
  SwarmRenderResult,
  SwarmSessionDescriptor,
  SwarmPeerDescriptor,
  WorkerSnapshot,
} from "../core/types";

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
  private connectedSlots = "";
  private lastPreloadedPaths = "";
  private preloadTimer: ReturnType<typeof setTimeout> | null = null;
  private assetSyncInFlight: Promise<void> | null = null;
  private assetSyncGeneration = 0;
  private assetSyncDirty = false;
  private unsubscribeProject: (() => void) | null = null;
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
      this.unsubscribeProject = useEditorStore.subscribe(() => this.scheduleAssetSync());
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
    this.unsubscribeProject?.();
    this.unsubscribeProject = null;
    if (this.preloadTimer !== null) clearTimeout(this.preloadTimer);
    this.preloadTimer = null;
    this.assetSyncInFlight = null;
    this.assetSyncGeneration += 1;
    this.assetSyncDirty = false;
    this.connectedSlots = "";
    this.lastPreloadedPaths = "";
    this.update({ status: "idle", session: null, joinUrl: null, pendingWorkers: [], workers: [], availableCompute: 1, error: null });
  }

  async preloadAssets(assets: SwarmAssetTransfer[]): Promise<boolean> {
    return await this.coordinator?.preloadAssets(assets) ?? false;
  }

  /** One frame a worker drew reached the export. The panel reports this, not results received. */
  noteAdoptedFrame(): void {
    this.coordinator?.metrics.noteAdoptedRemoteFrame();
    this.refresh(this.coordinator);
  }

  noteJobTimeline(timeline: SwarmJobTimeline): void {
    this.coordinator?.metrics.noteJobTimeline(timeline);
    this.refresh(this.coordinator);
  }

  noteExportTimeline(timeline: SwarmExportTimeline): void {
    this.coordinator?.metrics.noteExportTimeline(timeline);
    this.refresh(this.coordinator);
  }

  async renderPreviewFrame(job: SwarmRenderJob, timeoutMs?: number): Promise<SwarmRenderResult | null> {
    return this.coordinator?.renderPreviewFrame(job, timeoutMs) ?? null;
  }

  /**
   * Pushes the current composition's footage and scripts to every connected worker, so a job offer
   * carries references to bytes the worker already holds instead of waiting on a transfer that can
   * outlast the frame's own deadline. `preloadAssets` skips content hashes a worker already has, so
   * calling this repeatedly only ever sends what changed.
   */
  private requestAssetSync(): void {
    this.assetSyncGeneration += 1;
    this.assetSyncDirty = true;
    if (!this.assetSyncInFlight) void this.runAssetSync();
  }

  private runAssetSync(): Promise<void> {
    const runGeneration = this.assetSyncGeneration;
    this.assetSyncDirty = false;
    const sync = (async (): Promise<void> => {
      const coordinator = this.coordinator;
      if (!coordinator) return;
      const state = useEditorStore.getState();
      const project = state.project;
      const comp = project?.compositions.find((candidate) => candidate.id === state.currentCompId);
      if (!project || comp?.kind !== "timeline") return;
      const paths = collectJobFilePaths(project, comp);
      const job = { project, compositionId: comp.id } as unknown as Parameters<typeof attachJobFilesCached>[0];
      const withFiles = await attachJobFilesCached(job, comp, state.getFs(), String(state.projectRevision ?? 0));
      // undefined means attaching a required file failed; do not turn a syncing worker into READY
      // with an unverified/incomplete project. An empty array is the successful no-asset case.
      if (!withFiles.assets) return;
      if (await coordinator.preloadAssets(withFiles.assets)) {
        this.lastPreloadedPaths = paths.join("|");
      }
    })();
    this.assetSyncInFlight = sync;
    void sync.then(() => {
      this.finishAssetSync(sync, runGeneration);
    }, () => {
      this.finishAssetSync(sync, runGeneration);
    });
    return sync;
  }

  private finishAssetSync(sync: Promise<void>, runGeneration: number): void {
    if (this.assetSyncInFlight === sync) this.assetSyncInFlight = null;
    if ((this.assetSyncDirty || this.assetSyncGeneration !== runGeneration) && this.coordinator) {
      void this.runAssetSync();
    }
  }

  /**
   * Re-sends after an edit, but only when the referenced files changed: re-reading and re-hashing
   * every video on each revision bump would put a multi-megabyte read behind ordinary editing.
   */
  private scheduleAssetSync(): void {
    if (this.preloadTimer !== null) return;
    this.preloadTimer = setTimeout(() => {
      this.preloadTimer = null;
      const state = useEditorStore.getState();
      const comp = state.project?.compositions.find((candidate) => candidate.id === state.currentCompId);
      if (!state.project || comp?.kind !== "timeline") return;
      if (collectJobFilePaths(state.project, comp).join("|") === this.lastPreloadedPaths) return;
      this.requestAssetSync();
    }, 1_500);
  }

  private async storeLateResult(result: SwarmRenderResult): Promise<void> {
    const text = atob(result.bytesBase64);
    const png = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) png[i] = text.charCodeAt(i);
    await previewCacheService.acceptLateRemoteFrame(result.renderRevision, result.frameStart, png, result.width, result.height);
  }

  private refresh(coordinator: SwarmCoordinator | null): void {
    if (!coordinator) return;
    const workers = coordinator.getWorkers();
    // A worker that just came up holds nothing. Transferring now, while it is idle, is the whole
    // point: by the time it is offered a frame the footage is already there.
    // Keyed by peerId, not slotId: a worker that reloads keeps its trusted slot but arrives as a
    // new connection with an empty cache, and would otherwise never be re-sent anything.
    const slots = workers
      .filter((worker) => worker.state === "syncing" || worker.state === "ready")
      .map((worker) => worker.peerId)
      .sort()
      .join("|");
    if (slots !== this.connectedSlots) {
      this.connectedSlots = slots;
      if (slots) this.requestAssetSync();
    }
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

declare global {
  interface Window {
    /** Measurement harness handle: a run's validity is decided from these counters, not from elapsed time. */
    __mafterSwarmStore?: SwarmUiStore;
  }
}

if (typeof window !== "undefined") window.__mafterSwarmStore = swarmUiStore;

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
  const workerCount = snapshot.workers.filter((worker) => worker.state === "ready" && worker.available !== false).length;
  if (workerCount === 0) return undefined;
  return {
    workerCount,
    preload: async (project, comp) => {
      const state = useEditorStore.getState();
      const job = { project, compositionId: comp.id } as unknown as Parameters<typeof attachJobFilesCached>[0];
      const withFiles = await attachJobFilesCached(job, comp, state.getFs(), String(state.projectRevision ?? 0));
      if (withFiles.assets) await swarmUiStore.preloadAssets(withFiles.assets);
    },
    onFrameAdopted: () => swarmUiStore.noteAdoptedFrame(),
    onJobTimeline: (timeline) => swarmUiStore.noteJobTimeline(timeline),
    onExportTimeline: (timeline) => swarmUiStore.noteExportTimeline(timeline),
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
