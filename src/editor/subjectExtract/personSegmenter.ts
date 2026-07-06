import {
  FilesetResolver,
  ImageSegmenter,
  type ImageSegmenterResult,
  type MPMask,
} from "@mediapipe/tasks-vision";
import {
  alphaMaskHasInk,
  applySubjectMask,
  categoryMaskToAlpha,
  confidenceFloatToAlpha,
  normalizeAlphaMaskForeground,
  scaleAlphaMaskNearest,
} from "./maskComposite";
import { publicAssetUrl } from "../../runtime/publicAssetUrl";

let segmenterPromise: Promise<ImageSegmenter> | null = null;

async function createSegmenter(delegate: "GPU" | "CPU"): Promise<ImageSegmenter> {
  const vision = await FilesetResolver.forVisionTasks(publicAssetUrl("subject-extract/mediapipe/wasm"));
  return ImageSegmenter.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: publicAssetUrl("subject-extract/mediapipe/models/selfie_segmenter.tflite"),
      delegate,
    },
    runningMode: "IMAGE",
    outputCategoryMask: true,
    outputConfidenceMasks: true,
  });
}

async function getPersonSegmenter(): Promise<ImageSegmenter> {
  if (!segmenterPromise) {
    // Subject Extract は mask readback 安定性のため CPU 優先。
    segmenterPromise = createSegmenter("CPU");
  }
  return segmenterPromise;
}

export async function disposePersonSegmenter(): Promise<void> {
  if (segmenterPromise) {
    const seg = await segmenterPromise.catch(() => null);
    seg?.close();
    segmenterPromise = null;
  }
}

function maskFromMpMask(
  maskObj: MPMask,
  targetW: number,
  targetH: number,
  mode: "category" | "confidence",
): Uint8ClampedArray {
  const mw = maskObj.width;
  const mh = maskObj.height;
  let alpha: Uint8ClampedArray;
  if (mode === "category") {
    alpha = categoryMaskToAlpha(maskObj.getAsUint8Array(), 1);
  } else {
    alpha = confidenceFloatToAlpha(maskObj.getAsFloat32Array());
  }
  return scaleAlphaMaskNearest(alpha, mw, mh, targetW, targetH);
}

function maskFromResult(result: ImageSegmenterResult, width: number, height: number): Uint8ClampedArray {
  const tryMask = (alpha: Uint8ClampedArray): Uint8ClampedArray | null => {
    const norm = normalizeAlphaMaskForeground(alpha);
    return alphaMaskHasInk(norm) ? norm : null;
  };

  // selfie_segmenter は confidence 単出力が主。category argmax はフォールバック。
  const conf = result.confidenceMasks?.[0];
  if (conf) {
    const alpha = maskFromMpMask(conf, width, height, "confidence");
    const ok = tryMask(alpha);
    if (ok) return ok;
  }

  const cat = result.categoryMask;
  if (cat) {
    const alpha = maskFromMpMask(cat, width, height, "category");
    const ok = tryMask(alpha);
    if (ok) return ok;
  }

  console.warn("[subjectExtract] segmentation returned empty mask; check MediaPipe model / input frame");
  return new Uint8ClampedArray(width * height);
}

function toImageData(rgba: Uint8ClampedArray, width: number, height: number): ImageData {
  const copy = new Uint8ClampedArray(rgba);
  return new ImageData(copy, width, height);
}

/** 1 フレーム RGBA に人物マスクを適用。 */
export async function segmentPersonFrame(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Uint8ClampedArray> {
  const segmenter = await getPersonSegmenter();
  const result = segmenter.segment(toImageData(rgba, width, height));
  const alphaMask = maskFromResult(result, width, height);
  result.close();
  return applySubjectMask(rgba, alphaMask, width, height);
}

/** ウォームアップ（初回 Extract 前）。 */
export async function initPersonSegmenter(): Promise<void> {
  await getPersonSegmenter();
}
