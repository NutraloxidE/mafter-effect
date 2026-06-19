import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from "webm-muxer";
import type { ExportConfig, Project, SceneObject, TimelineComposition } from "../core/schema";
import type { FileSystem } from "../fs/FileSystem";
import { captureCompFramePng, createCompFrameCaptureContext } from "./compFrameCapture";
import { componentNeedsBake } from "./bundleCollect";
import type { ProgressCallback } from "./exporter";

export interface BakeTarget {
  compId: string;
  objectId: string;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function evenDim(n: number): number {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v + 1;
}

/** bake 対象オブジェクトを列挙する。 */
export function findBakeTargets(project: Project, timelineCompIds: Set<string>): BakeTarget[] {
  const targets: BakeTarget[] = [];
  for (const compId of timelineCompIds) {
    const comp = project.compositions.find((c) => c.id === compId && c.kind === "timeline") as
      | TimelineComposition
      | undefined;
    if (!comp) continue;
    for (const obj of comp.objects) {
      if (!obj.enabled) continue;
      if (obj.components.some((c) => componentNeedsBake(c))) {
        targets.push({ compId, objectId: obj.id });
      }
    }
  }
  return targets;
}

function isolateObject(comp: TimelineComposition, objectId: string): TimelineComposition {
  return {
    ...comp,
    background: { r: 0, g: 0, b: 0, a: 0 },
    objects: comp.objects.map((o) => ({
      ...o,
      enabled: o.id === objectId && o.enabled,
    })),
  };
}

async function pngToCanvas(png: Uint8Array, w: number, h: number): Promise<HTMLCanvasElement> {
  const blob = new Blob([new Uint8Array(png)], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

async function encodePngSequenceToWebm(
  frames: Uint8Array[],
  w: number,
  h: number,
  fps: number,
): Promise<Uint8Array> {
  if (typeof VideoEncoder === "undefined") {
    throw new Error("WebCodecs unavailable for bake");
  }
  const target = new WebmTarget();
  const muxer = new WebmMuxer({
    target,
    video: { codec: "V_VP9", width: w, height: h, frameRate: fps, alpha: true },
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { throw e; },
  });

  await encoder.configure({
    codec: "vp09.00.10.08",
    width: w,
    height: h,
    bitrate: 8_000_000,
    framerate: fps,
    alpha: "keep",
  });

  const usDuration = Math.round(1_000_000 / fps);
  for (let fi = 0; fi < frames.length; fi++) {
    const canvas = await pngToCanvas(frames[fi]!, w, h);
    const bitmap = await createImageBitmap(canvas);
    const vf = new VideoFrame(bitmap, { timestamp: fi * usDuration, duration: usDuration });
    encoder.encode(vf, { keyFrame: fi === 0 || fi % 30 === 0 });
    vf.close();
    bitmap.close();
  }
  await encoder.flush();
  encoder.close();
  muxer.finalize();
  return new Uint8Array(target.buffer);
}

/** 1 レイヤを WebM に焼き、project コピーで video コンポーネントへ差し替える。 */
export async function bakeLayerToWebm(
  project: Project,
  target: BakeTarget,
  config: ExportConfig,
  fs: FileSystem,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<{ project: Project; bakedPath: string; assetId: string; webmBytes: Uint8Array }> {
  const comp = project.compositions.find(
    (c) => c.id === target.compId && c.kind === "timeline",
  ) as TimelineComposition | undefined;
  if (!comp) throw new Error("comp not found");

  const [startFrame, endFrame] = config.range;
  const totalFrames = Math.max(1, endFrame - startFrame);
  const w = evenDim(comp.width * config.scale);
  const h = evenDim(comp.height * config.scale);
  const isolated = isolateObject(comp, target.objectId);

  const ctx = await createCompFrameCaptureContext(project, target.compId, fs, {
    textQuality: config.textRenderMode ?? "precise",
    proxyScale: config.scale,
  });

  const frames: Uint8Array[] = [];
  try {
    for (let fi = 0; fi < totalFrames; fi++) {
      checkAbort(signal);
      const frame = startFrame + fi;
      const png = await captureCompFramePng(ctx, isolated, frame);
      frames.push(png);
      onProgress({
        phase: "bake",
        frame: fi,
        totalFrames,
        message: `Baking ${target.objectId} frame ${fi + 1}/${totalFrames}`,
      });
    }
  } finally {
    ctx.dispose();
  }

  const webm = await encodePngSequenceToWebm(frames, w, h, config.fps);
  const bakedPath = `assets/baked/${target.objectId}.webm`;
  const assetId = `baked_${target.objectId}`;

  const nextProject: Project = {
    ...project,
    assets: [
      ...project.assets,
      {
        id: assetId,
        path: bakedPath,
        kind: "video",
        meta: { width: w, height: h, mime: "video/webm" },
      },
    ],
    compositions: project.compositions.map((c) => {
      if (c.id !== target.compId || c.kind !== "timeline") return c;
      return {
        ...c,
        objects: c.objects.map((o) => replaceObjectWithVideo(o, target.objectId, assetId)),
      };
    }),
  };

  return { project: nextProject, bakedPath, assetId, webmBytes: webm };
}

function replaceObjectWithVideo(obj: SceneObject, objectId: string, assetId: string): SceneObject {
  if (obj.id !== objectId) return obj;
  return {
    ...obj,
    components: [{ type: "video", props: { asset: assetId, trimStart: 0 } }],
    effects: [],
  };
}

export async function applyBundleBake(
  project: Project,
  timelineCompIds: Set<string>,
  config: ExportConfig,
  fs: FileSystem,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<{ project: Project; binaryFiles: Map<string, Uint8Array> }> {
  const targets = findBakeTargets(project, timelineCompIds);
  let next = project;
  const binaryFiles = new Map<string, Uint8Array>();
  for (const target of targets) {
    const result = await bakeLayerToWebm(next, target, config, fs, onProgress, signal);
    next = result.project;
    binaryFiles.set(result.bakedPath, result.webmBytes);
  }
  return { project: next, binaryFiles };
}
