import type { TimelineComposition } from "../core/schema";
import { globalPluginRegistry } from "../runtime/pluginRegistry";

const SAMPLE_SIZE = 8;
const REALTIME_HEADROOM = 0.85;

/** §28.4 リアルタイム再生可否のヒューリスティック。 */
export class RealtimeDetector {
  private samples: number[] = [];
  private forcedNonRealtime = false;

  reset(): void {
    this.samples = [];
    this.forcedNonRealtime = false;
  }

  setForcedNonRealtime(value: boolean): void {
    this.forcedNonRealtime = value;
  }

  recordRenderMs(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > SAMPLE_SIZE) this.samples.shift();
  }

  hasEnoughSamples(): boolean {
    return this.samples.length >= 2;
  }

  isRealtimeCapable(fps: number): boolean {
    if (this.forcedNonRealtime) return false;
    if (this.samples.length < 2) return false;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const budget = (1000 / fps) * REALTIME_HEADROOM;
    return median < budget;
  }
}

export function compHasRasterEffect(comp: TimelineComposition): boolean {
  for (const obj of comp.objects) {
    for (const fx of obj.effects ?? []) {
      if (!fx.enabled) continue;
      const def = globalPluginRegistry.getEffectDef(fx.type);
      if (def?.processPixels) return true;
    }
  }
  return false;
}

export function shouldForceNonRealtime(
  _quality: "draft" | "precise",
  proxy: string,
  comp: TimelineComposition,
): boolean {
  if (proxy !== "full") return true;
  if (compHasRasterEffect(comp)) return true;
  return false;
}
