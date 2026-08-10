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
