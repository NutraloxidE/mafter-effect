import type { SwarmRenderJob } from "./types";

/**
 * Self-contained benchmark job: an empty 320x180 timeline frame, so a worker can be scored the
 * moment it connects instead of waiting for the first distributable preview job (which may never
 * arrive for projects the swarm cannot take). Being project-independent also makes scores
 * comparable across sessions.
 */
export function createBenchmarkJob(runtimeVersion: string): SwarmRenderJob {
  const compositionId = "swarm-benchmark-comp";
  return {
    id: `swarm-benchmark-${Date.now()}`,
    kind: "preview-frame",
    renderRevision: "swarm-benchmark",
    compositionId,
    frameStart: 0,
    frameEnd: 1,
    priority: "background",
    profile: { quality: "draft", proxy: "half", width: 320, height: 180 },
    runtimeVersion,
    project: {
      schemaVersion: 1,
      meta: { name: "swarm-benchmark", createdAt: "", updatedAt: "" },
      assets: [],
      compositions: [{
        id: compositionId,
        name: "Benchmark",
        kind: "timeline",
        width: 320,
        height: 180,
        fps: 30,
        duration: 1,
        objects: [],
      }],
      rootComposition: compositionId,
      pluginRefs: [],
    },
    createdAt: 0,
  };
}

export interface BenchmarkResult {
  score: number;
  framesPerSecond: number;
  renderMs: number;
}

export async function runRenderBenchmark(
  renderFrame: () => Promise<void>,
  samples = 3,
): Promise<BenchmarkResult> {
  const count = Math.max(1, samples);
  const started = performance.now();
  for (let i = 0; i < count; i += 1) await renderFrame();
  const elapsed = Math.max(0.1, performance.now() - started);
  const renderMs = elapsed / count;
  const framesPerSecond = 1000 / renderMs;
  return { score: framesPerSecond, framesPerSecond, renderMs };
}

export function normalizedBenchmarkScore(score: number, localScore: number): number {
  if (!Number.isFinite(score) || score <= 0 || !Number.isFinite(localScore) || localScore <= 0) return 0;
  return Math.max(0, Math.min(10, score / localScore));
}

export class Ewma {
  private value: number | null = null;

  constructor(private readonly alpha = 0.25) {}

  update(sample: number): number {
    if (!Number.isFinite(sample)) return this.value ?? 0;
    this.value = this.value === null ? sample : this.value + this.alpha * (sample - this.value);
    return this.value;
  }

  get(): number | null {
    return this.value;
  }
}
