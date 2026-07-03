/** ソース映像空間の正規化矩形。原点左上、各成分 [0,1]。full = {x:0,y:0,w:1,h:1} */
export interface TrackRoi {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TrackRoiPresetId =
  | "full"
  | "center"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "custom";

export const TRACK_ROI_FULL: TrackRoi = { x: 0, y: 0, w: 1, h: 1 };

export const TRACK_ROI_PRESETS: Record<Exclude<TrackRoiPresetId, "custom">, TrackRoi> = {
  full: TRACK_ROI_FULL,
  center: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
  top: { x: 0, y: 0, w: 1, h: 0.5 },
  bottom: { x: 0, y: 0.5, w: 1, h: 0.5 },
  left: { x: 0, y: 0, w: 0.5, h: 1 },
  right: { x: 0.5, y: 0, w: 0.5, h: 1 },
};

export const TRACK_ROI_PRESET_LABELS: Record<TrackRoiPresetId, string> = {
  full: "全体",
  center: "中央",
  top: "上半分",
  bottom: "下半分",
  left: "左半分",
  right: "右半分",
  custom: "カスタム",
};

const MIN_FRAC = 0.1;

function finiteOr(v: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * ROI を [0,1] にクランプ。最小 w/h = 0.1。x+w≤1, y+h≤1。
 * 不正入力は full に倒す。
 */
export function normalizeTrackRoi(roi: TrackRoi | null | undefined): TrackRoi {
  if (!roi || typeof roi !== "object") return { ...TRACK_ROI_FULL };

  let w = Math.min(1, Math.max(MIN_FRAC, finiteOr(roi.w, 1)));
  let h = Math.min(1, Math.max(MIN_FRAC, finiteOr(roi.h, 1)));
  let x = Math.min(1 - w, Math.max(0, finiteOr(roi.x, 0)));
  let y = Math.min(1 - h, Math.max(0, finiteOr(roi.y, 0)));

  // 再クランプ（丸め誤差）
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  if (w < MIN_FRAC) {
    w = MIN_FRAC;
    x = Math.min(1 - w, Math.max(0, x));
  }
  if (h < MIN_FRAC) {
    h = MIN_FRAC;
    y = Math.min(1 - h, Math.max(0, y));
  }

  return { x, y, w, h };
}

export function isFullRoi(roi: TrackRoi): boolean {
  const n = normalizeTrackRoi(roi);
  return n.x === 0 && n.y === 0 && n.w === 1 && n.h === 1;
}

export function presetToRoi(preset: TrackRoiPresetId, custom?: TrackRoi): TrackRoi {
  if (preset === "custom") return normalizeTrackRoi(custom ?? TRACK_ROI_FULL);
  return { ...TRACK_ROI_PRESETS[preset] };
}

/** 正規化 ROI → ピクセル矩形（右下 inclusive ではなく half-open [x0,x1) × [y0,y1)）。 */
export function roiToPixelRect(
  roi: TrackRoi,
  width: number,
  height: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const n = normalizeTrackRoi(roi);
  const x0 = Math.max(0, Math.min(width, Math.floor(n.x * width)));
  const y0 = Math.max(0, Math.min(height, Math.floor(n.y * height)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((n.x + n.w) * width)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil((n.y + n.h) * height)));
  return { x0, y0, x1, y1 };
}

/**
 * ダウンサンプル済み RGBA に ROI mask を適用（矩形外を 0 塗り）。
 * 画像サイズは変えない（回転推定の主点 w/2,h/2 を維持）。
 * full ROI のときは入力をそのまま返す（コピーしない）。
 */
export function applyRoiMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  roi: TrackRoi | null | undefined,
): Uint8ClampedArray {
  if (width <= 0 || height <= 0) return rgba;
  const n = normalizeTrackRoi(roi);
  if (isFullRoi(n)) return rgba;

  const { x0, y0, x1, y1 } = roiToPixelRect(n, width, height);
  const out = new Uint8ClampedArray(rgba.length);

  for (let y = y0; y < y1; y++) {
    const row = y * width * 4;
    const srcStart = row + x0 * 4;
    const srcEnd = row + x1 * 4;
    out.set(rgba.subarray(srcStart, srcEnd), srcStart);
  }
  return out;
}
