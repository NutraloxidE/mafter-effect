export interface RenderBudgetState {
  renderCostEmaMs: number;
  lastRenderMs: number | null;
}

export interface RenderGateResult {
  render: boolean;
  nextState: RenderBudgetState;
}

export const RENDER_COST_EMA_ALPHA = 0.2;
export const RENDER_TARGET_OCCUPANCY = 0.6;

export function initialRenderBudgetState(): RenderBudgetState {
  return { renderCostEmaMs: 0, lastRenderMs: null };
}

export function recordRenderCost(
  state: RenderBudgetState,
  costMs: number,
): RenderBudgetState {
  const cost = Math.max(0, Number.isFinite(costMs) ? costMs : 0);
  const renderCostEmaMs =
    state.renderCostEmaMs <= 0
      ? cost
      : state.renderCostEmaMs * (1 - RENDER_COST_EMA_ALPHA) + cost * RENDER_COST_EMA_ALPHA;
  return { ...state, renderCostEmaMs };
}

export function computeRenderGate(
  state: RenderBudgetState,
  nowMs: number,
  msPerFrame: number,
): RenderGateResult {
  if (state.lastRenderMs === null) {
    return { render: true, nextState: { ...state, lastRenderMs: nowMs } };
  }

  const frameMs = Math.max(1, Number.isFinite(msPerFrame) ? msPerFrame : 1);
  const emaMs = Math.max(0, Number.isFinite(state.renderCostEmaMs) ? state.renderCostEmaMs : 0);
  const minRenderIntervalMs =
    emaMs < frameMs ? frameMs : Math.max(frameMs, emaMs / RENDER_TARGET_OCCUPANCY);

  if (nowMs - state.lastRenderMs < minRenderIntervalMs) {
    return { render: false, nextState: state };
  }

  return { render: true, nextState: { ...state, lastRenderMs: nowMs } };
}
