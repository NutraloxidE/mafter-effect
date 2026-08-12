import type { SwarmJobFailureReason, SwarmJobPhase } from "./types";

export const SWARM_ACK_FLOOR_MS = 500;
export const SWARM_ACK_CEILING_MS = 5_000;
export const SWARM_ACK_JITTER_MS = 250;
export const SWARM_RENDER_STALL_FLOOR_MS = 1_000;
export const SWARM_RENDER_STALL_CEILING_MS = 15_000;
export const SWARM_TRANSFER_STALL_FLOOR_MS = 1_000;
export const SWARM_TRANSFER_STALL_CEILING_MS = 15_000;

export interface JobLiveness {
  phase: SwarmJobPhase;
  offeredAt: number;
  acceptedAt?: number;
  lastProgressAt?: number;
  firstResultChunkAt?: number;
  lastResultChunkAt?: number;
  ackDeadlineAt: number;
  hardDeadlineAt: number;
}

export interface WatchdogBudgets {
  renderMs: number;
  transferMs: number;
}

function clamp(value: number, floor: number, ceiling: number): number {
  return Math.max(floor, Math.min(ceiling, value));
}

/** ACK is a transport/liveness signal; it must never borrow the render deadline. */
export function ackBudgetMs(rttMs?: number): number {
  const rtt = Number.isFinite(rttMs) && rttMs !== undefined ? Math.max(0, rttMs) : 100;
  return clamp(rtt * 3 + SWARM_ACK_JITTER_MS, SWARM_ACK_FLOOR_MS, SWARM_ACK_CEILING_MS);
}

export function renderStallBudgetMs(predictedRenderMs: number): number {
  return clamp(Math.max(0, predictedRenderMs) * 1.5 + 1_000, SWARM_RENDER_STALL_FLOOR_MS, SWARM_RENDER_STALL_CEILING_MS);
}

export function transferStallBudgetMs(predictedTransferMs: number): number {
  return clamp(Math.max(0, predictedTransferMs) * 2 + 1_000, SWARM_TRANSFER_STALL_FLOOR_MS, SWARM_TRANSFER_STALL_CEILING_MS);
}

export function classifyWatchdogFailure(
  job: JobLiveness,
  now: number,
  budgets: WatchdogBudgets,
): SwarmJobFailureReason | null {
  if (job.hardDeadlineAt <= now) return "hard-deadline";
  if (job.phase === "offered" && job.ackDeadlineAt <= now) return "no-ack";
  if (job.phase === "accepted" || job.phase === "rendering") {
    const last = job.lastProgressAt ?? job.acceptedAt ?? job.offeredAt;
    if (now - last >= budgets.renderMs) return "render-stall";
  }
  if (job.phase === "transferring") {
    const last = job.lastResultChunkAt ?? job.firstResultChunkAt ?? job.offeredAt;
    if (now - last >= budgets.transferMs) return "transfer-stall";
  }
  return null;
}
