/// <reference lib="webworker" />

import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from "mp4-muxer";
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from "webm-muxer";
import { waitForEncoderQueueAtMost } from "../encoderBackpressure";
import { configureVideoEncoder } from "../videoEncoderSupport";
import type { WorkerVideoRequest, WorkerVideoResponse } from "../workerVideoExportProtocol";

interface VideoMuxer {
  addVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void;
  finalize(): void;
}

let encoder: VideoEncoder | null = null;
let muxer: VideoMuxer | null = null;
let target: Mp4Target | WebmTarget | null = null;
let mimeType = "";
let aborted = false;
let chain = Promise.resolve();
const queuedFrames = new Set<VideoFrame>();

function post(message: WorkerVideoResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

function closeResources(): void {
  for (const frame of queuedFrames) frame.close();
  queuedFrames.clear();
  try { if (encoder?.state !== "closed") encoder?.close(); } catch { /* ignore */ }
  encoder = null;
}

function fail(error: unknown): void {
  post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  closeResources();
}

self.onmessage = (event: MessageEvent<WorkerVideoRequest>) => {
  const message = event.data;
  if (message.type === "abort") {
    aborted = true;
    closeResources();
    return;
  }
  chain = chain.then(async () => {
    if (aborted) return;
    if (message.type === "init") {
      if (message.format === "mp4") {
        const mp4Target = new Mp4Target();
        target = mp4Target;
        muxer = new Mp4Muxer({
          target: mp4Target,
          video: { codec: "avc", width: message.width, height: message.height, frameRate: message.fps },
          fastStart: "in-memory",
          firstTimestampBehavior: "offset",
        });
        mimeType = "video/mp4";
      } else {
        const webmTarget = new WebmTarget();
        target = webmTarget;
        muxer = new WebmMuxer({
          target: webmTarget,
          video: { codec: "V_VP9", width: message.width, height: message.height, frameRate: message.fps, alpha: message.alpha },
        });
        mimeType = "video/webm";
      }
      encoder = new VideoEncoder({
        output: (chunk, meta) => muxer?.addVideoChunk(chunk, meta ?? undefined),
        error: fail,
      });
      await configureVideoEncoder(encoder, message.encoderConfig);
      post({ type: "ready" });
    } else if (message.type === "frame") {
      if (!encoder || encoder.state === "closed") throw new Error("Video encoder is unavailable");
      queuedFrames.add(message.frame);
      try {
        encoder.encode(message.frame, { keyFrame: message.keyFrame });
      } finally {
        queuedFrames.delete(message.frame);
        message.frame.close();
      }
      await waitForEncoderQueueAtMost(encoder, 6);
      post({ type: "frame-done", id: message.id });
    } else if (message.type === "finish") {
      if (!encoder || !muxer || !target) throw new Error("Video export worker was not initialized");
      await encoder.flush();
      muxer.finalize();
      const buffer = target.buffer;
      post({ type: "complete", buffer, mimeType }, [buffer]);
      closeResources();
    }
  }).catch(fail);
};
