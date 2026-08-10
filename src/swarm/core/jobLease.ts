import type { JobLease, LeasedRenderJob, SwarmJobId, SwarmRenderJob, WorkerSlotId } from "./types";

export const DEFAULT_JOB_LEASE_MS = 8_000;

export function createPendingJob(job: SwarmRenderJob): LeasedRenderJob {
  return { ...job, state: "pending", attempts: 0 };
}

export function leaseJob(
  job: LeasedRenderJob,
  workerId: WorkerSlotId,
  now: number,
  leaseMs = DEFAULT_JOB_LEASE_MS,
): LeasedRenderJob {
  const lease: JobLease = { workerId, leasedAt: now, deadline: now + leaseMs };
  return { ...job, state: "leased", attempts: job.attempts + 1, lease };
}

export function beginRendering(job: LeasedRenderJob): LeasedRenderJob {
  return job.state === "leased" ? { ...job, state: "rendering" } : job;
}

export function beginUploading(job: LeasedRenderJob): LeasedRenderJob {
  return job.state === "rendering" ? { ...job, state: "uploading" } : job;
}

export function requeueJob(job: LeasedRenderJob): LeasedRenderJob {
  return { ...job, state: "pending", lease: undefined };
}

export function commitJob(job: LeasedRenderJob): LeasedRenderJob {
  return { ...job, state: "committed", lease: undefined };
}

export function isLeaseExpired(job: LeasedRenderJob, now: number): boolean {
  return job.state !== "committed" && job.lease !== undefined && job.lease.deadline <= now;
}

export function leasedJobIdsForWorker(jobs: Iterable<LeasedRenderJob>, workerId: WorkerSlotId): SwarmJobId[] {
  return [...jobs].filter((job) => job.lease?.workerId === workerId && job.state !== "committed").map((job) => job.id);
}
