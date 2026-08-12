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

/**
 * How many of a worker's first frames are re-rendered here and compared before any of its output
 * is taken on trust. Enough to cover its first block, so a worker that is wrong about every frame
 * is caught on its first one rather than by whether the sample happened to land on it.
 */
export const SWARM_VERIFY_FIRST_REMOTE_FRAMES = 2;

/** Consecutive failed blocks after which a worker is left out of the rest of the export. */
export const SWARM_GIVE_UP_AFTER_FAILURES = 2;

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
  /** Unpacks a range job's zip into its frames, keyed by offset from the block's first frame. */
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
  // A worker that cannot deliver costs a full deadline per frame, and the frames it is asked for
  // are the ones the export is waiting on — an export sat at 149/150 paying 60s a frame for a
  // worker that had already failed twice. After that, stop asking and render here.
  let consecutiveFailures = 0;

  return async (frame: number): Promise<HTMLCanvasElement> => {
    const ready = prefetched.get(frame);
    if (ready) {
      prefetched.delete(frame);
      return ready;
    }
    if (consecutiveFailures >= SWARM_GIVE_UP_AFTER_FAILURES) return options.renderLocally(frame);
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
        consecutiveFailures = 0;
        if (result.format === "png-zip") {
          const frames = await options.decodeZip(result.bytesBase64, result.width, result.height);
          // A worker renders the block through `exportComposition`, which names frames from the
          // start of the range it was given, not by absolute frame. Reading those names as
          // absolute made every block miss both its own frame and the prefetch, so the host
          // silently re-rendered everything the worker produced.
          for (const [index, canvas] of frames) {
            if (index !== 0) prefetched.set(frame + index, Promise.resolve(canvas));
          }
          const own = frames.get(0);
          if (own) return own;
        } else {
          return await options.decodePng(result.bytesBase64, result.width, result.height);
        }
      }
    } catch {
      /* the local render below is the fallback for every swarm failure */
    }
    consecutiveFailures += 1;
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
  /** Overridable so verification can be exercised without a browser's image decoders. */
  decodePng?: RemoteFrameProducerOptions["decodePng"];
  decodeZip?: RemoteFrameProducerOptions["decodeZip"];
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
  const wrap = (produce: (frame: number) => Promise<HTMLCanvasElement>) => {
    // A spread-over-the-range sample can miss a worker whose every frame is wrong: an export
    // shipped 18 footage-less frames because the sampled ones all happened to be rendered here.
    // Checking the first frames a worker delivers catches a systematically broken one before its
    // output is trusted, and gives the flatness guard below a reference to work against.
    let unverifiedFromThisWorker = SWARM_VERIFY_FIRST_REMOTE_FRAMES;
    return async (frame: number): Promise<HTMLCanvasElement> => {
      const remote = await produce(frame);
      const mustVerify = verify?.has(frame) || unverifiedFromThisWorker > 0;
      if (unverifiedFromThisWorker > 0) unverifiedFromThisWorker -= 1;
      if (!mustVerify) {
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
  };
  return Array.from({ length: count }, () => wrap(createRemoteFrameProducer({
    project: setup.project,
    comp: setup.comp,
    renderRevision: setup.renderRevision,
    profile: setup.profile,
    submit: setup.swarm!.submit,
    renderLocally: setup.renderLocally,
    decodePng: setup.decodePng ?? decodePngToCanvas,
    decodeZip: setup.decodeZip ?? decodeZipToFrames,
    ...(setup.totalFrameEnd === undefined ? {} : { totalFrameEnd: setup.totalFrameEnd }),
    // Waiting is only free while the host still has frames of its own. Because remote producers
    // pull from the tail, the last block is the one nobody can finish without — so a long deadline
    // here buys nothing and stalls the end of every export.
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
