/// <reference lib="webworker" />

import type {
  MotionTrackWorkerRequest,
  MotionTrackWorkerResponse,
  RawTranslation,
} from "./types";

interface QuarModule {
  default: (input?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module) => Promise<unknown>;
  TrackerHandle: new () => QuarTracker;
  version?: () => string;
}

interface QuarTracker {
  process_frame(rgba: Uint8Array, width: number, height: number): { translation?: number[] };
  confidence_level(): number;
  free(): void;
}

let quarMod: QuarModule | null = null;
let tracker: QuarTracker | null = null;

function parseTranslation(pose: { translation?: number[] } | null | undefined): RawTranslation | null {
  const t = pose?.translation;
  if (!t || t.length < 3) return null;
  return [t[0]!, t[1]!, t[2]!];
}

self.onmessage = async (ev: MessageEvent<MotionTrackWorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === "init") {
      const t0 = performance.now();
      quarMod = (await import(/* @vite-ignore */ msg.wasmUrl)) as QuarModule;
      await quarMod.default();
      tracker = new quarMod.TrackerHandle();
      const res: MotionTrackWorkerResponse = {
        type: "ready",
        version: quarMod.version?.(),
        initMs: performance.now() - t0,
      };
      self.postMessage(res);
      return;
    }

    if (msg.type === "dispose") {
      tracker?.free();
      tracker = null;
      quarMod = null;
      return;
    }

    if (msg.type === "frame") {
      if (!tracker) throw new Error("tracker not initialized");
      const rgba = new Uint8ClampedArray(msg.data);
      const t0 = performance.now();
      let translation: RawTranslation | null = null;
      let confidence = -1;
      let error: string | undefined;
      try {
        const pose = tracker.process_frame(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), msg.w, msg.h);
        translation = parseTranslation(pose);
        confidence = tracker.confidence_level();
      } catch (ex) {
        error = ex instanceof Error ? ex.message : String(ex);
      }
      const res: MotionTrackWorkerResponse = {
        type: "pose",
        idx: msg.idx,
        translation,
        confidence,
        processMs: performance.now() - t0,
        error,
      };
      self.postMessage(res);
      return;
    }
  } catch (ex) {
    const res: MotionTrackWorkerResponse = {
      type: "error",
      message: ex instanceof Error ? ex.message : String(ex),
    };
    self.postMessage(res);
  }
};
