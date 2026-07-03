import type { Frame, Vec3 } from "../../core/schema";
import { addVec3, rawTranslationToMafterDelta } from "./coordConvert";
import {
  computeMotionTrackCompFrames,
  extractFramesForMotionTrack,
  resolveVideoAssetUrl,
} from "./frameExtractor";
import { smoothTranslations, smoothRotations } from "./smoothPoses";
import { composeBaselineRotation } from "./coordConvert";
import { quaternionMultiply, quaternionNormalize } from "./rotationEstimator";
import type {
  MotionTrackWorkerRequest,
  MotionTrackWorkerResponse,
  RawPose,
  RawQuaternion,
  RawRotationPose,
  RawTranslation,
  RotationTrackOptions,
  RotationTrackResult,
  RotationTrackWorkerRequest,
  RotationTrackWorkerResponse,
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

export const OPENCV_JS_URL = "/motion-track/opencv/opencv.js";

const ROT_WARMUP_FRAMES = 4;
const MIN_INLIER_RATIO = 0.2;
const MAX_RESIDUAL = 0.08;

function isValidRotationEstimate(
  frameIndex: number,
  inlierRatio: number,
  residual: number,
): boolean {
  if (frameIndex < ROT_WARMUP_FRAMES) return false;
  if (inlierRatio < MIN_INLIER_RATIO) return false;
  if (!Number.isFinite(residual) || residual > MAX_RESIDUAL) return false;
  return true;
}

function opencvAbsoluteUrl(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return new URL(OPENCV_JS_URL, window.location.origin).href;
  }
  return OPENCV_JS_URL;
}

export class RotationMotionTracker {
  private worker: Worker | null = null;
  private ready = false;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL("./rotationTrackWorker.ts", import.meta.url), { type: "module" });
    this.worker.onerror = () => {
      this.dispose();
    };
    return this.worker;
  }

  async init(): Promise<number> {
    const w = this.ensureWorker();
    return new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("rotation tracker init timeout")), 120000);
      const onMsg = (ev: MessageEvent<RotationTrackWorkerResponse>) => {
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
      const req: RotationTrackWorkerRequest = { type: "init", opencvUrl: opencvAbsoluteUrl() };
      w.postMessage(req);
    });
  }

  async processFrame(
    idx: number,
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
    focalLength: number,
    reset: boolean,
  ): Promise<{
    rotation: RawQuaternion | null;
    inlierRatio: number;
    residual: number;
    processMs: number;
  }> {
    if (!this.ready || !this.worker) throw new Error("rotation tracker not ready");
    const w = this.worker;
    const buf = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength) as ArrayBuffer;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error(`rotation frame ${idx} timeout`)), 120000);
      const onMsg = (ev: MessageEvent<RotationTrackWorkerResponse>) => {
        const m = ev.data;
        if (m.type === "rotation" && m.idx === idx) {
          window.clearTimeout(timeout);
          w.removeEventListener("message", onMsg);
          if (m.error) reject(new Error(m.error));
          else
            resolve({
              rotation: m.rotation,
              inlierRatio: m.inlierRatio,
              residual: m.residual,
              processMs: m.processMs,
            });
        } else if (m.type === "error") {
          window.clearTimeout(timeout);
          w.removeEventListener("message", onMsg);
          reject(new Error(m.message));
        }
      };
      w.addEventListener("message", onMsg);
      const req: RotationTrackWorkerRequest = {
        type: "frame",
        idx,
        data: buf,
        w: width,
        h: height,
        focalLength,
        reset,
      };
      w.postMessage(req, [buf]);
    });
  }

  dispose(): void {
    if (this.worker) {
      const req: RotationTrackWorkerRequest = { type: "dispose" };
      this.worker.postMessage(req);
      this.worker.terminate();
    }
    this.worker = null;
    this.ready = false;
  }
}

export interface RunRotationTrackInput {
  project: Project;
  comp: TimelineComposition;
  videoLayer: SceneObject;
  assetId: string;
  fs: FileSystem;
  imageCache?: ImageAssetCache;
  options: RotationTrackOptions;
  onProgress?: (p: TrackProgress) => void;
  signal?: AbortSignal;
}

export interface RunRotationTrackResult {
  track: RotationTrackResult;
  compFrames: Frame[];
  validMask: boolean[];
  bakeStart: Frame;
  bakeEnd: Frame;
}

function buildRotationsFromTrack(
  compFrames: Frame[],
  smoothedCumulative: RawQuaternion[],
  baseline: Vec3,
  validMask: boolean[],
): Map<Frame, Vec3> {
  const map = new Map<Frame, Vec3>();
  for (let i = 0; i < compFrames.length; i++) {
    const f = compFrames[i]!;
    if (!validMask[i]) {
      const prev = i > 0 ? map.get(compFrames[i - 1]!) : undefined;
      map.set(f, prev ? { ...prev } : { ...baseline });
      continue;
    }
    const cum = smoothedCumulative[i] ?? [0, 0, 0, 1];
    map.set(f, composeBaselineRotation(baseline, cum));
  }
  return map;
}

export async function runRotationTrack(input: RunRotationTrackInput): Promise<RunRotationTrackResult> {
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
  const tracker = new RotationMotionTracker();
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

    const poses: RawRotationPose[] = [];
    const rawDeltas: Array<RawQuaternion | null> = [];
    const validMask: boolean[] = [];

    onProgress?.({ phase: "tracking", current: 0, total: extracted.length });
    for (let i = 0; i < extracted.length; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const fr = extracted[i]!;
      const res = await tracker.processFrame(
        i,
        fr.rgba,
        fr.width,
        fr.height,
        options.focalLength,
        i === 0,
      );
      const valid =
        i > 0 &&
        res.rotation !== null &&
        isValidRotationEstimate(i, res.inlierRatio, res.residual);
      rawDeltas.push(i === 0 ? null : valid ? res.rotation : null);
      validMask.push(i === 0 ? true : valid);
      poses.push({
        frame: fr.compFrame,
        rotation: i === 0 ? null : res.rotation,
        inlierRatio: res.inlierRatio,
        residual: res.residual,
        processMs: res.processMs,
      });
      onProgress?.({ phase: "tracking", current: i + 1, total: extracted.length });
    }

    const deltaSmoothed = smoothRotations(rawDeltas);
    const cumulative: RawQuaternion[] = [[0, 0, 0, 1]];
    let cum: RawQuaternion = [0, 0, 0, 1];
    for (let i = 1; i < deltaSmoothed.length; i++) {
      cum = quaternionNormalize(quaternionMultiply(cum, deltaSmoothed[i]!));
      cumulative.push([...cum]);
    }

    const bakeStart = compFrames[0]!;
    const bakeEnd = (compFrames[compFrames.length - 1] ?? bakeStart) + 1;

    return {
      track: { poses, smoothed: cumulative },
      compFrames,
      validMask,
      bakeStart,
      bakeEnd,
    };
  } finally {
    tracker.dispose();
  }
}

export interface RunCombinedMotionTrackInput {
  project: Project;
  comp: TimelineComposition;
  videoLayer: SceneObject;
  assetId: string;
  fs: FileSystem;
  imageCache?: ImageAssetCache;
  options: RotationTrackOptions;
  onProgress?: (p: TrackProgress) => void;
  signal?: AbortSignal;
}

export interface RunCombinedMotionTrackResult {
  position: RunMotionTrackResult;
  rotation: RunRotationTrackResult;
}

/** フレーム抽出は 1 回。QUAR 並進 + OpenCV 回転を同一ループで処理。 */
export async function runCombinedMotionTrack(
  input: RunCombinedMotionTrackInput,
): Promise<RunCombinedMotionTrackResult> {
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

  onProgress?.({ phase: "loading", current: 0, total: 2 });
  const quarTracker = new QuarMotionTracker();
  const rotTracker = new RotationMotionTracker();
  try {
    await Promise.all([quarTracker.init(), rotTracker.init()]);
    onProgress?.({ phase: "loading", current: 2, total: 2 });

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

    const posPoses: RawPose[] = [];
    const rawTranslations: Array<RawTranslation | null> = [];
    const posValidMask: boolean[] = [];

    const rotPoses: RawRotationPose[] = [];
    const rawDeltas: Array<RawQuaternion | null> = [];
    const rotValidMask: boolean[] = [];

    onProgress?.({ phase: "tracking", current: 0, total: extracted.length });
    for (let i = 0; i < extracted.length; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const fr = extracted[i]!;
      const quarRgba = new Uint8ClampedArray(fr.rgba);
      const rotRgba = new Uint8ClampedArray(fr.rgba);

      const posRes = await quarTracker.processFrame(i, quarRgba, fr.width, fr.height);
      const posValid = posRes.translation !== null && isValidEstimate(i, posRes.confidence);
      rawTranslations.push(posValid ? posRes.translation : null);
      posValidMask.push(posValid);
      posPoses.push({
        frame: fr.compFrame,
        translation: posRes.translation,
        confidence: posRes.confidence,
        processMs: posRes.processMs,
      });

      const rotRes = await rotTracker.processFrame(
        i,
        rotRgba,
        fr.width,
        fr.height,
        options.focalLength,
        i === 0,
      );
      const rotValid =
        i > 0 &&
        rotRes.rotation !== null &&
        isValidRotationEstimate(i, rotRes.inlierRatio, rotRes.residual);
      rawDeltas.push(i === 0 ? null : rotValid ? rotRes.rotation : null);
      rotValidMask.push(i === 0 ? true : rotValid);
      rotPoses.push({
        frame: fr.compFrame,
        rotation: i === 0 ? null : rotRes.rotation,
        inlierRatio: rotRes.inlierRatio,
        residual: rotRes.residual,
        processMs: rotRes.processMs,
      });

      onProgress?.({ phase: "tracking", current: i + 1, total: extracted.length });
    }

    const posSmoothed = smoothTranslations(rawTranslations);
    const deltaSmoothed = smoothRotations(rawDeltas);
    const cumulative: RawQuaternion[] = [[0, 0, 0, 1]];
    let cum: RawQuaternion = [0, 0, 0, 1];
    for (let i = 1; i < deltaSmoothed.length; i++) {
      cum = quaternionNormalize(quaternionMultiply(cum, deltaSmoothed[i]!));
      cumulative.push([...cum]);
    }

    const bakeStart = compFrames[0]!;
    const bakeEnd = (compFrames[compFrames.length - 1] ?? bakeStart) + 1;

    return {
      position: {
        track: { poses: posPoses, smoothed: posSmoothed },
        compFrames,
        validMask: posValidMask,
        bakeStart,
        bakeEnd,
      },
      rotation: {
        track: { poses: rotPoses, smoothed: cumulative },
        compFrames,
        validMask: rotValidMask,
        bakeStart,
        bakeEnd,
      },
    };
  } finally {
    quarTracker.dispose();
    rotTracker.dispose();
  }
}

/** トラッキング結果 + baseline からベイク用 rotation 列を生成。 */
export function finalizeRotationTrackBake(
  compFrames: Frame[],
  smoothedCumulative: RawQuaternion[],
  validMask: boolean[],
  baseline: Vec3,
): Map<Frame, Vec3> {
  return buildRotationsFromTrack(compFrames, smoothedCumulative, baseline, validMask);
}
