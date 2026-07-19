import type { Frame, TimelineComposition } from "../core/schema";

export interface NestedRenderEpochs {
  mode: number;
  resource: number;
  evaluator: number;
  context: number;
}

export interface NestedRenderState extends NestedRenderEpochs {
  comp: TimelineComposition;
  childFrame: Frame;
  completed: boolean;
}

interface NestedFrameReuseStats {
  fullRenders: number;
  reuses: number;
  fullDurationMs: number[];
  reuseDurationMs: number[];
  effectDomWrites: number;
  styleDomWrites: number;
}

function stats(): NestedFrameReuseStats {
  const global = globalThis as { __mafterNestedFrameReuseStats?: NestedFrameReuseStats };
  return (global.__mafterNestedFrameReuseStats ??= {
    fullRenders: 0,
    reuses: 0,
    fullDurationMs: [],
    reuseDurationMs: [],
    effectDomWrites: 0,
    styleDomWrites: 0,
  });
}

export function recordNestedFullRender(): void {
  stats().fullRenders++;
}

export function recordNestedFrameReuse(): void {
  stats().reuses++;
}

export function recordNestedFullRenderDuration(durationMs: number): void {
  stats().fullDurationMs.push(durationMs);
}

export function recordNestedFrameReuseDuration(durationMs: number): void {
  stats().reuseDurationMs.push(durationMs);
}

export function recordNestedEffectDomWrite(): void {
  stats().effectDomWrites++;
}

export function recordNestedStyleDomWrite(): void {
  stats().styleDomWrites++;
}

export function nestedFrameReuseStats(): Readonly<NestedFrameReuseStats> {
  return { ...stats() };
}

export function resetNestedFrameReuseStats(): void {
  const current = stats();
  current.fullRenders = 0;
  current.reuses = 0;
  current.fullDurationMs.length = 0;
  current.reuseDurationMs.length = 0;
  current.effectDomWrites = 0;
  current.styleDomWrites = 0;
}

/** Runtime-only rollout flag. false is an explicit kill switch; undefined/true enables reuse. */
export function isNestedFrameReuseEnabled(): boolean {
  const global = globalThis as { __mafterNestedFrameReuse?: unknown };
  return global.__mafterNestedFrameReuse !== false;
}

export function canReuseNestedFrame(
  previous: NestedRenderState | undefined,
  comp: TimelineComposition,
  childFrame: Frame,
  epochs: NestedRenderEpochs,
  resourcesReady: boolean,
): boolean {
  return (
    isNestedFrameReuseEnabled() &&
    resourcesReady &&
    previous?.completed === true &&
    previous.comp === comp &&
    previous.childFrame === childFrame &&
    previous.mode === epochs.mode &&
    previous.resource === epochs.resource &&
    previous.evaluator === epochs.evaluator &&
    previous.context === epochs.context
  );
}
