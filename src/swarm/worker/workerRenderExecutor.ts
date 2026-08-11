import { MemoryFs } from "../../fs/MemoryFs";
import { captureCompFramePng, createCompFrameCaptureContext } from "../../runtime/compFrameCapture";
import { sha256Hex } from "../core/assetManifest";
import { runRenderBenchmark } from "../core/benchmark";
import type { TimelineComposition } from "../../core/schema";
import type { SwarmAssetTransfer, SwarmRenderJob, SwarmRenderResult } from "../core/types";
import { BoundedWorkerAssetCache } from "./workerCache";

function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

interface CachedContext {
  key: string;
  fs: MemoryFs;
  context: Awaited<ReturnType<typeof createCompFrameCaptureContext>>;
}

/** Mirrors the exporter: transparent for an alpha export, else the comp background or black. */
function exportBackground(job: SwarmRenderJob, comp: TimelineComposition): string | undefined {
  if (job.profile.alpha === undefined) return undefined;
  if (job.profile.alpha) return "transparent";
  const background = comp.background;
  if (!background) return "#000000";
  const hex = (value: number): string => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0");
  return `#${hex(background.r)}${hex(background.g)}${hex(background.b)}`;
}

export class WorkerRenderExecutor {
  private readonly assetCache = new BoundedWorkerAssetCache();
  private cached: CachedContext | null = null;

  /** Stores a fully reassembled file; the cache verifies its content hash before accepting it. */
  async cacheAsset(transfer: SwarmAssetTransfer): Promise<boolean> {
    return this.assetCache.put(transfer);
  }

  async render(job: SwarmRenderJob): Promise<SwarmRenderResult> {
    const fs = new MemoryFs();
    for (const asset of job.assets ?? []) {
      // Files usually arrive ahead of the job as chunks; inline bytes remain valid for small ones.
      let bytes = this.assetCache.get(asset.contentHash);
      if (!bytes) {
        if (!asset.bytesBase64 || !(await this.assetCache.put(asset))) {
          throw new Error(`Worker is missing asset: ${asset.path}`);
        }
        bytes = this.assetCache.get(asset.contentHash);
      }
      if (!bytes) throw new Error(`Worker asset cache miss: ${asset.path}`);
      await fs.write(asset.path, bytes);
    }
    const composition = job.project.compositions.find((comp) => comp.id === job.compositionId);
    if (!composition || composition.kind !== "timeline") throw new Error("Worker job composition is not a timeline");
    const context = await this.contextFor(job, composition, fs);
    {
      const startedAt = performance.now();
      const background = exportBackground(job, composition);
      let bytes = await captureCompFramePng(context, composition, job.frameStart, background);
      // The decode wait is best-effort: on timeout the frame is composited with the footage still
      // at its previous position, which looks plausible and is simply wrong. Retry once, then let
      // the host render it rather than returning pixels we know are off.
      if (!context.renderer.videosAtExportTarget(composition.fps)) {
        bytes = await captureCompFramePng(context, composition, job.frameStart, background);
        if (!context.renderer.videosAtExportTarget(composition.fps)) {
          throw new Error(`Worker footage did not reach frame ${job.frameStart}`);
        }
      }
      const renderMs = performance.now() - startedAt;
      return {
        renderMs,
        jobId: job.id,
        renderRevision: job.renderRevision,
        compositionId: job.compositionId,
        frameStart: job.frameStart,
        frameEnd: job.frameEnd,
        width: job.profile.width,
        height: job.profile.height,
        format: "png",
        bytesBase64: bytesToBase64(bytes),
        byteLength: bytes.byteLength,
        contentHash: await sha256Hex(bytes),
        runtimeVersion: job.runtimeVersion,
      };
    }
  }

  /**
   * Reuses one capture context across jobs for the same composition and profile. Building it per
   * frame reloads the footage and restarts decoding every time, which both costs more than the
   * render and occasionally exceeds the decode wait, returning a frame with the video missing.
   */
  private async contextFor(
    job: SwarmRenderJob,
    composition: TimelineComposition,
    fs: MemoryFs,
  ): Promise<Awaited<ReturnType<typeof createCompFrameCaptureContext>>> {
    const key = [
      job.renderRevision,
      job.compositionId,
      job.profile.quality,
      job.profile.width,
      job.profile.height,
    ].join("|");
    if (this.cached?.key === key) return this.cached.context;
    this.dispose();
    const context = await createCompFrameCaptureContext(job.project, job.compositionId, fs, {
      textQuality: job.profile.quality,
      proxyScale: job.profile.width / Math.max(1, composition.width),
    });
    this.cached = { key, fs, context };
    return context;
  }

  /** Frees the renderer, its DOM and any GL contexts it holds. */
  dispose(): void {
    this.cached?.context.dispose();
    this.cached = null;
  }

  async benchmark(job: SwarmRenderJob): Promise<{ score: number; framesPerSecond: number; renderMs: number }> {
    let lastRenderMs = 0;
    const result = await runRenderBenchmark(async () => {
      const started = performance.now();
      await this.render(job);
      lastRenderMs = performance.now() - started;
    }, 2);
    return { ...result, renderMs: lastRenderMs > 0 ? lastRenderMs : result.renderMs };
  }
}
