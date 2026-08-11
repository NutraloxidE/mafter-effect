import type { Project, TimelineComposition } from "../../core/schema";
import type { RenderProfile, SwarmRenderJob, SwarmRenderResult } from "./types";
import { SWARM_RUNTIME_VERSION } from "./types";

export interface RemoteFrameProducerOptions {
  project: Project;
  comp: TimelineComposition;
  /** Identifies the exact project state; a worker result for another revision is rejected. */
  renderRevision: string;
  profile: RenderProfile;
  /** Submits the job and resolves null when the swarm could not deliver the frame in time. */
  submit: (job: SwarmRenderJob, timeoutMs: number) => Promise<SwarmRenderResult | null>;
  /** Renders the frame on this device; used when the swarm declines or misses the deadline. */
  renderLocally: (frame: number) => Promise<HTMLCanvasElement>;
  decodePng: (bytesBase64: string, width: number, height: number) => Promise<HTMLCanvasElement>;
  timeoutMs: number;
}

export function buildExportSwarmJob(
  options: Pick<RemoteFrameProducerOptions, "project" | "comp" | "renderRevision" | "profile">,
  frame: number,
): SwarmRenderJob {
  return {
    id: `export-${options.renderRevision}-${frame}-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
    kind: "preview-frame",
    renderRevision: options.renderRevision,
    compositionId: options.comp.id,
    frameStart: frame,
    frameEnd: frame + 1,
    priority: "background",
    profile: options.profile,
    runtimeVersion: SWARM_RUNTIME_VERSION,
    project: options.project,
    createdAt: Date.now(),
  };
}

/**
 * A frame producer backed by the swarm, shaped like the local producers `runOrderedMultiContext`
 * already drives. Ordering, muxing and alpha stay with the caller; this only supplies pixels, and
 * falls back to local rendering whenever the swarm cannot, so an export never loses a frame.
 */
export function createRemoteFrameProducer(
  options: RemoteFrameProducerOptions,
): (frame: number) => Promise<HTMLCanvasElement> {
  return async (frame: number): Promise<HTMLCanvasElement> => {
    try {
      const result = await options.submit(buildExportSwarmJob(options, frame), options.timeoutMs);
      if (result && result.frameStart === frame && result.renderRevision === options.renderRevision) {
        return await options.decodePng(result.bytesBase64, result.width, result.height);
      }
    } catch {
      /* the local render below is the fallback for every swarm failure */
    }
    return options.renderLocally(frame);
  };
}

export interface RemoteProducerSetup {
  swarm?: { workerCount: number; submit: RemoteFrameProducerOptions["submit"]; timeoutMs?: number };
  project: Project;
  comp: TimelineComposition;
  renderRevision: string;
  profile: RenderProfile;
  renderLocally: (frame: number) => Promise<HTMLCanvasElement>;
}

async function decodePngToCanvas(bytesBase64: string, width: number, height: number): Promise<HTMLCanvasElement> {
  const text = atob(bytesBase64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable for a remote frame");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return canvas;
}

/** One producer per connected worker, or none at all when the swarm is not in play. */
export function buildRemoteFrameProducers(setup: RemoteProducerSetup): ((frame: number) => Promise<HTMLCanvasElement>)[] {
  const count = setup.swarm?.workerCount ?? 0;
  if (count <= 0 || !setup.swarm) return [];
  return Array.from({ length: count }, () => createRemoteFrameProducer({
    project: setup.project,
    comp: setup.comp,
    renderRevision: setup.renderRevision,
    profile: setup.profile,
    submit: setup.swarm!.submit,
    renderLocally: setup.renderLocally,
    decodePng: decodePngToCanvas,
    timeoutMs: setup.swarm!.timeoutMs ?? 60_000,
  }));
}

/**
 * Frames to re-render locally and compare, so a worker that produces subtly different pixels is
 * caught before its output reaches the file. Always includes the first frame: a mismatch there
 * usually means a missing font or asset, which affects every later frame too.
 */
export function spotCheckFrames(totalFrames: number, ratio = 0.05): number[] {
  if (totalFrames <= 0) return [];
  const count = Math.min(totalFrames, Math.max(1, Math.round(totalFrames * ratio)));
  const stride = totalFrames / count;
  const frames = new Set<number>([0]);
  for (let i = 1; i < count; i += 1) frames.add(Math.min(totalFrames - 1, Math.round(i * stride)));
  return [...frames].sort((a, b) => a - b);
}
