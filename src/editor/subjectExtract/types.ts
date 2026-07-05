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
  mode: "unified" | "split";
  webmBytes: Uint8Array;
  /** split モード時のマスク WebM（グレースケール）。 */
  alphaWebmBytes?: Uint8Array;
  width: number;
  height: number;
  durationSec: number;
  frameCount: number;
  fps: number;
}
