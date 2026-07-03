import type { Frame, Vec3 } from "../../core/schema";
import { addVec3, rawTranslationToMafterDelta } from "./coordConvert";
import {
  computeMotionTrackCompFrames,
  extractFramesForMotionTrack,
  resolveVideoAssetUrl,
} from "./frameExtractor";
import { smoothTranslations } from "./smoothPoses";
import type {
  MotionTrackWorkerRequest,
  MotionTrackWorkerResponse,
  RawPose,
  RawTranslation,
  TrackOptions,
  TrackProgress,
  TrackResult,
} from "./types";
import type { FileSystem } from "../../fs/FileSystem";
import type { Project, SceneObject, TimelineComposition } from "../../core/schema";
import type { ImageAssetCache } from "../../runtime/imageAssetCache";

const WARMUP_FRAMES = 4;
const MIN_CONFIDENCE = 1;

export const QUAR_WASM_URL = "/motion-track/pkg/quar_engine.js";

function isValidEstimate(frameIndex: number, confidence: number): boolean {
  if (frameIndex < WARMUP_FRAMES) return false;
  return confidence >= MIN_CONFIDENCE;
}

function wasmAbsoluteUrl(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return new URL(QUAR_WASM_URL, window.location.origin).href;
  }
  return QUAR_WASM_URL;
}

export class QuarMotionTracker {
  private worker: Worker | null = null;
  private ready = false;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL("./motionTrackWorker.ts", import.meta.url), { type: "module" });
    this.worker.onerror = () => {
      this.dispose();
    };
    return this.worker;
  }

  async init(): Promise<number> {
    const w = this.ensureWorker();
    return new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("tracker init timeout")), 60000);
      const onMsg = (ev: MessageEvent<MotionTrackWorkerResponse>) => {
        const m = ev.data;
        if (m.type === "ready") {
          window.clearTimeout(timeout);
          w.removeEventListener("message", onMsg);
          this.ready = true;
          resolve(m.initMs);
        } else if (m.type === "error") {
          window.clearTimeout(timeout);
          w.removeEventListener("message", onMsg);
          reject(new Error(m.message));
        }
      };
      w.addEventListener("message", onMsg);
      const req: MotionTrackWorkerRequest = { type: "init", wasmUrl: wasmAbsoluteUrl() };
      w.postMessage(req);
    });
  }

  async processFrame(
    idx: number,
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
  ): Promise<{ translation: RawTranslation | null; confidence: number; processMs: number }> {
    if (!this.ready || !this.worker) throw new Error("tracker not ready");
    const w = this.worker;
    const buf = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength) as ArrayBuffer;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error(`frame ${idx} timeout`)), 120000);
      const onMsg = (ev: MessageEvent<MotionTrackWorkerResponse>) => {
        const m = ev.data;
        if (m.type === "pose" && m.idx === idx) {
          window.clearTimeout(timeout);
          w.removeEventListener("message", onMsg);
          if (m.error) reject(new Error(m.error));
          else resolve({ translation: m.translation, confidence: m.confidence, processMs: m.processMs });
        } else if (m.type === "error") {
          window.clearTimeout(timeout);
          w.removeEventListener("message", onMsg);
          reject(new Error(m.message));
        }
      };
      w.addEventListener("message", onMsg);
      const req: MotionTrackWorkerRequest = { type: "frame", idx, data: buf, w: width, h: height };
      w.postMessage(req, [buf]);
    });
  }

  dispose(): void {
    if (this.worker) {
      const req: MotionTrackWorkerRequest = { type: "dispose" };
      this.worker.postMessage(req);
      this.worker.terminate();
    }
    this.worker = null;
    this.ready = false;
  }
}

export interface RunMotionTrackInput {
  project: Project;
  comp: TimelineComposition;
  videoLayer: SceneObject;
  assetId: string;
  fs: FileSystem;
  imageCache?: ImageAssetCache;
  options: TrackOptions;
  onProgress?: (p: TrackProgress) => void;
  signal?: AbortSignal;
}

export interface RunMotionTrackResult {
  track: TrackResult;
  compFrames: Frame[];
  validMask: boolean[];
  bakeStart: Frame;
  bakeEnd: Frame;
}

function buildPositionsFromTrack(
  compFrames: Frame[],
  smoothed: RawTranslation[],
  baseline: Vec3,
  userScale: number,
  validMask: boolean[],
): Map<Frame, Vec3> {
  const ref = smoothed[0] ?? [0, 0, 0];
  const map = new Map<Frame, Vec3>();
  for (let i = 0; i < compFrames.length; i++) {
    const f = compFrames[i]!;
    if (!validMask[i]) {
      map.set(f, { ...baseline });
      continue;
    }
    const t = smoothed[i] ?? ref;
    const delta = rawTranslationToMafterDelta(
      [t[0] - ref[0], t[1] - ref[1], t[2] - ref[2]],
      userScale,
    );
    map.set(f, addVec3(baseline, delta));
  }
  return map;
}

export async function runMotionTrack(input: RunMotionTrackInput): Promise<RunMotionTrackResult> {
  const { project, comp, videoLayer, assetId, fs, imageCache, options, onProgress, signal } = input;
  const asset = project.assets.find((a) => a.id === assetId);
  const durationSec =
    asset?.meta && typeof asset.meta.duration === "number" ? asset.meta.duration : undefined;

  const compFrames = computeMotionTrackCompFrames(
    videoLayer,
    comp.fps,
    durationSec,
    options.sampleInterval,
  );
  if (compFrames.length === 0) throw new Error("no frames in track range");

  onProgress?.({ phase: "loading", current: 0, total: 1 });
  const tracker = new QuarMotionTracker();
  try {
    await tracker.init();

    const videoUrl = await resolveVideoAssetUrl(project, assetId, fs, imageCache);
    if (!videoUrl) throw new Error("video asset URL not available");

    const trimStart =
      typeof videoLayer.components.find((c) => c.type === "video")?.props["trimStart"] === "number"
        ? (videoLayer.components.find((c) => c.type === "video")!.props["trimStart"] as number)
        : 0;

    onProgress?.({ phase: "extracting", current: 0, total: compFrames.length });
    const extracted = await extractFramesForMotionTrack({
      videoUrl,
      fps: comp.fps,
      inPoint: videoLayer.inPoint,
      trimStart,
      compFrames,
      targetWidth: options.targetWidth,
      signal,
      onProgress: (current, total) => onProgress?.({ phase: "extracting", current, total }),
    });

    const poses: RawPose[] = [];
    const rawTranslations: Array<RawTranslation | null> = [];
    const validMask: boolean[] = [];

    onProgress?.({ phase: "tracking", current: 0, total: extracted.length });
    for (let i = 0; i < extracted.length; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const fr = extracted[i]!;
      const res = await tracker.processFrame(i, fr.rgba, fr.width, fr.height);
      const valid = res.translation !== null && isValidEstimate(i, res.confidence);
      rawTranslations.push(valid ? res.translation : null);
      validMask.push(valid);
      poses.push({
        frame: fr.compFrame,
        translation: res.translation,
        confidence: res.confidence,
        processMs: res.processMs,
      });
      onProgress?.({ phase: "tracking", current: i + 1, total: extracted.length });
    }

    const smoothed = smoothTranslations(rawTranslations);
    const bakeStart = compFrames[0]!;
    const bakeEnd = (compFrames[compFrames.length - 1] ?? bakeStart) + 1;

    return {
      track: { poses, smoothed },
      compFrames,
      validMask,
      bakeStart,
      bakeEnd,
    };
  } finally {
    tracker.dispose();
  }
}

/** トラッキング結果 + baseline からベイク用 position 列を生成。 */
export function finalizeMotionTrackBake(
  compFrames: Frame[],
  smoothed: RawTranslation[],
  validMask: boolean[],
  baseline: Vec3,
  userScale: number,
): Map<Frame, Vec3> {
  return buildPositionsFromTrack(compFrames, smoothed, baseline, userScale, validMask);
}
