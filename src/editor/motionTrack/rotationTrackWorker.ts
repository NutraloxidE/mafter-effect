/// <reference lib="webworker" />

import {
  bearingFromPixel,
  estimateRotationFromPairs,
  type BearingPair,
} from "./rotationEstimator";
import type {
  RotationTrackWorkerRequest,
  RotationTrackWorkerResponse,
} from "./types";

interface CvMat {
  delete(): void;
  rows: number;
  cols: number;
  data: Uint8Array;
  data32F: Float32Array;
  data32S: Int32Array;
}

interface CvPoint2f {
  x: number;
  y: number;
}

interface OpenCvModule {
  Mat: new () => CvMat;
  matFromImageData: (img: ImageData) => CvMat;
  cvtColor: (src: CvMat, dst: CvMat, code: number) => void;
  goodFeaturesToTrack: (
    image: CvMat,
    corners: CvMat,
    maxCorners: number,
    qualityLevel: number,
    minDistance: number,
  ) => void;
  calcOpticalFlowPyrLK: (
    prevImg: CvMat,
    nextImg: CvMat,
    prevPts: CvMat,
    nextPts: CvMat,
    status: CvMat,
    err: CvMat,
  ) => void;
  COLOR_RGBA2GRAY: number;
  onRuntimeInitialized?: () => void;
}

declare const cv: OpenCvModule;

let cvReady: Promise<void> | null = null;
let prevGray: CvMat | null = null;
let prevPts: CvMat | null = null;

async function loadOpenCv(opencvUrl: string): Promise<void> {
  if (cvReady) return cvReady;
  cvReady = new Promise<void>((resolve, reject) => {
    fetch(opencvUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`opencv fetch failed: ${r.status}`);
        return r.text();
      })
      .then((src) => {
        const initCv = new Function(
          `${src}\nreturn typeof cv !== "undefined" ? cv : globalThis.cv;`,
        ) as () => OpenCvModule;
        const inst = initCv();
        Object.assign(globalThis as object, { cv: inst });
        if (inst.onRuntimeInitialized) {
          const prev = inst.onRuntimeInitialized;
          inst.onRuntimeInitialized = () => {
            prev();
            resolve();
          };
        } else {
          resolve();
        }
      })
      .catch(reject);
  });
  return cvReady;
}

function rgbaToGray(rgba: Uint8ClampedArray, w: number, h: number): CvMat {
  const copy = new Uint8ClampedArray(rgba);
  const imageData = new ImageData(copy, w, h);
  const rgbaMat = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  cv.cvtColor(rgbaMat, gray, cv.COLOR_RGBA2GRAY);
  rgbaMat.delete();
  return gray;
}

function detectFeatures(gray: CvMat): CvMat {
  const corners = new cv.Mat();
  cv.goodFeaturesToTrack(gray, corners, 300, 0.01, 8);
  return corners;
}

function trackFeatures(prev: CvMat, next: CvMat, pts: CvMat): { nextPts: CvMat; status: CvMat } {
  const nextPts = new cv.Mat();
  const status = new cv.Mat();
  const err = new cv.Mat();
  cv.calcOpticalFlowPyrLK(prev, next, pts, nextPts, status, err);
  err.delete();
  return { nextPts, status };
}

function readPoints(mat: CvMat): CvPoint2f[] {
  const pts: CvPoint2f[] = [];
  const data = mat.data32F;
  const n = mat.rows;
  for (let i = 0; i < n; i++) {
    pts.push({ x: data[i * 2]!, y: data[i * 2 + 1]! });
  }
  return pts;
}

function buildBearingPairs(
  prev: CvPoint2f[],
  cur: CvPoint2f[],
  status: CvMat,
  w: number,
  h: number,
  focalLength: number,
): BearingPair[] {
  const fx = focalLength;
  const fy = focalLength;
  const cx = w / 2;
  const cy = h / 2;
  const pairs: BearingPair[] = [];
  const st = status.data;
  const n = Math.min(prev.length, cur.length);
  for (let i = 0; i < n; i++) {
    if (!st[i]) continue;
    const p0 = prev[i]!;
    const p1 = cur[i]!;
    if (!Number.isFinite(p0.x) || !Number.isFinite(p0.y) || !Number.isFinite(p1.x) || !Number.isFinite(p1.y)) {
      continue;
    }
    if (p0.x < 2 || p0.y < 2 || p0.x > w - 2 || p0.y > h - 2) continue;
    if (p1.x < 2 || p1.y < 2 || p1.x > w - 2 || p1.y > h - 2) continue;
    pairs.push([
      bearingFromPixel(p0.x, p0.y, fx, fy, cx, cy),
      bearingFromPixel(p1.x, p1.y, fx, fy, cx, cy),
    ]);
  }
  return pairs;
}

function disposeTrackingState(): void {
  prevGray?.delete();
  prevPts?.delete();
  prevGray = null;
  prevPts = null;
}

self.onmessage = async (ev: MessageEvent<RotationTrackWorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === "init") {
      const t0 = performance.now();
      await loadOpenCv(msg.opencvUrl);
      const res: RotationTrackWorkerResponse = {
        type: "ready",
        initMs: performance.now() - t0,
      };
      self.postMessage(res);
      return;
    }

    if (msg.type === "dispose") {
      disposeTrackingState();
      return;
    }

    if (msg.type === "frame") {
      const t0 = performance.now();
      let rotation = null;
      let inlierRatio = 0;
      let residual = Infinity;
      let error: string | undefined;

      try {
        const rgba = new Uint8ClampedArray(msg.data);
        const gray = rgbaToGray(rgba, msg.w, msg.h);

        if (msg.reset || !prevGray || !prevPts) {
          disposeTrackingState();
          prevGray = gray;
          prevPts = detectFeatures(gray);
          const res: RotationTrackWorkerResponse = {
            type: "rotation",
            idx: msg.idx,
            rotation: null,
            inlierRatio: 0,
            residual: Infinity,
            processMs: performance.now() - t0,
          };
          self.postMessage(res);
          return;
        }

        const { nextPts, status } = trackFeatures(prevGray, gray, prevPts);
        const prevList = readPoints(prevPts);
        const curList = readPoints(nextPts);
        const pairs = buildBearingPairs(
          prevList,
          curList,
          status,
          msg.w,
          msg.h,
          msg.focalLength,
        );

        if (pairs.length >= 4) {
          const est = estimateRotationFromPairs(pairs);
          if (est) {
            rotation = est.quaternion;
            inlierRatio = est.inlierRatio;
            residual = est.residual;
          }
        }

        prevGray.delete();
        prevPts.delete();
        status.delete();
        prevGray = gray;
        prevPts = nextPts;
      } catch (ex) {
        error = ex instanceof Error ? ex.message : String(ex);
      }

      const res: RotationTrackWorkerResponse = {
        type: "rotation",
        idx: msg.idx,
        rotation,
        inlierRatio,
        residual,
        processMs: performance.now() - t0,
        error,
      };
      self.postMessage(res);
      return;
    }
  } catch (ex) {
    const res: RotationTrackWorkerResponse = {
      type: "error",
      message: ex instanceof Error ? ex.message : String(ex),
    };
    self.postMessage(res);
  }
};
