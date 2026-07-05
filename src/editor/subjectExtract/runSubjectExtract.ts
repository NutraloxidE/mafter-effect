import type { Project, SceneObject, TimelineComposition } from "../../core/schema";
import type { FileSystem } from "../../fs/FileSystem";
import { ImageAssetCache } from "../../runtime/imageAssetCache";
import {
  computeMotionTrackCompFrames,
  extractFramesForMotionTrack,
  MOTION_TRACK_TARGET_WIDTH,
} from "../motionTrack/frameExtractor";
import { resolveVideoAssetUrl } from "../motionTrack/frameExtractor";
import { encodeRgbaFramesToSubjectWebm } from "./encodeAlphaWebm";
import { initPersonSegmenter, segmentPersonFrame } from "./personSegmenter";
import type { SubjectExtractOptions, SubjectExtractProgress, SubjectExtractResult } from "./types";

export interface RunSubjectExtractInput {
  project: Project;
  comp: TimelineComposition;
  videoLayer: SceneObject;
  assetId: string;
  fs: FileSystem;
  imageCache?: ImageAssetCache;
  options: SubjectExtractOptions;
  onProgress?: (p: SubjectExtractProgress) => void;
  signal?: AbortSignal;
}

export async function runSubjectExtract(input: RunSubjectExtractInput): Promise<SubjectExtractResult> {
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
  if (compFrames.length === 0) throw new Error("no frames in layer range");

  onProgress?.({ phase: "loading", current: 0, total: 1 });
  await initPersonSegmenter();

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
    targetWidth: options.targetWidth ?? MOTION_TRACK_TARGET_WIDTH,
    enhanceContrast: false,
    signal,
    onProgress: (current, total) => onProgress?.({ phase: "extracting", current, total }),
  });

  const maskedFrames: Array<{ width: number; height: number; rgba: Uint8ClampedArray }> = [];
  onProgress?.({ phase: "segmenting", current: 0, total: extracted.length });
  for (let i = 0; i < extracted.length; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const f = extracted[i]!;
    const rgba = await segmentPersonFrame(f.rgba, f.width, f.height);
    maskedFrames.push({ width: f.width, height: f.height, rgba });
    onProgress?.({ phase: "segmenting", current: i + 1, total: extracted.length });
    if (i % 2 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  onProgress?.({ phase: "encoding", current: 0, total: maskedFrames.length });
  const inkFrames = maskedFrames.filter((f) => {
    for (let i = 3; i < f.rgba.length; i += 4) {
      if (f.rgba[i]! > 16) return true;
    }
    return false;
  }).length;
  if (inkFrames === 0) {
    throw new Error(
      "人物マスクが検出されませんでした。映像に人物が写っているか、ライティングを確認してください。",
    );
  }
  const minInkRatio = 0.05;
  const minInk = Math.floor(maskedFrames[0]!.width * maskedFrames[0]!.height * minInkRatio);
  const maxInkRatio = 0.95;
  const maxInk = Math.floor(maskedFrames[0]!.width * maskedFrames[0]!.height * maxInkRatio);
  for (const f of maskedFrames) {
    let ink = 0;
    for (let i = 3; i < f.rgba.length; i += 4) {
      if (f.rgba[i]! > 16) ink++;
    }
    if (ink < minInk || ink > maxInk) {
      throw new Error(
        `人物マスクの面積が異常です（${Math.round((ink / (f.width * f.height)) * 100)}%）。Extract をやり直すか、別フレーム間隔を試してください。`,
      );
    }
  }

  const encoded = await encodeRgbaFramesToSubjectWebm(
    maskedFrames,
    comp.fps,
    (current, total) => onProgress?.({ phase: "encoding", current, total }),
    signal,
  );

  const w = maskedFrames[0]!.width;
  const h = maskedFrames[0]!.height;
  const duration = compFrames.length / comp.fps;

  if (encoded.mode === "unified") {
    return {
      mode: "unified",
      webmBytes: encoded.webm,
      width: w,
      height: h,
      durationSec: duration,
      frameCount: maskedFrames.length,
      fps: comp.fps,
    };
  }

  return {
    mode: "split",
    webmBytes: encoded.colorWebm,
    alphaWebmBytes: encoded.alphaWebm,
    width: w,
    height: h,
    durationSec: duration,
    frameCount: maskedFrames.length,
    fps: comp.fps,
  };
}
