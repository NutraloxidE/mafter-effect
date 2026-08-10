import { commitJob, createPendingJob, isLeaseExpired, leaseJob, requeueJob } from "./jobLease";
import type { LeasedRenderJob, RenderJobPriority, SwarmJobId, SwarmRenderJob, WorkerSlotId } from "./types";

const PRIORITY: Record<RenderJobPriority, number> = {
  playhead: 0,
  upcoming: 1,
  previous: 2,
  visible: 3,
  background: 4,
};

export interface SchedulerWorker {
  slotId: WorkerSlotId;
  score: number;
  reliability: number;
  connected: boolean;
}

export interface SchedulerSnapshot {
  pending: number;
  leased: number;
  committed: number;
  requeued: number;
}

export class SwarmScheduler {
  private jobs = new Map<SwarmJobId, LeasedRenderJob>();
  private workers = new Map<WorkerSlotId, SchedulerWorker>();
  private committed = new Set<SwarmJobId>();
  private requeued = 0;

  registerWorker(worker: SchedulerWorker): void {
    this.workers.set(worker.slotId, worker);
  }

  updateWorker(worker: SchedulerWorker): void {
    this.workers.set(worker.slotId, worker);
  }

  removeWorker(slotId: WorkerSlotId): SwarmJobId[] {
    const affected: SwarmJobId[] = [];
    this.workers.delete(slotId);
    for (const job of this.jobs.values()) {
      if (job.lease?.workerId !== slotId || job.state === "committed") continue;
      this.jobs.set(job.id, requeueJob(job));
      this.requeued += 1;
      affected.push(job.id);
    }
    return affected;
  }

  enqueue(job: SwarmRenderJob): LeasedRenderJob {
    const existing = this.jobs.get(job.id);
    if (existing) return existing;
    const pending = createPendingJob(job);
    this.jobs.set(job.id, pending);
    return pending;
  }

  requestJob(slotId: WorkerSlotId, now: number, leaseMs: number = 8_000): LeasedRenderJob | null {
    const worker = this.workers.get(slotId);
    if (!worker?.connected) return null;
    const next = [...this.jobs.values()]
      .filter((job) => job.state === "pending")
      .sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.createdAt - b.createdAt)[0];
    if (!next) return null;
    const leased = leaseJob(next, slotId, now, leaseMs);
    this.jobs.set(leased.id, leased);
    return leased;
  }

  markRendering(jobId: SwarmJobId, slotId: WorkerSlotId): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.lease?.workerId !== slotId) return false;
    if (job.state !== "leased") return false;
    this.jobs.set(jobId, { ...job, state: "rendering" });
    return true;
  }

  markUploading(jobId: SwarmJobId, slotId: WorkerSlotId): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.lease?.workerId !== slotId || job.state !== "rendering") return false;
    this.jobs.set(jobId, { ...job, state: "uploading" });
    return true;
  }

  commit(jobId: SwarmJobId, slotId: WorkerSlotId): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.lease?.workerId !== slotId || job.state === "committed") return false;
    this.jobs.set(jobId, commitJob(job));
    this.committed.add(jobId);
    return true;
  }

  fail(jobId: SwarmJobId, slotId: WorkerSlotId): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.lease?.workerId !== slotId || job.state === "committed") return false;
    this.jobs.set(jobId, requeueJob(job));
    this.requeued += 1;
    return true;
  }

  reclaimExpired(now: number): SwarmJobId[] {
    const affected: SwarmJobId[] = [];
    for (const job of this.jobs.values()) {
      if (!isLeaseExpired(job, now)) continue;
      this.jobs.set(job.id, requeueJob(job));
      this.requeued += 1;
      affected.push(job.id);
    }
    return affected;
  }

  get(jobId: SwarmJobId): LeasedRenderJob | undefined {
    return this.jobs.get(jobId);
  }

  getSnapshot(): SchedulerSnapshot {
    let pending = 0;
    let leased = 0;
    for (const job of this.jobs.values()) {
      if (job.state === "pending") pending += 1;
      if (job.state === "leased" || job.state === "rendering" || job.state === "uploading") leased += 1;
    }
    return { pending, leased, committed: this.committed.size, requeued: this.requeued };
  }
}
