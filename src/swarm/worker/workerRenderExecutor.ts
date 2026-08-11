import { MemoryFs } from "../../fs/MemoryFs";
import { captureCompFramePng, createCompFrameCaptureContext } from "../../runtime/compFrameCapture";
import { sha256Hex } from "../core/assetManifest";
import { runRenderBenchmark } from "../core/benchmark";
import type { SwarmAssetTransfer, SwarmRenderJob, SwarmRenderResult } from "../core/types";
import { BoundedWorkerAssetCache } from "./workerCache";

function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

export class WorkerRenderExecutor {
  private readonly assetCache = new BoundedWorkerAssetCache();

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
    const context = await createCompFrameCaptureContext(job.project, job.compositionId, fs, {
      textQuality: job.profile.quality,
      proxyScale: job.profile.width / Math.max(1, composition.width),
    });
    try {
      const bytes = await captureCompFramePng(
        context,
        composition,
        job.frameStart,
      );
      return {
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
    } finally {
      context.dispose();
    }
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
