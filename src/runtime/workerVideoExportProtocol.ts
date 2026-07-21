export type WorkerVideoFormat = "mp4" | "webm";

export interface WorkerVideoInit {
  type: "init";
  format: WorkerVideoFormat;
  width: number;
  height: number;
  fps: number;
  alpha: boolean;
  encoderConfig: VideoEncoderConfig;
}

export interface WorkerVideoFrame {
  type: "frame";
  id: number;
  frame: VideoFrame;
  keyFrame: boolean;
}

export type WorkerVideoRequest = WorkerVideoInit | WorkerVideoFrame | { type: "finish" } | { type: "abort" };

export type WorkerVideoResponse =
  | { type: "ready" }
  | { type: "frame-done"; id: number }
  | { type: "complete"; buffer: ArrayBuffer; mimeType: string }
  | { type: "error"; message: string };
