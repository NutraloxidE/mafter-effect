// §11.4b — 実写 MP4 等（native）→ 縮小 webm プロキシ生成。
// 原本を <video> に読み込み決定論 seek で 1/fps 刻みにフレームを取り出し、縮小して webm 再エンコード。
// 内蔵音声は捨てる（音声は常に原本から別経路で再生／mux する＝resolveFootageAudioPath）。
//
// <video> / canvas / WebCodecs はブラウザ専用。寸法計算のみ webcodecsVideoEncode 側で単体テスト。

import { PROXY_TIER_PARAMS, type ProxyTier } from "./footageQuality";
import { waitForVideoFrame } from "./videoElementSync";
import { encodeFramesToWebm, fitProxyDimensions } from "./webcodecsVideoEncode";

export interface NativeProxyResult {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  durationSec: number;
}

/** プロキシの出力 fps（原本 fps 不明なため固定 24 を上限にクランプ）。 */
function chooseNativeProxyFps(durationSec: number): number {
  return durationSec > 0 ? 24 : 12;
}

async function loadVideo(url: string): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  // 画面外に実 mount する。detached な <video> は requestVideoFrameCallback の present が
  // 発火しない環境（headless 等）があり、seek→drawImage が止まるため。
  video.style.cssText = "position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
  document.body.appendChild(video);
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    const onMeta = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error("video load failed")); };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onErr);
    };
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("error", onErr);
  });
  return video;
}

/**
 * native video File を指定 tier の webm プロキシにエンコードする。
 * 失敗時は例外（呼び出し側で原本フォールバック）。
 */
export async function buildNativeVideoProxy(
  file: File,
  tier: ProxyTier,
): Promise<NativeProxyResult> {
  const params = PROXY_TIER_PARAMS[tier];
  const url = URL.createObjectURL(file);
  let video: HTMLVideoElement | null = null;
  try {
    video = await loadVideo(url);
    const srcW = video.videoWidth || 1280;
    const srcH = video.videoHeight || 720;
    const durationSec = Number.isFinite(video.duration) ? video.duration : 0;
    const { width, height } = fitProxyDimensions(srcW, srcH, params.maxDim);
    const fps = chooseNativeProxyFps(durationSec);
    const frameCount = Math.max(1, Math.round(durationSec * fps));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");

    const v = video;
    const bytes = await encodeFramesToWebm({
      width,
      height,
      fps,
      frameCount,
      bitrate: Math.round(width * height * fps * params.quality * 0.12),
      drawFrame: async (fi) => {
        const t = Math.min(durationSec > 0 ? durationSec - 1e-3 : 0, fi / fps);
        if (Math.abs(v.currentTime - t) > 0.5 / fps) {
          v.currentTime = t;
        }
        await waitForVideoFrame(v, t);
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(v, 0, 0, width, height);
        return canvas;
      },
    });
    return { bytes, mime: "video/webm", width, height, fps, frameCount, durationSec };
  } finally {
    if (video) {
      video.src = "";
      video.remove();
    }
    URL.revokeObjectURL(url);
  }
}
