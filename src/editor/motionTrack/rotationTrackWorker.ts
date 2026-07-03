/// <reference lib="webworker" />

import {
  bearingFromPixel,
  estimateRotationFromPairs,
  type BearingPair,
} from "./rotationEstimator";
import { MultiFrameVoState } from "./multiFrameVo";
import {
  filterPointsInRoiInterior,
  filterTrackedPoints,
  selectGridDispersedPoints,
  shouldRediscover,
  type Point2,
} from "./featureQuality";
import type {
  RotationTrackWorkerRequest,
  RotationTrackWorkerResponse,
  TrackMaskSpec,
} from "./types";
import { isFullMask, resolveTrackMask } from "./trackRoi";

interface CvMat {
  delete(): void;
  rows: number;
  cols: number;
  data: Uint8Array;
  data32F: Float32Array;
  data32S: Int32Array;
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
let prevPtsList: Point2[] = [];
let prevTrackIds: number[] = [];
let framesSinceReset = 0;
let mfVo = new MultiFrameVoState();

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

function detectFeaturesRaw(gray: CvMat): Point2[] {
  const corners = new cv.Mat();
  cv.goodFeaturesToTrack(gray, corners, 400, 0.01, 8);
  const pts = readPoints(corners);
  corners.delete();
  return pts;
}

function pointsToMat(pts: Point2[]): CvMat {
  const flat: number[] = [];
  for (const p of pts) {
    flat.push(p.x, p.y);
  }
  const cvAny = cv as OpenCvModule & {
    matFromArray: (rows: number, cols: number, type: number, array: number[]) => CvMat;
    CV_32FC2: number;
  };
  const type = typeof cvAny.CV_32FC2 === "number" ? cvAny.CV_32FC2 : 13;
  return cvAny.matFromArray(pts.length, 1, type, flat);
}

function readPoints(mat: CvMat): Point2[] {
  const pts: Point2[] = [];
  const data = mat.data32F;
  const n = mat.rows;
  for (let i = 0; i < n; i++) {
    pts.push({ x: data[i * 2]!, y: data[i * 2 + 1]! });
  }
  return pts;
}

function trackForwardBackward(
  prev: CvMat,
  next: CvMat,
  pts: Point2[],
): { keptPrev: Point2[]; keptCur: Point2[] } {
  if (pts.length === 0) return { keptPrev: [], keptCur: [] };
  const prevMat = pointsToMat(pts);
  const nextPts = new cv.Mat();
  const status = new cv.Mat();
  const err = new cv.Mat();
  cv.calcOpticalFlowPyrLK(prev, next, prevMat, nextPts, status, err);

  const backPts = new cv.Mat();
  const statusBack = new cv.Mat();
  const errBack = new cv.Mat();
  cv.calcOpticalFlowPyrLK(next, prev, nextPts, backPts, statusBack, errBack);

  const forward = readPoints(nextPts);
  const backward = readPoints(backPts);
  const errArr =
    err.data32F && err.data32F.length > 0
      ? err.data32F
      : new Float32Array(pts.length);
  const result = filterTrackedPoints(
    pts,
    forward,
    backward,
    status.data,
    statusBack.data,
    errArr,
  );

  prevMat.delete();
  nextPts.delete();
  status.delete();
  err.delete();
  backPts.delete();
  statusBack.delete();
  errBack.delete();
  return result;
}

function buildBearingPairs(
  prev: Point2[],
  cur: Point2[],
  w: number,
  h: number,
  focalLength: number,
  mask: TrackMaskSpec,
): BearingPair[] {
  const fx = focalLength;
  const fy = focalLength;
  const cx = w / 2;
  const cy = h / 2;
  const pairs: BearingPair[] = [];
  const n = Math.min(prev.length, cur.length);
  for (let i = 0; i < n; i++) {
    const p0 = prev[i]!;
    const p1 = cur[i]!;
    if (!filterPointsInRoiInterior([p0], w, h, mask).length) continue;
    if (!filterPointsInRoiInterior([p1], w, h, mask).length) continue;
    pairs.push([
      bearingFromPixel(p0.x, p0.y, fx, fy, cx, cy),
      bearingFromPixel(p1.x, p1.y, fx, fy, cx, cy),
    ]);
  }
  return pairs;
}

function seedFeatures(gray: CvMat, w: number, h: number, mask: TrackMaskSpec): Point2[] {
  const raw = detectFeaturesRaw(gray);
  const interior = filterPointsInRoiInterior(raw, w, h, mask);
  return selectGridDispersedPoints(interior, [], w, h);
}

function mergeRediscovered(
  gray: CvMat,
  existing: Point2[],
  w: number,
  h: number,
  mask: TrackMaskSpec,
): Point2[] {
  const raw = detectFeaturesRaw(gray);
  const interior = filterPointsInRoiInterior(raw, w, h, mask);
  const added = selectGridDispersedPoints(interior, existing, w, h);
  return [...existing, ...added];
}

function disposeTrackingState(): void {
  prevGray?.delete();
  prevGray = null;
  prevPtsList = [];
  prevTrackIds = [];
  framesSinceReset = 0;
  mfVo = new MultiFrameVoState();
}

function trackWithIds(
  prev: CvMat,
  next: CvMat,
  pts: Point2[],
  ids: number[],
): {
  pairs: Array<{ id: number; x0: number; y0: number; x1: number; y1: number }>;
  keptIds: number[];
  keptCur: Point2[];
} {
  const { keptPrev, keptCur } = trackForwardBackward(prev, next, pts);
  const pairs: Array<{ id: number; x0: number; y0: number; x1: number; y1: number }> = [];
  const keptIds: number[] = [];
  const used = new Set<number>();
  for (let i = 0; i < keptPrev.length; i++) {
    const p0 = keptPrev[i]!;
    const p1 = keptCur[i]!;
    let bestJ = -1;
    let bestD = 1e9;
    for (let j = 0; j < pts.length; j++) {
      if (used.has(j)) continue;
      const d = Math.hypot(pts[j]!.x - p0.x, pts[j]!.y - p0.y);
      if (d < bestD) {
        bestD = d;
        bestJ = j;
      }
    }
    if (bestJ < 0 || bestD > 1.5) continue;
    used.add(bestJ);
    pairs.push({ id: ids[bestJ]!, x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y });
    keptIds.push(ids[bestJ]!);
  }
  return { pairs, keptIds, keptCur };
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
      let translation = null as [number, number, number] | null;
      let medianFlow = 0;
      let mapPoints = 0;
      let pnpAccepted = false;
      let reprojErrPx = Number.POSITIVE_INFINITY;
      let error: string | undefined;
      const estimateMode = msg.estimateMode ?? "rotation";

      try {
        const rgba = new Uint8ClampedArray(msg.data);
        let gray = rgbaToGray(rgba, msg.w, msg.h);
        const mask = resolveTrackMask(msg.mask, msg.roi);
        // equalizeHist はマスク黒領域があるとヒストグラムを歪めるため full mask 時のみ
        if (isFullMask(mask)) {
          try {
            const cvAny = cv as OpenCvModule & {
              equalizeHist?: (src: CvMat, dst: CvMat) => void;
            };
            if (typeof cvAny.equalizeHist === "function") {
              const eq = new cv.Mat();
              cvAny.equalizeHist(gray, eq);
              gray.delete();
              gray = eq;
            }
          } catch {
            /* optional */
          }
        }

        if (msg.reset || !prevGray || prevPtsList.length === 0) {
          disposeTrackingState();
          prevGray = gray;
          prevPtsList = seedFeatures(gray, msg.w, msg.h, mask);
          if (estimateMode === "walk") {
            prevTrackIds = mfVo.seedFrame0(prevPtsList);
          } else {
            prevTrackIds = prevPtsList.map((_, i) => i + 1);
          }
          framesSinceReset = 0;
          const res: RotationTrackWorkerResponse = {
            type: "rotation",
            idx: msg.idx,
            rotation: null,
            inlierRatio: 0,
            residual: Infinity,
            processMs: performance.now() - t0,
            translation: null,
            medianFlow: 0,
            mapPoints: 0,
            pnpAccepted: false,
            reprojErrPx: Infinity,
          };
          self.postMessage(res);
          return;
        }

        if (estimateMode === "walk") {
          const { pairs, keptIds, keptCur } = trackWithIds(
            prevGray,
            gray,
            prevPtsList,
            prevTrackIds,
          );
          const filteredPairs = pairs.filter((p) => {
            const ok0 = filterPointsInRoiInterior([{ x: p.x0, y: p.y0 }], msg.w, msg.h, mask);
            const ok1 = filterPointsInRoiInterior([{ x: p.x1, y: p.y1 }], msg.w, msg.h, mask);
            return ok0.length > 0 && ok1.length > 0;
          });

          let nextList = keptCur;
          const newPoints: Point2[] = [];
          framesSinceReset += 1;
          if (shouldRediscover(framesSinceReset, nextList.length)) {
            const merged = mergeRediscovered(gray, nextList, msg.w, msg.h, mask);
            for (let i = nextList.length; i < merged.length; i++) newPoints.push(merged[i]!);
            nextList = merged;
          }

          const step = mfVo.processFrame(
            msg.idx,
            filteredPairs,
            newPoints,
            msg.w,
            msg.h,
            msg.focalLength,
          );
          rotation = step.step.rotation;
          translation = step.step.motion;
          medianFlow = step.step.scale;
          inlierRatio = Math.min(1, filteredPairs.length / 40);
          residual = step.reprojErrPx;
          mapPoints = step.mapPoints;
          pnpAccepted = step.pnpAccepted;
          reprojErrPx = step.reprojErrPx;
          prevTrackIds = [...keptIds, ...step.newIds];

          prevGray.delete();
          prevGray = gray;
          prevPtsList = nextList;
        } else {
          const { keptPrev, keptCur } = trackForwardBackward(prevGray, gray, prevPtsList);
          const pairs = buildBearingPairs(keptPrev, keptCur, msg.w, msg.h, msg.focalLength, mask);
          if (pairs.length >= 4) {
            const est = estimateRotationFromPairs(pairs);
            if (est) {
              rotation = est.quaternion;
              inlierRatio = est.inlierRatio;
              residual = est.residual;
            }
          }

          let nextList = keptCur;
          framesSinceReset += 1;
          if (shouldRediscover(framesSinceReset, nextList.length)) {
            nextList = mergeRediscovered(gray, nextList, msg.w, msg.h, mask);
          }

          prevGray.delete();
          prevGray = gray;
          prevPtsList = nextList;
        }
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
        translation,
        medianFlow,
        mapPoints,
        pnpAccepted,
        reprojErrPx,
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
