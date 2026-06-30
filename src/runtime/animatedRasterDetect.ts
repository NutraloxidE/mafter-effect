// §11.4b — アニメーション WebP / GIF を「動画 footage（animated-raster）」として扱うための検出。
// 静止画 WebP/GIF は従来どおり image。複数フレームを持つものだけ video 化してプロキシ生成対象にする。
//
// ImageDecoder はブラウザ専用。純粋な判定（拡張子・閾値）のみ単体テスト対象。

/** 拡張子 / mime が WebP または GIF（アニメーション候補）か。 */
export function isAnimatedRasterCandidate(nameOrMime: string): boolean {
  const s = nameOrMime.toLowerCase();
  return s.endsWith(".webp") || s.endsWith(".gif") || s === "image/webp" || s === "image/gif";
}

/** フレーム数 / animated フラグから「動画化すべきか」を判定（純関数）。 */
export function shouldTreatAsAnimatedRaster(frameCount: number, animated: boolean): boolean {
  return animated && frameCount > 1;
}

export interface AnimatedRasterInfo {
  frameCount: number;
  /** ソース全体の尺（秒）。可変 delay は合算。 */
  durationSec: number;
  width: number;
  height: number;
  /** 各フレームの表示時間（秒）。ループ尺・等間隔リサンプルに使う。 */
  frameDurationsSec: number[];
}

/**
 * WebP/GIF をデコードしてアニメーション情報を返す。
 * 非アニメ（1 フレーム）・非対応・ImageDecoder 不在時は null（＝静止画として扱う）。
 */
export async function detectAnimatedRaster(file: File): Promise<AnimatedRasterInfo | null> {
  if (!isAnimatedRasterCandidate(file.name) && !isAnimatedRasterCandidate(file.type)) return null;
  const ImageDecoderCtor = (globalThis as { ImageDecoder?: typeof ImageDecoder }).ImageDecoder;
  if (typeof ImageDecoderCtor === "undefined") return null;

  const mime = file.type || (file.name.toLowerCase().endsWith(".gif") ? "image/gif" : "image/webp");
  let decoder: ImageDecoder | null = null;
  try {
    const buf = await file.arrayBuffer();
    decoder = new ImageDecoderCtor({ data: buf, type: mime });
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    const frameCount = track?.frameCount ?? 1;
    const animated = track?.animated ?? false;
    if (!shouldTreatAsAnimatedRaster(frameCount, animated)) return null;

    const frameDurationsSec: number[] = [];
    let width = 0;
    let height = 0;
    for (let i = 0; i < frameCount; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      if (i === 0) {
        width = image.displayWidth;
        height = image.displayHeight;
      }
      // duration は μs。未設定（null）の場合は 100ms 既定（GIF の慣例）。
      frameDurationsSec.push((image.duration ?? 100_000) / 1_000_000);
      image.close();
    }
    const durationSec = frameDurationsSec.reduce((a, b) => a + b, 0);
    return { frameCount, durationSec, width, height, frameDurationsSec };
  } catch {
    return null;
  } finally {
    try { decoder?.close(); } catch { /* ignore */ }
  }
}
