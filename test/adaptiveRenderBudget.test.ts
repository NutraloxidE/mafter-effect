import { describe, expect, it } from "vitest";
import {
  computeRenderGate,
  initialRenderBudgetState,
  recordRenderCost,
  RENDER_TARGET_OCCUPANCY,
} from "../src/runtime/adaptiveRenderBudget";

describe("adaptiveRenderBudget", () => {
  it("always renders the first tick", () => {
    const state = initialRenderBudgetState();

    const gate = computeRenderGate(state, 100, 1000 / 60);

    expect(gate.render).toBe(true);
    expect(gate.nextState.lastRenderMs).toBe(100);
  });

  it("renders every frame under light load", () => {
    let state = recordRenderCost(initialRenderBudgetState(), 5);
    state = computeRenderGate(state, 0, 1000 / 60).nextState;

    const nextFrame = computeRenderGate(state, 1000 / 60, 1000 / 60);

    expect(nextFrame.render).toBe(true);
  });

  it("thins render interval under heavy load", () => {
    const msPerFrame = 1000 / 60;
    let state = recordRenderCost(initialRenderBudgetState(), 50);
    state = computeRenderGate(state, 0, msPerFrame).nextState;

    const tooSoon = computeRenderGate(state, 50 / RENDER_TARGET_OCCUPANCY - 1, msPerFrame);
    const ready = computeRenderGate(state, 50 / RENDER_TARGET_OCCUPANCY, msPerFrame);

    expect(tooSoon.render).toBe(false);
    expect(ready.render).toBe(true);
  });

  it("returns to the frame interval after load recovers", () => {
    const msPerFrame = 1000 / 60;
    let state = recordRenderCost(initialRenderBudgetState(), 50);
    state = computeRenderGate(state, 0, msPerFrame).nextState;
    for (let i = 0; i < 20; i += 1) {
      state = recordRenderCost(state, 1);
    }

    const gate = computeRenderGate(state, msPerFrame, msPerFrame);

    expect(state.renderCostEmaMs).toBeLessThan(msPerFrame);
    expect(gate.render).toBe(true);
  });
});
