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
