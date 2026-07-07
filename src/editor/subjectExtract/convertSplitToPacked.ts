/**
 * §16.2 プランv2 §2.4 — 既存 split alpha アセット（color.webm + alpha.webm）を、
 * 1レイヤー/1アセット単位でオフライン packed 化する変換（非破壊・§2.4 参照）。
 *
 * 決定論の範囲（重要・2026-07-07 Opus 4.8 レビューで明確化）:
 *  - pack 算術（合成 RGBA 入力での color/mask 合成 + レイアウト）は純関数で決定論的。
 *  - 実動画を texImage2D/drawImage で decode した結果は環境依存の色差が乗りうる
 *    （Phase1 実測: maxDiff 22/255）ため、この関数の出力バイト列そのものの
 *    決定論性（同一入力→同一 packed バイト）までは主張しない。視覚一致は
 *    verify-*-e2e.mjs 側でピクセル許容差により確認する。
 *  - 元 split の color.webm には音声トラックが無く（Subject Extract の既存 encode
 *    経路がそもそも音声を含めていない）、`asset.meta` にも抽出元の時間範囲が
 *    残っていないため、変換後の packed には音声を同梱しない（無音）。
 */
import type { AssetEntry, Project, TimelineComposition } from "../../core/schema";
import type { FileSystem } from "../../fs/FileSystem";
import { newObjectId } from "../../core/ids";
import { DIR_ASSETS } from "../../core/paths";
import { isSplitAlphaVideoMeta } from "../../runtime/imageAssetCache";
import { videoSeekTargetSec, waitForVideoFrame } from "../../runtime/videoElementSync";
import { applyGrayscaleMaskToAlphaChannel } from "../../runtime/videoSplitAlpha";
import { packedVideoHeight, PACKED_ALPHA_GUTTER_PX } from "../../runtime/videoPackedAlpha";
import { encodeRgbaFramesToPackedVideo, type RgbaFrame } from "./encodeAlphaWebm";

/**
 * v1 の安全上限（§2.4）。超過時は変換を拒否する（ストリーミング encode への拡張は将来）。
 * 実測: Comp 32 相当の実データ（1080×1920・5秒・30fps）で推定 ≈2.3GB。これを弾かない値として
 * 4GB を既定にする（30秒級の 1080p フル尺のような大きなケースのみ拒否する安全マージン）。
 */
export const MAX_PACKED_CONVERT_BYTES = 4 * 1024 ** 3;

/**
 * ピーク時の実メモリ推定（2026-07-07 Opus 4.8 レビューで是正）。この関数が組み立てる
 * `frames`（content 解像度・1倍）と、`encodeRgbaFramesToPackedVideo` が内部で `.map()` により
 * 追加で確保する packed 解像度（content の約2倍高）のフレーム配列を**同時に**保持するため、
 * packed バッファ分だけでは過小評価になる（実測 packed 基準の推定値の約1.5倍が真のピーク）。
 */
export function estimatePackedConversionBytes(
  frameCount: number,
  width: number,
  contentHeight: number,
  gutterPx: number = PACKED_ALPHA_GUTTER_PX,
): number {
  const contentBytesPerFrame = width * contentHeight * 4;
  const packedBytesPerFrame = width * packedVideoHeight(contentHeight, gutterPx) * 4;
  return frameCount * (contentBytesPerFrame + packedBytesPerFrame);
}

/**
 * assetId を参照する video レイヤーを全 timeline comp から探し、host comp の fps を返す。
 * 参照レイヤーが1つも無い、または複数あって fps が食い違う場合は null（呼び出し側は
 * 30fps 等を当て推量せず、変換をスキップしてユーザーにその旨を示す）。
 */
export function resolveConversionFps(project: Project, assetId: string): number | null {
  let fps: number | null = null;
  for (const comp of project.compositions) {
    if (comp.kind !== "timeline") continue;
    const tl = comp as TimelineComposition;
    const referenced = tl.objects.some((o) =>
      o.components.some((c) => c.type === "video" && c.props["asset"] === assetId),
    );
    if (!referenced) continue;
    if (fps === null) fps = tl.fps;
    else if (fps !== tl.fps) return null;
  }
  return fps;
}

export interface ConvertSplitToPackedResult {
  asset: AssetEntry;
}

export interface ConvertSplitToPackedError {
  error: string;
}

export function isConvertError(
  v: ConvertSplitToPackedResult | ConvertSplitToPackedError,
): v is ConvertSplitToPackedError {
  return "error" in v;
}

function createHiddenVideo(src: string): HTMLVideoElement {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.body.appendChild(video);
  video.src = src;
  return video;
}

function waitVideoLoaded(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const onReady = () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onErr);
      resolve();
    };
    const onErr = () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onErr);
      reject(new Error("video load failed"));
    };
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("error", onErr);
    video.load();
  });
}

function teardownVideo(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute("src");
  video.load();
  video.remove();
}

/**
 * 既存 split alpha アセットを packed 化する。fps は呼び出し側で確定させて渡す
 * （Inspector＝レイヤー単位の起動なら host comp の fps、Project パネル＝アセット単位の
 * 起動なら `resolveConversionFps` の結果を使う。null の場合は呼び出し側で変換自体を
 * 提示しないこと）。
 */
export async function convertSplitAssetToPacked(
  project: Project,
  fs: FileSystem,
  assetId: string,
  fps: number,
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ConvertSplitToPackedResult | ConvertSplitToPackedError> {
  const asset = project.assets.find((a) => a.id === assetId);
  if (!asset || asset.kind !== "video" || !isSplitAlphaVideoMeta(asset.meta)) {
    return { error: "split alpha アセットではありません" };
  }
  const durationSec = typeof asset.meta?.duration === "number" ? asset.meta.duration : 0;
  const frameCount = Math.max(1, Math.round(durationSec * fps));
  // 表示サイズ（asset.meta.width/height）とエンコード実解像度は別物（Subject Extract の抽出時
  // ダウンサンプルにより実ファイルはより低解像度なことがある）。pack/encode は必ず実ファイルの
  // 実際のデコード解像度（colorVideo.videoWidth/videoHeight、下で判明）を使う。meta の表示サイズは
  // 変換後の asset にもそのまま引き継ぐ（見た目のレイアウトを変えないため）。
  const displayWidth = typeof asset.meta?.width === "number" ? asset.meta.width : 0;
  const displayHeight = typeof asset.meta?.height === "number" ? asset.meta.height : 0;

  const colorBuf = await fs.read(asset.path);
  const alphaPath = asset.meta!.alphaPath as string;
  const alphaBuf = await fs.read(alphaPath);
  const colorUrl = URL.createObjectURL(new Blob([colorBuf.buffer.slice(colorBuf.byteOffset, colorBuf.byteOffset + colorBuf.byteLength) as ArrayBuffer]));
  const alphaUrl = URL.createObjectURL(new Blob([alphaBuf.buffer.slice(alphaBuf.byteOffset, alphaBuf.byteOffset + alphaBuf.byteLength) as ArrayBuffer]));

  const colorVideo = createHiddenVideo(colorUrl);
  const alphaVideo = createHiddenVideo(alphaUrl);

  try {
    await Promise.all([waitVideoLoaded(colorVideo), waitVideoLoaded(alphaVideo)]);
    const width = colorVideo.videoWidth;
    const height = colorVideo.videoHeight;
    if (width <= 0 || height <= 0) return { error: "アセットの解像度が不明です" };

    const estimatedBytes = estimatePackedConversionBytes(frameCount, width, height);
    if (estimatedBytes > MAX_PACKED_CONVERT_BYTES) {
      const gb = (estimatedBytes / 1024 ** 3).toFixed(1);
      return { error: `変換に必要なメモリが大きすぎます（推定 ${gb}GB）。v1 では対応していません。` };
    }

    const colorCanvas = document.createElement("canvas");
    const maskCanvas = document.createElement("canvas");
    colorCanvas.width = width;
    colorCanvas.height = height;
    maskCanvas.width = width;
    maskCanvas.height = height;
    const colorCtx = colorCanvas.getContext("2d", { willReadFrequently: true });
    const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
    if (!colorCtx || !maskCtx) return { error: "canvas 2d context unavailable" };

    const frames: RgbaFrame[] = [];
    for (let i = 0; i < frameCount; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const sec = videoSeekTargetSec(i / fps, fps);
      colorVideo.pause();
      alphaVideo.pause();
      try {
        colorVideo.currentTime = sec;
        alphaVideo.currentTime = sec;
      } catch {
        /* best-effort */
      }
      await Promise.all([waitForVideoFrame(colorVideo, sec), waitForVideoFrame(alphaVideo, sec)]);

      colorCtx.clearRect(0, 0, width, height);
      colorCtx.drawImage(colorVideo, 0, 0, width, height);
      const colorData = colorCtx.getImageData(0, 0, width, height);

      maskCtx.clearRect(0, 0, width, height);
      maskCtx.drawImage(alphaVideo, 0, 0, width, height);
      const maskData = maskCtx.getImageData(0, 0, width, height);

      // 「分離前の1枚絵」を復元（色はそのまま・alpha だけ mask.R で上書き）。
      applyGrayscaleMaskToAlphaChannel(colorData, maskData);
      frames.push({ width, height, rgba: new Uint8ClampedArray(colorData.data) });
      onProgress?.(i + 1, frameCount);
    }

    const encoded = await encodeRgbaFramesToPackedVideo(frames, fps, null, undefined, signal);

    const newAssetId = newObjectId();
    const ext = encoded.container === "mp4" ? "mp4" : "webm";
    const assetPath = `${DIR_ASSETS}/${newAssetId}.${ext}`;
    await fs.write(assetPath, encoded.bytes);

    const newAsset: AssetEntry = {
      id: newAssetId,
      path: assetPath,
      kind: "video",
      binId: asset.binId,
      meta: {
        // 表示サイズは元 split アセットのものをそのまま引き継ぐ（レイアウトを変えない）。
        width: displayWidth > 0 ? displayWidth : width,
        height: displayHeight > 0 ? displayHeight : height,
        duration: durationSec,
        mime: encoded.container === "mp4" ? "video/mp4" : "video/webm",
        hasAlpha: true,
        alphaMode: "packed",
        packedLayout: "topBottom",
        contentHeight: encoded.layout.contentHeight,
        gutterPx: encoded.layout.gutterPx,
        extractedFrom: asset.meta?.extractedFrom,
        footageKind: asset.meta?.footageKind,
        // §2.4 — 追跡性・revert 導線（元 split アセットへの参照を残す）。
        convertedFrom: assetId,
      },
    };
    return { asset: newAsset };
  } finally {
    teardownVideo(colorVideo);
    teardownVideo(alphaVideo);
    URL.revokeObjectURL(colorUrl);
    URL.revokeObjectURL(alphaUrl);
  }
}
