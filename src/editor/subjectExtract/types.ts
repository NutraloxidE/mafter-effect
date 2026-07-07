export type SubjectExtractTarget = "person";

export interface SubjectExtractProgress {
  phase: "loading" | "extracting" | "segmenting" | "encoding" | "applying";
  current: number;
  total: number;
}

export interface SubjectExtractFrame {
  compFrame: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export interface SubjectExtractOptions {
  target: SubjectExtractTarget;
  sampleInterval: number;
  targetWidth?: number;
}

export interface SubjectExtractResult {
  mode: "unified" | "split" | "packed";
  /** unified/split(color) は webm、packed は container に応じた mp4/webm バイト列。 */
  webmBytes: Uint8Array;
  /** split モード時のマスク WebM（グレースケール）。 */
  alphaWebmBytes?: Uint8Array;
  /** packed モード時のコンテナ種別（H.264/mp4 優先、非対応環境は VP9/webm）。 */
  packedContainer?: "mp4" | "webm";
  /** packed モード時のレイアウト（§2.2 asset.meta に転記する）。 */
  packedLayout?: { contentHeight: number; gutterPx: number };
  width: number;
  height: number;
  durationSec: number;
  frameCount: number;
  fps: number;
}
