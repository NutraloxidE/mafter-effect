// §11.2 GIF export — post-process the canonical PNG-sequence export.
// Deliberately does not introduce a second render path: INV-2 stays owned by exporter.ts.

import JSZip from "jszip";
import type { ExportConfig, Project } from "../core/schema";
import type { FileSystem } from "../fs/FileSystem";
import {
  exportComposition,
  type ExportSwarmHooks,
  type ProgressCallback,
} from "./exporter";
import { GifEncoder, gifFrameDelayCs, quantizeRgbaToGif } from "./gifEncoder";

export async function exportGif(
  project: Project,
  compId: string,
  fs: FileSystem,
  config: ExportConfig,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
  swarm?: ExportSwarmHooks,
): Promise<Blob> {
  checkAbort(signal);

  // Reuse the canonical deterministic raster path instead of duplicating renderer/export logic.
  // Suppress only its final "Done" event because GIF encoding still has work to do afterwards.
  const pngResult = await exportComposition(
    project,
    compId,
    fs,
    { ...config, format: "png-seq" },
    (progress) => {
      if (progress.phase !== "done") onProgress(progress);
    },
    signal,
    swarm,
  );
  if (pngResult.format !== "png-seq") {
    throw new Error(`GIF frame export returned unexpected format: ${pngResult.format}`);
  }

  checkAbort(signal);
  onProgress({
    phase: "encode",
    frame: 0,
    totalFrames: Math.max(1, config.range[1] - config.range[0]),
    message: "Opening rendered frames…",
  });

  const zip = await JSZip.loadAsync(pngResult.blob);
  const frameNames = Object.keys(zip.files)
    .filter((name) => /^frame_\d+\.png$/i.test(name) && !zip.files[name].dir)
    .sort();
  if (frameNames.length === 0) throw new Error("GIF export received no PNG frames");

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas2D unavailable while encoding GIF");

  let encoder: GifEncoder | null = null;
  let width = 0;
  let height = 0;

  for (let i = 0; i < frameNames.length; i++) {
    checkAbort(signal);
    const entry = zip.file(frameNames[i]);
    if (!entry) throw new Error(`GIF frame missing from ZIP: ${frameNames[i]}`);
    const pngBlob = await entry.async("blob");
    checkAbort(signal);

    const bitmap = await createImageBitmap(pngBlob);
    try {
      if (!encoder) {
        width = bitmap.width;
        height = bitmap.height;
        canvas.width = width;
        canvas.height = height;
        encoder = new GifEncoder(width, height, 0);
      } else if (bitmap.width !== width || bitmap.height !== height) {
        throw new Error(
          `GIF frame size changed from ${width}x${height} to ${bitmap.width}x${bitmap.height}`,
        );
      }

      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0);
      const rgba = ctx.getImageData(0, 0, width, height).data;
      const indexed = quantizeRgbaToGif(rgba, config.alpha);
      encoder.addFrame(indexed, gifFrameDelayCs(i, config.fps), config.alpha);
    } finally {
      bitmap.close();
    }

    onProgress({
      phase: "encode",
      frame: i + 1,
      totalFrames: frameNames.length,
      message: `GIF frame ${i + 1}/${frameNames.length}`,
    });
  }

  checkAbort(signal);
  if (!encoder) throw new Error("GIF encoder was not initialized");
  onProgress({
    phase: "pack",
    frame: frameNames.length,
    totalFrames: frameNames.length,
    message: "Packaging GIF…",
  });
  const bytes = encoder.finish();
  const blob = new Blob([bytes], { type: "image/gif" });
  onProgress({
    phase: "done",
    frame: frameNames.length,
    totalFrames: frameNames.length,
    message: "Done",
  });
  return blob;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
