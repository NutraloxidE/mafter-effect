import { describe, expect, it } from "vitest";
import {
  ackBudgetMs,
  classifyWatchdogFailure,
  renderStallBudgetMs,
  transferStallBudgetMs,
  type JobLiveness,
} from "../src/swarm/core/liveness";

const base = (patch: Partial<JobLiveness> = {}): JobLiveness => ({
  phase: "offered",
  offeredAt: 1_000,
  ackDeadlineAt: 2_000,
  hardDeadlineAt: 10_000,
  ...patch,
});

describe("swarm liveness", () => {
  it("keeps ACK waiting separate from render waiting", () => {
    expect(classifyWatchdogFailure(base(), 2_000, { renderMs: 10_000, transferMs: 10_000 })).toBe("no-ack");
    expect(classifyWatchdogFailure(base({ phase: "rendering", acceptedAt: 1_500, lastProgressAt: 1_500 }), 2_499, { renderMs: 1_000, transferMs: 10_000 })).toBeNull();
    expect(classifyWatchdogFailure(base({ phase: "rendering", acceptedAt: 1_500, lastProgressAt: 1_500 }), 2_500, { renderMs: 1_000, transferMs: 10_000 })).toBe("render-stall");
  });

  it("distinguishes a transfer stall after rendering made progress", () => {
    expect(classifyWatchdogFailure(base({ phase: "transferring", firstResultChunkAt: 2_000, lastResultChunkAt: 2_000 }), 3_001, { renderMs: 10_000, transferMs: 1_000 })).toBe("transfer-stall");
  });

  it("always gives a hard deadline precedence over soft watchdogs", () => {
    expect(classifyWatchdogFailure(base({ phase: "transferring", lastResultChunkAt: 9_900, hardDeadlineAt: 10_000 }), 10_000, { renderMs: 1, transferMs: 1 })).toBe("hard-deadline");
  });

  it("uses bounded RTT ACK budgets and workload-derived stall budgets", () => {
    expect(ackBudgetMs(0)).toBeGreaterThanOrEqual(500);
    expect(ackBudgetMs(100_000)).toBeLessThanOrEqual(5_000);
    expect(renderStallBudgetMs(2_000)).toBe(4_000);
    expect(transferStallBudgetMs(2_000)).toBe(5_000);
  });
});
