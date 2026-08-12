/**
 * What a frame of the current composition actually costs this machine.
 *
 * The swarm scored workers against an empty 320x180 timeline, which measures nothing a real export
 * does: no footage decode, no fonts, no effects, no raster at output resolution. A worker that
 * benchmarked at "2.7x local" on that comp turned out to be 1.4x *slower* than the host on the real
 * one. Capacity has to be quoted in the workload being distributed, so both sides are measured
 * here, on the frames the export is really drawing.
 *
 * Counted where the raster happens, so a remote producer's local fallback and a spot-check redraw
 * both land here — they are host work and cost host time.
 */
interface HostRenderCost {
  frames: number;
  ms: number;
}

const store = globalThis as { __mafterHostRenderCost?: HostRenderCost };

export function resetHostRenderCost(): void {
  store.__mafterHostRenderCost = { frames: 0, ms: 0 };
}

export function noteHostRenderedFrame(ms = 0): void {
  const cost = store.__mafterHostRenderCost ?? { frames: 0, ms: 0 };
  cost.frames += 1;
  cost.ms += ms;
  store.__mafterHostRenderCost = cost;
}

export function getHostRenderCost(): HostRenderCost {
  return store.__mafterHostRenderCost ?? { frames: 0, ms: 0 };
}

/**
 * Mean cost of a frame on this machine, or null before enough frames to mean anything. The first
 * frame of an export pays for warm-up the rest do not, so it never answers from one sample.
 */
export function hostMsPerFrame(): number | null {
  const { frames, ms } = getHostRenderCost();
  if (frames < 2 || ms <= 0) return null;
  return ms / frames;
}
