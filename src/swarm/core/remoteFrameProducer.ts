import JSZip from "jszip";
import type { Project, TimelineComposition } from "../../core/schema";
import { canvasSpread, compareFrames, looksEmptyAgainst, SwarmFrameMismatchError, SWARM_FRAME_TOLERANCE } from "./frameVerification";
import type { RenderProfile, SwarmRenderJob, SwarmRenderResult } from "./types";
import { SWARM_RUNTIME_VERSION } from "./types";

/**
 * Frames a worker renders per job. Setting up an export (fonts, images, expressions, footage
 * decode) costs far more than one frame, so a job covers the block the producer is about to be
 * asked for; requests beyond it simply miss the prefetch and start the next job.
 */
export const SWARM_EXPORT_BLOCK_FRAMES = 8;

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
  /** Unpacks a range job's zip into its frames, keyed by absolute frame index. */
  decodeZip: (bytesBase64: string, width: number, height: number) => Promise<Map<number, HTMLCanvasElement>>;
  /** Exclusive end of the export range, so a block never asks for frames outside it. */
  totalFrameEnd?: number;
  timeoutMs: number;
}

export function buildExportSwarmJob(
  options: Pick<RemoteFrameProducerOptions, "project" | "comp" | "renderRevision" | "profile">,
  frame: number,
  frameEnd = frame + 1,
): SwarmRenderJob {
  return {
    id: `export-${options.renderRevision}-${frame}-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
    kind: "preview-frame",
    renderRevision: options.renderRevision,
    compositionId: options.comp.id,
    frameStart: frame,
    frameEnd: Math.max(frame + 1, frameEnd),
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
  // Frames already fetched as part of a range job, waiting to be asked for.
  const prefetched = new Map<number, Promise<HTMLCanvasElement>>();

  return async (frame: number): Promise<HTMLCanvasElement> => {
    const ready = prefetched.get(frame);
    if (ready) {
      prefetched.delete(frame);
      return ready;
    }
    try {
      const startedAt = performance.now();
      const blockEnd = Math.min(options.totalFrameEnd ?? frame + SWARM_EXPORT_BLOCK_FRAMES, frame + SWARM_EXPORT_BLOCK_FRAMES);
      const result = await options.submit(buildExportSwarmJob(options, frame, blockEnd), options.timeoutMs);
      if (result && result.frameStart === frame && result.renderRevision === options.renderRevision) {
        const roundTripMs = performance.now() - startedAt;
        // Render vs transport: a worker that draws fast but delivers slowly needs a different fix
        // than one that is simply slow, and guessing between them has cost us a session already.
        console.info("[swarm] remote frame", frame, {
          roundTripMs: Math.round(roundTripMs),
          renderMs: Math.round(result.renderMs ?? -1),
          transportMs: Math.round(roundTripMs - (result.renderMs ?? 0)),
          bytes: result.byteLength,
        });
        if (result.format === "png-zip") {
          const frames = await options.decodeZip(result.bytesBase64, result.width, result.height);
          for (const [index, canvas] of frames) {
            if (index !== frame) prefetched.set(index, Promise.resolve(canvas));
          }
          const own = frames.get(frame);
          if (own) return own;
        } else {
          return await options.decodePng(result.bytesBase64, result.width, result.height);
        }
      }
    } catch {
      /* the local render below is the fallback for every swarm failure */
    }
    return options.renderLocally(frame);
  };
}

export interface RemoteProducerSetup {
  /** Absolute frames to re-render locally and compare before trusting remote pixels. */
  verifyFrames?: Set<number>;
  swarm?: { workerCount: number; submit: RemoteFrameProducerOptions["submit"]; timeoutMs?: number };
  project: Project;
  comp: TimelineComposition;
  renderRevision: string;
  profile: RenderProfile;
  renderLocally: (frame: number) => Promise<HTMLCanvasElement>;
  /** Exclusive end of the export range, so a prefetch block never runs past it. */
  totalFrameEnd?: number;
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

async function decodeZipToFrames(bytesBase64: string, width: number, height: number): Promise<Map<number, HTMLCanvasElement>> {
  const text = atob(bytesBase64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  const zip = await JSZip.loadAsync(bytes);
  const frames = new Map<number, HTMLCanvasElement>();
  await Promise.all(Object.values(zip.files).map(async (entry) => {
    const match = /frame_(\d+)\.png$/.exec(entry.name);
    if (!match || entry.dir) return;
    const blob = await entry.async("blob");
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    frames.set(Number(match[1]), canvas);
  }));
  return frames;
}

/** One producer per connected worker, or none at all when the swarm is not in play. */
export function buildRemoteFrameProducers(setup: RemoteProducerSetup): ((frame: number) => Promise<HTMLCanvasElement>)[] {
  const count = setup.swarm?.workerCount ?? 0;
  if (count <= 0 || !setup.swarm) return [];
  const verify = setup.verifyFrames;
  // Reference "how much is in a frame", learned from the frames we render here anyway.
  let referenceSpread = 0;
  const wrap = (produce: (frame: number) => Promise<HTMLCanvasElement>) =>
    async (frame: number): Promise<HTMLCanvasElement> => {
      const remote = await produce(frame);
      if (!verify?.has(frame)) {
        // Cheap guard on every remote frame: a worker that rendered before its footage decoded
        // returns a near-flat frame, and sampling alone would only catch it by luck.
        if (looksEmptyAgainst(remote, referenceSpread)) return setup.renderLocally(frame);
        return remote;
      }
      // Spot check: render it here too and keep the local frame, so a verified frame in the
      // output never depends on the worker's rasterizer.
      const local = await setup.renderLocally(frame);
      referenceSpread = Math.max(referenceSpread, canvasSpread(local));
      const difference = compareFrames(remote, local);
      if (difference > SWARM_FRAME_TOLERANCE) throw new SwarmFrameMismatchError(frame, difference);
      return local;
    };
  return Array.from({ length: count }, () => wrap(createRemoteFrameProducer({
    project: setup.project,
    comp: setup.comp,
    renderRevision: setup.renderRevision,
    profile: setup.profile,
    submit: setup.swarm!.submit,
    renderLocally: setup.renderLocally,
    decodePng: decodePngToCanvas,
    decodeZip: decodeZipToFrames,
    ...(setup.totalFrameEnd === undefined ? {} : { totalFrameEnd: setup.totalFrameEnd }),
    timeoutMs: setup.swarm!.timeoutMs ?? 60_000,
  })));
}

/**
 * Frames to re-render locally and compare, so a worker that produces subtly different pixels is
 * caught before its output reaches the file. Always includes the first frame: a mismatch there
 * usually means a missing font or asset, which affects every later frame too.
 */
export function spotCheckFrames(totalFrames: number, ratio = 0.05, minimum = 4): number[] {
  if (totalFrames <= 0) return [];
  // A ratio alone leaves a short export with a single checked frame, which is no coverage at all.
  const count = Math.min(totalFrames, Math.max(minimum, Math.round(totalFrames * ratio)));
  const stride = totalFrames / count;
  const frames = new Set<number>([0]);
  for (let i = 1; i < count; i += 1) frames.add(Math.min(totalFrames - 1, Math.round(i * stride)));
  return [...frames].sort((a, b) => a - b);
}
