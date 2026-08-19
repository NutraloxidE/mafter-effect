import { exportComposition, type ExportSession, type ExportTimingHooks } from "../../runtime/exporter";
import { compTreeHasVideo } from "../../runtime/multiRenderContext";
import { MemoryFs } from "../../fs/MemoryFs";
import { captureCompFramePng, createCompFrameCaptureContext, type CompFrameCaptureTiming } from "../../runtime/compFrameCapture";
import { sha256Hex } from "../core/assetManifest";
import { runRenderBenchmark } from "../core/benchmark";
import type { TimelineComposition } from "../../core/schema";
import type { SwarmAssetTransfer, SwarmRenderJob, SwarmRenderResult, SwarmWorkerSeek, SwarmWorkerTiming } from "../core/types";
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

function emptyWorkerTiming(): SwarmWorkerTiming {
  return {
    sessionPrepareMs: 0,
    footageWarmupMs: 0,
    blockOpeningWarmupMs: 0,
    frameRetryWarmupMs: 0,
    renderMs: 0,
    pngEncodeMs: 0,
    zipFinalizeMs: 0,
    base64Ms: 0,
    hashMs: 0,
  };
}

export type WorkerRenderProgress = (completedFrames: number, totalFrames: number) => void;

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
  private session: { key: string; holder: { current: ExportSession | null } } = { key: "", holder: { current: null } };
  /** Job-order evidence, reset whenever the session is rebuilt: it belongs to one decoder's life. */
  private previousRangeEndFrame: number | null = null;
  private sessionCreatedCount = 0;
  private sessionReusedCount = 0;

  /** Stores a fully reassembled file; the cache verifies its content hash before accepting it. */
  async cacheAsset(transfer: SwarmAssetTransfer): Promise<boolean> {
    return this.assetCache.put(transfer);
  }

  cachedAssetHashes(): string[] {
    return this.assetCache.hashes();
  }

  /**
   * Renders a frame range through `exportComposition` — the host's own export path — instead of a
   * worker-specific capture. Every divergence found so far (background, layout scale, a missing
   * text layer, footage timing) came from having a second path; sharing one removes the class.
   */
  async renderRange(
    job: SwarmRenderJob,
    fs: MemoryFs,
    composition: TimelineComposition,
    onProgress?: WorkerRenderProgress,
    timing: SwarmWorkerTiming = emptyWorkerTiming(),
  ): Promise<SwarmRenderResult> {
    const startedAt = performance.now();
    const scale = job.profile.width / Math.max(1, composition.width);
    // Building the export's offscreen world costs about as much as rendering eight frames — a
    // whole job — and reloads the footage every time, which on a slow machine is exactly when the
    // decode wait times out and the block comes back without its video. One world per revision.
    const sessionKey = [job.renderRevision, job.compositionId, job.profile.quality, job.profile.width].join("|");
    if (this.session.key !== sessionKey) {
      this.session.holder.current?.dispose();
      this.session = { key: sessionKey, holder: { current: null } };
      this.previousRangeEndFrame = null;
      this.sessionCreatedCount += 1;
    } else {
      this.sessionReusedCount += 1;
    }
    const previousRangeEndFrame = this.previousRangeEndFrame;
    const seekDeltaFrames = previousRangeEndFrame === null ? null : job.frameStart - previousRangeEndFrame;
    const workerSeek: SwarmWorkerSeek = {
      previousRangeEndFrame,
      currentRangeStartFrame: job.frameStart,
      seekDeltaFrames,
      seekDirection: seekDeltaFrames === null ? "first" : seekDeltaFrames < 0 ? "backward" : seekDeltaFrames > 0 ? "forward" : "same",
      sessionCreatedCount: this.sessionCreatedCount,
      sessionReusedCount: this.sessionReusedCount,
    };
    this.previousRangeEndFrame = job.frameEnd;
    const timingHooks: ExportTimingHooks = {
      onTiming: (phase, durationMs) => {
        timing[phase] += Math.max(0, durationMs);
      },
    };
    const result = await exportComposition(job.project, job.compositionId, fs, {
      range: [job.frameStart, job.frameEnd],
      fps: composition.fps,
      scale,
      format: "png-seq",
      alpha: job.profile.alpha ?? false,
      textRenderMode: job.profile.quality === "draft" ? "draft" : "precise",
    }, (progress) => {
      if (progress.phase !== "render") return;
      onProgress?.(Math.min(job.frameEnd - job.frameStart, Math.max(0, progress.frame + 1)), job.frameEnd - job.frameStart);
    }, undefined, undefined, { strictFootage: true, session: this.session.holder, timing: timingHooks });
    // `strictFootage` compares each video against its target time, which says nothing when there
    // are no video elements at all — exactly the shape of the blocks that came back at a thirteenth
    // of the expected size, with the footage layers simply absent.
    const renderer = this.session.holder.current?.renderer;
    if (renderer && compTreeHasVideo(job.project, composition) && renderer.videoElementCount() === 0) {
      this.session.holder.current?.dispose();
      this.session = { key: "", holder: { current: null } };
      this.previousRangeEndFrame = null;
      throw new Error("Worker rendered no footage for a composition that has video");
    }
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const base64StartedAt = performance.now();
    const bytesBase64 = bytesToBase64(bytes);
    timing.base64Ms += performance.now() - base64StartedAt;
    const hashStartedAt = performance.now();
    const contentHash = await sha256Hex(bytes);
    timing.hashMs += performance.now() - hashStartedAt;
    return {
      jobId: job.id,
      renderRevision: job.renderRevision,
      compositionId: job.compositionId,
      frameStart: job.frameStart,
      frameEnd: job.frameEnd,
      width: job.profile.width,
      height: job.profile.height,
      format: "png-zip",
      bytesBase64,
      byteLength: bytes.byteLength,
      contentHash,
      runtimeVersion: job.runtimeVersion,
      workerTiming: { ...timing },
      workerSeek,
      renderMs: performance.now() - startedAt,
    };
  }

  async render(job: SwarmRenderJob, onProgress?: WorkerRenderProgress): Promise<SwarmRenderResult> {
    const fs = new MemoryFs();
    const timing = emptyWorkerTiming();
    const assetPrepareStartedAt = performance.now();
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
    timing.sessionPrepareMs += performance.now() - assetPrepareStartedAt;
    const composition = job.project.compositions.find((comp) => comp.id === job.compositionId);
    if (!composition || composition.kind !== "timeline") throw new Error("Worker job composition is not a timeline");
    if (job.frameEnd - job.frameStart > 1) return this.renderRange(job, fs, composition, onProgress, timing);
    const contextPrepareStartedAt = performance.now();
    const context = await this.contextFor(job, composition, fs);
    timing.sessionPrepareMs += performance.now() - contextPrepareStartedAt;
    {
      const startedAt = performance.now();
      const background = exportBackground(job, composition);
      const captureTiming: CompFrameCaptureTiming = {
        onTiming: (phase, durationMs) => {
          timing[phase] += Math.max(0, durationMs);
        },
      };
      let bytes = await captureCompFramePng(context, composition, job.frameStart, background, captureTiming);
      // The decode wait is best-effort: on timeout the frame is composited with the footage still
      // at its previous position, which looks plausible and is simply wrong. Retry once, then let
      // the host render it rather than returning pixels we know are off.
      if (!context.renderer.videosAtExportTarget(composition.fps)) {
        bytes = await captureCompFramePng(context, composition, job.frameStart, background, captureTiming);
        if (!context.renderer.videosAtExportTarget(composition.fps)) {
          throw new Error(`Worker footage did not reach frame ${job.frameStart}`);
        }
      }
      const renderMs = performance.now() - startedAt;
      onProgress?.(1, 1);
      const base64StartedAt = performance.now();
      const bytesBase64 = bytesToBase64(bytes);
      timing.base64Ms += performance.now() - base64StartedAt;
      const hashStartedAt = performance.now();
      const contentHash = await sha256Hex(bytes);
      timing.hashMs += performance.now() - hashStartedAt;
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
        bytesBase64,
        byteLength: bytes.byteLength,
        contentHash,
        runtimeVersion: job.runtimeVersion,
        workerTiming: { ...timing },
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
    this.cached?.context.dispose();
    this.cached = null;
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
    this.session.holder.current?.dispose();
    this.session = { key: "", holder: { current: null } };
    this.previousRangeEndFrame = null;
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
