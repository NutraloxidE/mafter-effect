import type { Project, SceneObject, TimelineComposition } from "../../core/schema";
import type { FileSystem } from "../../fs/FileSystem";
import { loadAudioBuffer } from "../audioBufferCache";
import { ImageAssetCache } from "../../runtime/imageAssetCache";
import type { AudioMixResult } from "../../runtime/exporter";
import {
  computeMotionTrackCompFrames,
  extractFramesForMotionTrack,
  MOTION_TRACK_TARGET_WIDTH,
} from "../motionTrack/frameExtractor";
import { resolveVideoAssetUrl } from "../motionTrack/frameExtractor";
import { encodeRgbaFramesToSubjectWebm } from "./encodeAlphaWebm";
import { initPersonSegmenter, segmentPersonFrame } from "./personSegmenter";
import type { SubjectExtractOptions, SubjectExtractProgress, SubjectExtractResult } from "./types";

/**
 * 元 footage 音声を [startSec, startSec+durationSec) で切り出す。§2.2 packed に同梱する
 * 音声トラックは、映像と同じ範囲・同じ実時間長で対応させる（sampleInterval で間引かれた
 * フレーム列とは無関係に、encoder は frameCount/fps を均等割りしたタイムスタンプで書き出すため）。
 */
function sliceAudioBufferForRange(
  source: AudioBuffer,
  startSec: number,
  durationSec: number,
): AudioBuffer | null {
  const sampleRate = source.sampleRate;
  const startSample = Math.max(0, Math.floor(startSec * sampleRate));
  if (startSample >= source.length) return null;
  const frameCount = Math.max(1, Math.min(source.length - startSample, Math.round(durationSec * sampleRate)));
  const out = new AudioBuffer({ length: frameCount, numberOfChannels: source.numberOfChannels, sampleRate });
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    const data = source.getChannelData(ch).slice(startSample, startSample + frameCount);
    out.copyToChannel(data, ch, 0);
  }
  return out;
}

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

  const duration = compFrames.length / comp.fps;

  // §2.2 packed 用の音声（元 footage から実時間範囲だけ切り出す）。無音素材・decode 失敗時は
  // audioMix=null のまま進み、packed エンコーダは映像のみの mp4/webm を返す（best-effort）。
  // sampleInterval > 1 のときは compFrames が間引かれ、映像は実質的に時間圧縮（N倍速相当）される。
  // 音声を単純に「同じ duration だけ等速で切り出す」と間引かれていない実時間の一部を等速再生する
  // ことになり映像とズレる（正しく合わせるには音声側もタイムストレッチが要るが範囲外）。
  // このズレを防ぐため sampleInterval===1（既定・映像も間引かれない）のときだけ音声を同梱する。
  let audioMix: AudioMixResult | null = null;
  if (options.sampleInterval === 1) {
    try {
      const decoded = await loadAudioBuffer(assetId, () => fs.read(asset!.path));
      if (decoded) {
        const sliced = sliceAudioBufferForRange(decoded, trimStart, duration);
        if (sliced) {
          audioMix = { buffer: sliced, sampleRate: sliced.sampleRate, numberOfChannels: sliced.numberOfChannels };
        }
      }
    } catch {
      audioMix = null;
    }
  }

  const encoded = await encodeRgbaFramesToSubjectWebm(
    maskedFrames,
    comp.fps,
    audioMix,
    (current, total) => onProgress?.({ phase: "encoding", current, total }),
    signal,
  );

  const w = maskedFrames[0]!.width;
  const h = maskedFrames[0]!.height;

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

  if (encoded.mode === "packed") {
    return {
      mode: "packed",
      webmBytes: encoded.bytes,
      packedContainer: encoded.container,
      packedLayout: encoded.layout,
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
