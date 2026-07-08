// §16.2b 追加 — packed alpha（color+mask 1本パック）専用の preview proxy 生成。
// 原本 packed 動画（H.264 非対応環境で webm=VP9 ソフトウェアデコードに落ちたもの等）が
// 実時間デコードに追いつかず holdTimeline が慢性的に発火する decode-bound 対策（§16.2b 参照）。
// レイアウト（color/gutter/mask の上下パック構造）を保持したまま縮小し、preview 専用の
// 軽量 packed 動画を作る。決定論 export（mp4/webm/PNG）はこの proxy を使わず常に原本（INV-2）。
//
// <video> / canvas / WebCodecs はブラウザ専用。寸法計算のみ単体テスト対象。

import type { PackedAlphaLayout } from "./videoAlphaGl";
import { computePackedAlphaRects, packedVideoHeight } from "./videoPackedAlpha";
import { PROXY_TIER_PARAMS, type ProxyTier } from "./footageQuality";
import { waitForVideoFrame } from "./videoElementSync";
import { encodeFramesToWebm } from "./webcodecsVideoEncode";

/** gutter 縮小時もクロマにじみを避けるための下限（§16.2b 原本 gutterPx=8 の 1/2 相当）。 */
const MIN_PROXY_GUTTER_PX = 4;

export interface PackedProxyLayout {
  /** 原本 → proxy の縮小率（長辺基準）。 */
  scale: number;
  contentWidth: number;
  contentHeight: number;
  gutterPx: number;
}

/**
 * packed content（color/mask 各段）の長辺を maxDim に収める縮小レイアウトを計算する純関数。
 * 通常 video proxy の `fitProxyDimensions`（footageVideoProxy.ts）と異なり、color/mask 2段の
 * レイアウト構造（contentHeight/gutterPx）を保ったまま縮小する。
 */
export function fitPackedProxyDimensions(
  srcContentWidth: number,
  srcLayout: PackedAlphaLayout,
  maxDim: number,
): PackedProxyLayout {
  const longest = Math.max(srcContentWidth, srcLayout.contentHeight);
  const scale = longest > maxDim ? maxDim / longest : 1;
  const even = (n: number) => Math.max(2, Math.round(n)) & ~1;
  return {
    scale,
    contentWidth: even(srcContentWidth * scale),
    contentHeight: even(srcLayout.contentHeight * scale),
    gutterPx: Math.max(MIN_PROXY_GUTTER_PX, Math.round(srcLayout.gutterPx * scale)),
  };
}

export interface PackedVideoProxyResult {
  bytes: Uint8Array;
  mime: "video/webm";
  /** packed 動画全体の幅（= contentWidth）。 */
  width: number;
  /** packed 動画全体の高さ（= 2*contentHeight + gutterPx）。 */
  height: number;
  contentHeight: number;
  gutterPx: number;
  fps: number;
  frameCount: number;
  durationSec: number;
}

/** プロキシの出力 fps（原本 fps 不明なため固定 24 を上限にクランプ。footageVideoProxy と同方針）。 */
function chooseProxyFps(durationSec: number): number {
  return durationSec > 0 ? 24 : 12;
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.style.cssText = "position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
  document.body.appendChild(video);
  video.src = url;
  return new Promise<void>((resolve, reject) => {
    const onMeta = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error("packed proxy: video load failed")); };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onErr);
    };
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("error", onErr);
  }).then(() => video);
}

/**
 * 原本 packed 動画（1本・color+mask 上下パック）を、レイアウトを保ったまま縮小した
 * preview 専用 packed proxy（webm）にエンコードする。失敗時は例外（呼び出し側で原本フォールバック）。
 */
export async function buildPackedVideoProxy(
  file: File,
  tier: ProxyTier,
  srcLayout: PackedAlphaLayout,
): Promise<PackedVideoProxyResult> {
  const params = PROXY_TIER_PARAMS[tier];
  const url = URL.createObjectURL(file);
  let video: HTMLVideoElement | null = null;
  try {
    video = await loadVideo(url);
    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    if (srcW <= 0 || srcH <= 0) throw new Error("packed proxy: source video has no dimensions");
    if (!Number.isFinite(srcLayout.contentHeight) || srcLayout.contentHeight <= 0) {
      throw new Error("packed proxy: invalid source contentHeight");
    }
    // meta 由来の layout と実デコード高さの整合を確認する（表示サイズ meta と実ファイル解像度が
    // 食い違うと computePackedAlphaRects の source rect が videoHeight を超え drawImage が失敗する）。
    const expectedH = packedVideoHeight(srcLayout.contentHeight, srcLayout.gutterPx);
    if (Math.abs(expectedH - srcH) > 2) {
      throw new Error(
        `packed proxy: source layout mismatch (meta expects height ${expectedH}, decoded video is ${srcH})`,
      );
    }

    const durationSec = Number.isFinite(video.duration) ? video.duration : 0;
    const fps = chooseProxyFps(durationSec);
    const frameCount = Math.max(1, Math.round(durationSec * fps));

    const proxyLayout = fitPackedProxyDimensions(srcW, srcLayout, params.maxDim);
    const proxyWidth = proxyLayout.contentWidth;
    const proxyContentHeight = proxyLayout.contentHeight;
    const proxyGutter = proxyLayout.gutterPx;
    const proxyTotalHeight = packedVideoHeight(proxyContentHeight, proxyGutter);

    // 原本 packed 内の color/mask source rect（drawImage の sx/sy/sw/sh）。
    const rects = computePackedAlphaRects(srcW, srcLayout);

    const canvas = document.createElement("canvas");
    canvas.width = proxyWidth;
    canvas.height = proxyTotalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("packed proxy: 2d context unavailable");

    const v = video;
    const bytes = await encodeFramesToWebm({
      width: proxyWidth,
      height: proxyTotalHeight,
      fps,
      frameCount,
      bitrate: Math.round(proxyWidth * proxyTotalHeight * fps * params.quality * 0.12),
      drawFrame: async (fi) => {
        const t = Math.min(durationSec > 0 ? durationSec - 1e-3 : 0, fi / fps);
        if (Math.abs(v.currentTime - t) > 0.5 / fps) {
          v.currentTime = t;
        }
        await waitForVideoFrame(v, t);

        // gutter は原本と同じく不透明黒で埋める（drawPackedAlphaComposite の source rect が
        // gutter 分を除外して sample するため、値自体は合成結果に影響しないが、原本の
        // 「ゼロ初期化＝黒」という前提を壊さないよう明示的に塗る）。
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, proxyWidth, proxyTotalHeight);
        ctx.drawImage(
          v,
          rects.color.sx, rects.color.sy, rects.color.sw, rects.color.sh,
          0, 0, proxyWidth, proxyContentHeight,
        );
        ctx.drawImage(
          v,
          rects.mask.sx, rects.mask.sy, rects.mask.sw, rects.mask.sh,
          0, proxyContentHeight + proxyGutter, proxyWidth, proxyContentHeight,
        );
        return canvas;
      },
    });

    return {
      bytes,
      mime: "video/webm",
      width: proxyWidth,
      height: proxyTotalHeight,
      contentHeight: proxyContentHeight,
      gutterPx: proxyGutter,
      fps,
      frameCount,
      durationSec,
    };
  } finally {
    if (video) {
      video.src = "";
      video.remove();
    }
    URL.revokeObjectURL(url);
  }
}
