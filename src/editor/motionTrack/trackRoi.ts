/** ソース映像空間の正規化矩形。原点左上、各成分 [0,1]。full = {x:0,y:0,w:1,h:1} */
export interface TrackRoi {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 追跡マスク。include の和集合から exclude を引く。
 * include 未指定 = 全体。exclude 未指定 = 除外なし。
 */
export interface TrackMaskSpec {
  include?: TrackRoi[];
  exclude?: TrackRoi[];
}

export type TrackRoiPresetId =
  | "full"
  | "background"
  | "center"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "custom";

export const TRACK_ROI_FULL: TrackRoi = { x: 0, y: 0, w: 1, h: 1 };

/**
 * 人混みの手前〜中央下を除外（歩き撮り向けオプトイン）。
 * 道路全体を消さないよう y は 0.35 から（Comp 27 のような路面標示シーンを壊さない）。
 */
export const TRACK_EXCLUDE_CROWD: TrackRoi = { x: 0.15, y: 0.35, w: 0.7, h: 0.6 };

export const TRACK_ROI_PRESETS: Record<Exclude<TrackRoiPresetId, "custom" | "background">, TrackRoi> = {
  full: TRACK_ROI_FULL,
  center: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
  top: { x: 0, y: 0, w: 1, h: 0.5 },
  bottom: { x: 0, y: 0.5, w: 1, h: 0.5 },
  left: { x: 0, y: 0, w: 0.5, h: 1 },
  right: { x: 0.5, y: 0, w: 0.5, h: 1 },
};

export const TRACK_ROI_PRESET_LABELS: Record<TrackRoiPresetId, string> = {
  full: "全体",
  background: "背景優先（人混み）",
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

export function normalizeTrackMask(mask: TrackMaskSpec | null | undefined): TrackMaskSpec {
  if (!mask) return {};
  return {
    include: mask.include?.map((r) => normalizeTrackRoi(r)),
    exclude: mask.exclude?.map((r) => normalizeTrackRoi(r)),
  };
}

export function isFullMask(mask: TrackMaskSpec | null | undefined): boolean {
  const m = normalizeTrackMask(mask);
  const hasExclude = (m.exclude?.length ?? 0) > 0;
  if (hasExclude) return false;
  const inc = m.include;
  if (!inc || inc.length === 0) return true;
  return inc.length === 1 && isFullRoi(inc[0]!);
}

/** 単一 include ROI（後方互換）。background は exclude マスク。 */
export function presetToRoi(preset: TrackRoiPresetId, custom?: TrackRoi): TrackRoi {
  if (preset === "custom") return normalizeTrackRoi(custom ?? TRACK_ROI_FULL);
  if (preset === "background") return TRACK_ROI_FULL;
  return { ...TRACK_ROI_PRESETS[preset] };
}

export function presetToMask(preset: TrackRoiPresetId, custom?: TrackRoi): TrackMaskSpec {
  if (preset === "background") {
    return { exclude: [TRACK_EXCLUDE_CROWD] };
  }
  if (preset === "full") return {};
  if (preset === "custom") {
    return { include: [normalizeTrackRoi(custom ?? TRACK_ROI_FULL)] };
  }
  return { include: [{ ...TRACK_ROI_PRESETS[preset] }] };
}

/** TrackOptions.roi（単一）または mask を統合。 */
export function resolveTrackMask(
  mask?: TrackMaskSpec | null,
  roi?: TrackRoi | null,
): TrackMaskSpec {
  if (mask && ((mask.include?.length ?? 0) > 0 || (mask.exclude?.length ?? 0) > 0)) {
    return normalizeTrackMask(mask);
  }
  if (roi) {
    const n = normalizeTrackRoi(roi);
    if (isFullRoi(n)) return {};
    return { include: [n] };
  }
  return {};
}

export interface PixelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 正規化 ROI → ピクセル矩形（half-open [x0,x1) × [y0,y1)）。 */
export function roiToPixelRect(
  roi: TrackRoi,
  width: number,
  height: number,
): PixelRect {
  const n = normalizeTrackRoi(roi);
  const x0 = Math.max(0, Math.min(width, Math.floor(n.x * width)));
  const y0 = Math.max(0, Math.min(height, Math.floor(n.y * height)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((n.x + n.w) * width)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil((n.y + n.h) * height)));
  return { x0, y0, x1, y1 };
}

function pointInRectExpanded(x: number, y: number, r: PixelRect, margin: number): boolean {
  return (
    x >= r.x0 - margin &&
    y >= r.y0 - margin &&
    x < r.x1 + margin &&
    y < r.y1 + margin
  );
}

/**
 * ROI 内部かつ縁から margin px 以上内側なら true。
 * full-frame ROI ではフレーム端 margin のみ。
 */
export function isInsideRoiInterior(
  x: number,
  y: number,
  rect: PixelRect,
  margin: number,
  frameW: number,
  frameH: number,
): boolean {
  const m = Math.max(0, margin);
  const x0 = Math.max(m, rect.x0 + m);
  const y0 = Math.max(m, rect.y0 + m);
  const x1 = Math.min(frameW - m, rect.x1 - m);
  const y1 = Math.min(frameH - m, rect.y1 - m);
  if (x1 <= x0 || y1 <= y0) {
    return x >= m && y >= m && x < frameW - m && y < frameH - m;
  }
  return x >= x0 && y >= y0 && x < x1 && y < y1;
}

/**
 * マスク上で特徴として使える点か。
 * include 内部（縁 margin 内側）かつ exclude（縁 margin 外側）の外。
 */
export function isValidTrackMaskPoint(
  x: number,
  y: number,
  mask: TrackMaskSpec | null | undefined,
  margin: number,
  frameW: number,
  frameH: number,
): boolean {
  const m = Math.max(0, margin);
  if (x < m || y < m || x >= frameW - m || y >= frameH - m) return false;

  const resolved = normalizeTrackMask(mask);
  const includes = resolved.include ?? [];
  const excludes = resolved.exclude ?? [];

  if (includes.length > 0) {
    let inInclude = false;
    for (const inc of includes) {
      const rect = roiToPixelRect(inc, frameW, frameH);
      if (isInsideRoiInterior(x, y, rect, m, frameW, frameH)) {
        inInclude = true;
        break;
      }
    }
    if (!inInclude) return false;
  }

  for (const ex of excludes) {
    const rect = roiToPixelRect(ex, frameW, frameH);
    // exclude 境界の偽特徴を避けるため margin 分広げて棄却
    if (pointInRectExpanded(x, y, rect, m)) return false;
  }

  return true;
}

function zeroRect(out: Uint8ClampedArray, width: number, rect: PixelRect): void {
  for (let y = rect.y0; y < rect.y1; y++) {
    const row = y * width * 4;
    out.fill(0, row + rect.x0 * 4, row + rect.x1 * 4);
  }
}

function copyRect(
  src: Uint8ClampedArray,
  out: Uint8ClampedArray,
  width: number,
  rect: PixelRect,
): void {
  for (let y = rect.y0; y < rect.y1; y++) {
    const row = y * width * 4;
    const a = row + rect.x0 * 4;
    const b = row + rect.x1 * 4;
    out.set(src.subarray(a, b), a);
  }
}

/**
 * ダウンサンプル済み RGBA に追跡マスクを適用（画像サイズ不変）。
 * include 外・exclude 内を 0 塗り。
 */
export function applyTrackMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  mask: TrackMaskSpec | null | undefined,
): Uint8ClampedArray {
  if (width <= 0 || height <= 0) return rgba;
  const resolved = normalizeTrackMask(mask);
  if (isFullMask(resolved)) return rgba;

  const includes = resolved.include ?? [];
  const excludes = resolved.exclude ?? [];

  let out: Uint8ClampedArray;
  if (includes.length === 0) {
    out = new Uint8ClampedArray(rgba);
  } else {
    out = new Uint8ClampedArray(rgba.length);
    for (const inc of includes) {
      copyRect(rgba, out, width, roiToPixelRect(inc, width, height));
    }
  }

  for (const ex of excludes) {
    zeroRect(out, width, roiToPixelRect(ex, width, height));
  }
  return out;
}

/** @deprecated applyTrackMask を使う。単一 include の後方互換。 */
export function applyRoiMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  roi: TrackRoi | null | undefined,
): Uint8ClampedArray {
  if (!roi || isFullRoi(roi)) return rgba;
  return applyTrackMask(rgba, width, height, { include: [roi] });
}

/**
 * 逆光・低コントラスト向けの簡易コントラスト伸長（RGB 共通）。
 * p5–p95 を 0–255 にマップ。マスク後に掛けると黒領域はそのまま。
 */
export function enhanceContrastRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const n = width * height;
  if (n <= 0) return rgba;

  const lum = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    lum[i] = (rgba[o]! * 77 + rgba[o + 1]! * 150 + rgba[o + 2]! * 29) >> 8;
  }

  const hist = new Uint32Array(256);
  let nonzero = 0;
  for (let i = 0; i < n; i++) {
    const L = lum[i]!;
    if (L > 0) {
      hist[L]!++;
      nonzero++;
    }
  }
  if (nonzero < 16) return rgba;

  const loCount = Math.floor(nonzero * 0.05);
  const hiCount = Math.floor(nonzero * 0.95);
  let acc = 0;
  let pLo = 0;
  let pHi = 255;
  for (let v = 1; v < 256; v++) {
    acc += hist[v]!;
    if (acc >= loCount && pLo === 0) pLo = v;
    if (acc >= hiCount) {
      pHi = v;
      break;
    }
  }
  if (pHi <= pLo + 8) return rgba;

  const scale = 255 / (pHi - pLo);
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (rgba[o]! === 0 && rgba[o + 1]! === 0 && rgba[o + 2]! === 0 && rgba[o + 3]! === 0) {
      continue; // keep mask zeros
    }
    for (let c = 0; c < 3; c++) {
      const v = rgba[o + c]!;
      out[o + c] = Math.max(0, Math.min(255, Math.round((v - pLo) * scale)));
    }
    out[o + 3] = rgba[o + 3]!;
  }
  return out;
}
