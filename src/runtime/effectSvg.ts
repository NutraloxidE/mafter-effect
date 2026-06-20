/** §27 — SVG filter primitive 組み立て（純関数・INV-1）。 */

import { seededRandom } from "./exprHelpers";
import { rgbaToPngDataUri } from "./pngDataUri";

export function svgDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * feImage をレイヤー座標 (0,0,w,h) に固定する。
 * filter region を広げても map / mask 画像が引き伸ばされないようにするため、
 * x/y/width/height を明示する（既定は filter region いっぱいに stretch されてしまう）。
 */
function feImageLayer(uri: string, w: number, h: number, result: string): string {
  return `<feImage href="${uri}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="${result}"/>`;
}

/** feDisplacementMap scale から filter region 用パディング（px）を算出。 */
export function displacementPadFromScale(scale: number): number {
  return Math.ceil(Math.max(0, scale) * 0.5) + 2;
}

/** displacement filter region 属性（userSpaceOnUse）。 */
export function svgDisplaceFilterMarkup(
  id: string,
  primitives: string,
  w: number,
  h: number,
  maxScale: number,
  compFixed = false,
): string {
  let region: string;
  if (compFixed) {
    region = `x="0" y="0" width="${w}" height="${h}"`;
  } else {
    const pad = displacementPadFromScale(maxScale);
    region = `x="${-pad}" y="${-pad}" width="${w + 2 * pad}" height="${h + 2 * pad}"`;
  }
  return `<filter id="${id}" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" ${region}>${primitives}</filter>`;
}

export const DISPLACEMENT_EFFECT_TYPES = new Set([
  "wave",
  "turbulentDisplace",
  "ripple",
  "fastWave",
  "fastRipple",
  "fastTurbulentDisplace",
]);

/** §27.12 Draft Preview Fast Path 対象。 */
export const FAST_DISPLACEMENT_EFFECT_TYPES = new Set([
  "fastWave",
  "fastRipple",
  "fastTurbulentDisplace",
]);

/** §27.5 Fast displacement — optional map blur stdDeviation (px, userSpace). */
export const FAST_DISPLACE_AA_STD_DEV = 1;

/** type=turbulence の R/G 正バイアスを 0.5 中心へ寄せる（Amount 比例ドリフト低減）。 */
export const TURBULENCE_CHANNEL_BIAS_INTERCEPT = -0.15;
/** fractalNoise G チャンネル（Y 変位）— comp 全画面キャプチャ residual 低減。 */
export const FRACTAL_NOISE_G_BIAS_INTERCEPT = -0.032;

function feTurbulenceCenterNoise(
  inName: string,
  outName: string,
  interceptR: number,
  interceptG: number = interceptR,
): string {
  return [
    `<feComponentTransfer in="${inName}" result="${outName}">`,
    `<feFuncR type="linear" slope="1" intercept="${interceptR}"/>`,
    `<feFuncG type="linear" slope="1" intercept="${interceptG}"/>`,
    `<feFuncB type="linear" slope="0" intercept="0.5"/>`,
    `<feFuncA type="linear" slope="1" intercept="0"/>`,
    `</feComponentTransfer>`,
  ].join("");
}

function displaceMapBlur(inName: string, outName: string, stdDev: number): string {
  return `<feGaussianBlur in="${inName}" stdDeviation="${stdDev}" result="${outName}"/>`;
}

export function turbulenceDisplace(opts: {
  scale: number;
  baseFrequencyX: number;
  baseFrequencyY: number;
  seed: number;
  numOctaves?: number;
  type?: "fractalNoise" | "turbulence";
  w: number;
  h: number;
  offsetX?: number;
  offsetY?: number;
  evolutionOffsetX?: number;
  evolutionOffsetY?: number;
  /** §27.5 — skip feComponentTransfer bias (Fast 近似・速度優先) */
  skipBias?: boolean;
  antiAlias?: boolean;
}): string {
  const {
    scale,
    baseFrequencyX,
    baseFrequencyY,
    seed,
    numOctaves = 2,
    type = "turbulence",
    w,
    h,
    offsetX = 0,
    offsetY = 0,
    evolutionOffsetX = 0,
    evolutionOffsetY = 0,
    skipBias = false,
    antiAlias = false,
  } = opts;
  const bx = Math.max(0.0001, baseFrequencyX);
  const by = Math.max(0.0001, baseFrequencyY);
  const s = Math.max(0, Math.floor(seed)) % 4096;
  const lw = Math.max(1, w);
  const lh = Math.max(1, h);
  const dx = offsetX + evolutionOffsetX;
  const dy = offsetY + evolutionOffsetY;
  const parts = [
    `<feTurbulence type="${type}" baseFrequency="${bx} ${by}" numOctaves="${numOctaves}" seed="${s}" stitchTiles="stitch" x="0" y="0" width="${lw}" height="${lh}" result="noiseRaw"/>`,
  ];
  let noiseIn = "noiseRaw";
  if (!skipBias) {
    if (type === "turbulence") {
      parts.push(feTurbulenceCenterNoise("noiseRaw", "noiseBalanced", TURBULENCE_CHANNEL_BIAS_INTERCEPT));
      noiseIn = "noiseBalanced";
    } else if (type === "fractalNoise") {
      parts.push(feTurbulenceCenterNoise("noiseRaw", "noiseBalanced", 0, FRACTAL_NOISE_G_BIAS_INTERCEPT));
      noiseIn = "noiseBalanced";
    }
  }
  if (dx !== 0 || dy !== 0) {
    parts.push(`<feOffset in="${noiseIn}" dx="${dx}" dy="${dy}" result="noise"/>`);
    noiseIn = "noise";
  }
  let dispIn = noiseIn;
  if (antiAlias) {
    parts.push(displaceMapBlur(noiseIn, "noiseAA", FAST_DISPLACE_AA_STD_DEV));
    dispIn = "noiseAA";
  }
  parts.push(
    `<feDisplacementMap in="SourceGraphic" in2="${dispIn}" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>`,
  );
  return parts.join("");
}

/** displacement map (data URI) を使って SourceGraphic を変位させる。 */
export function displaceWithMap(
  uri: string,
  scale: number,
  w: number,
  h: number,
  antiAlias = false,
): string {
  const parts = [feImageLayer(uri, w, h, "dmap")];
  let dispIn = "dmap";
  if (antiAlias) {
    parts.push(displaceMapBlur("dmap", "dmapAA", FAST_DISPLACE_AA_STD_DEV));
    dispIn = "dmapAA";
  }
  parts.push(
    `<feDisplacementMap in="SourceGraphic" in2="${dispIn}" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>`,
  );
  return parts.join("");
}

/** phase/evolution (deg) → 決定論的 seed。 */
export function phaseToSeed(degrees: number): number {
  return Math.floor((((degrees % 360) + 360) % 360) * 11.377);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * §27.3 Wave — 真の正弦波 displacement map（feTurbulence のノイズではない）。
 *
 * feDisplacementMap は変位 = scale·(channel − 0.5)。よって振幅 A の正弦波を得るには
 * channel = 0.5 + 0.5·sin(2π·pos/λ + phase)、scale = 2A とする。
 * AE Wave Warp は **横波（transverse）**: 波の進行方向に**垂直**に変位する（旗のはためき）。
 * よって `direction=horizontal`（X 方向に進む波）は Y へ変位（G チャンネルに正弦・R 中立）、
 * `vertical`（Y 方向に進む波）は X へ変位（R に正弦・G 中立）。これで縦割れ（tearing）が出ない。
 * phase をアニメートすると波が滑らかにスクロールする（seed 跳躍なし）。
 */
export function waveDisplaceMapSvg(
  amplitude: number,
  wavelength: number,
  direction: string,
  phaseDeg: number,
  w: number,
  h: number,
  quality = 1,
): { uri: string; scale: number } {
  const lambda = Math.max(1, wavelength);
  const phase = (phaseDeg * Math.PI) / 180;
  const horizontal = direction !== "vertical";
  const span = Math.max(1, horizontal ? w : h);
  const cycles = span / lambda;
  const q = Math.min(1, Math.max(0.1, quality));
  // 1 周期あたり ~8 サンプル（quality で粗化）。極端な高周波は上限でエイリアスを許容（AE も同様）。
  const samples = Math.min(512, Math.max(2, Math.round(cycles * 8 * q) + 1));
  const stops: string[] = [];
  for (let i = 0; i < samples; i++) {
    const o = i / (samples - 1);
    const pos = o * span;
    const v = 0.5 + 0.5 * Math.sin((2 * Math.PI * pos) / lambda + phase);
    const c = Math.round(clamp01(v) * 255);
    // 横波: 進行方向(=gradient 軸)に垂直なチャンネルへ正弦を載せる。
    // horizontal は X に進み Y(G) へ変位、vertical は Y に進み X(R) へ変位。中立 = 128。
    const col = horizontal ? `rgb(128,${c},128)` : `rgb(${c},128,128)`;
    stops.push(`<stop offset="${(o * 100).toFixed(3)}%" stop-color="${col}"/>`);
  }
  const gradAttrs = horizontal
    ? `x1="0" y1="0" x2="1" y2="0"`
    : `x1="0" y1="0" x2="0" y2="1"`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`,
    `<defs><linearGradient id="w" ${gradAttrs}>`,
    stops.join(""),
    `</linearGradient></defs>`,
    `<rect width="100%" height="100%" fill="url(#w)"/>`,
    `</svg>`,
  ].join("");
  return { uri: svgDataUri(svg), scale: 2 * amplitude };
}

/** Ripple displacement map の最大解像度（長辺 px）。場は滑らかなので feImage で引き伸ばす。 */
export const RIPPLE_MAP_MAX_DIM = 256;

/** Ripple map の生成解像度（quality で粗化）。場が滑らかなので低解像度でも放射方向・重心は保たれる。 */
export function rippleMapDims(
  w: number,
  h: number,
  quality = 1,
): { mw: number; mh: number } {
  const lw = Math.max(1, Math.round(w));
  const lh = Math.max(1, Math.round(h));
  const q = Math.min(1, Math.max(0.1, quality));
  const cap = Math.max(16, Math.round(RIPPLE_MAP_MAX_DIM * q));
  const down = Math.max(1, Math.max(lw, lh) / cap);
  return {
    mw: Math.max(2, Math.round(lw / down)),
    mh: Math.max(2, Math.round(lh / down)),
  };
}

/**
 * §27.3 Ripple — 真の**放射方向**正規化変位ベクトル（成分は [-1,1]）。純関数（INV-1）。
 *
 * 中心からの距離 `dist` に沿って正弦が走り、変位は**半径方向の単位ベクトル**へ向く
 * （= AE Ripple 同様に同心円リングが内外へ押し引きされる）。`radius` 外と中心は無変位。
 * かつての実装は変位ベクトルが半径に応じて回転し、リングではなく**渦（spiral）**になっていた。
 */
export function rippleDisplacementSample(
  dx: number,
  dy: number,
  radius: number,
  frequency: number,
  phase: number,
): { x: number; y: number } {
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6 || dist >= radius) return { x: 0, y: 0 };
  const env = 1 - dist / radius; // 外側へ線形減衰（radius でゼロ＝段差なし）
  const theta = (2 * Math.PI * frequency * dist) / radius + phase;
  const mag = env * Math.sin(theta);
  return { x: (dx / dist) * mag, y: (dy / dist) * mag };
}

/**
 * §27.3 Ripple — 同心円状（放射方向）displacement map を PNG data URI で生成。
 *
 * radialGradient（半径方向にしか変化できない）では放射方向ベクトル `(cosθ, sinθ)` を
 * 表現できないため、2D 場をピクセル単位で計算した PNG を `feImage` で参照する。
 * R=X 変位 / G=Y 変位（中立 128）。`feDisplacementMap scale = 2·amplitude`。
 * `center` は中心 px、`frequency` は radius 内のリング数。map は低解像度で生成し
 * feImage がレイヤー実寸へ引き伸ばす（場は滑らかなので劣化しない）。
 */
export function rippleDisplaceMap(
  radius: number,
  amplitude: number,
  frequency: number,
  centerX: number,
  centerY: number,
  w: number,
  h: number,
  phaseDeg = 0,
  quality = 1,
): { uri: string; scale: number } {
  const lw = Math.max(1, Math.round(w));
  const lh = Math.max(1, Math.round(h));
  const r = Math.max(1, radius);
  const freq = Math.max(0.1, frequency);
  const phase = (phaseDeg * Math.PI) / 180;
  const cx = clamp01(centerX) * lw;
  const cy = clamp01(centerY) * lh;

  const { mw, mh } = rippleMapDims(lw, lh, quality);
  const rgba = new Uint8Array(mw * mh * 4);
  for (let my = 0; my < mh; my++) {
    const ly = ((my + 0.5) / mh) * lh; // map セル中心 → レイヤー座標
    for (let mx = 0; mx < mw; mx++) {
      const lx = ((mx + 0.5) / mw) * lw;
      const { x, y } = rippleDisplacementSample(lx - cx, ly - cy, r, freq, phase);
      const o = (my * mw + mx) * 4;
      rgba[o] = Math.round(clamp01(0.5 + 0.5 * x) * 255);
      rgba[o + 1] = Math.round(clamp01(0.5 + 0.5 * y) * 255);
      rgba[o + 2] = 128;
      rgba[o + 3] = 255;
    }
  }
  return { uri: rgbaToPngDataUri(rgba, mw, mh), scale: 2 * amplitude };
}

/**
 * §27.5 Fast Ripple — radialGradient SVG displacement map（PNG 生成なし・旧 WIP 中間版同系）。
 *
 * 半径方向 sin/cos を載せた 1D radialGradient。真の放射ベクトルではない近似（渦寄り）だが
 * per-pixel PNG より軽い。samples は粗め（最大 32）で map 文字列も小さく保つ。
 */
export function fastRippleDisplaceMapSvg(
  radius: number,
  amplitude: number,
  frequency: number,
  centerX: number,
  centerY: number,
  w: number,
  h: number,
): { uri: string; scale: number } {
  const lw = Math.max(1, Math.round(w));
  const lh = Math.max(1, Math.round(h));
  const cx = clamp01(centerX) * lw;
  const cy = clamp01(centerY) * lh;
  const r = Math.max(1, radius);
  const cycles = Math.max(0.1, frequency);
  const samples = Math.min(32, Math.max(8, Math.round(cycles * 4)));
  const stops: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const o = i / samples;
    const env = 1 - o;
    const ph = 2 * Math.PI * cycles * o;
    const rC = Math.round(clamp01(0.5 + 0.5 * env * Math.sin(ph)) * 255);
    const gC = Math.round(clamp01(0.5 + 0.5 * env * Math.cos(ph)) * 255);
    stops.push(`<stop offset="${(o * 100).toFixed(2)}%" stop-color="rgb(${rC},${gC},128)"/>`);
  }
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${lw}" height="${lh}">`,
    `<defs><radialGradient id="r" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}">`,
    stops.join(""),
    `</radialGradient></defs>`,
    `<rect width="100%" height="100%" fill="url(#r)"/>`,
    `</svg>`,
  ].join("");
  return { uri: svgDataUri(svg), scale: 2 * amplitude };
}

/** §27.5 Fast Wave — feTurbulence 直結近似（feImage/PNG なし）。 */
export function fastWaveDisplace(opts: {
  amplitude: number;
  wavelength: number;
  direction: string;
  phaseDeg: number;
  w: number;
  h: number;
  antiAlias?: boolean;
}): string {
  const { amplitude, wavelength, direction, phaseDeg, w, h, antiAlias = false } = opts;
  const freq = wavelengthToFrequency(wavelength);
  const horizontal = direction !== "vertical";
  const f = freq;
  return turbulenceDisplace({
    scale: amplitude,
    baseFrequencyX: horizontal ? f : f * 0.25,
    baseFrequencyY: horizontal ? f * 0.25 : f,
    seed: phaseToSeed(phaseDeg),
    numOctaves: 1,
    type: "fractalNoise",
    w,
    h,
    skipBias: false,
    antiAlias,
  });
}

/** §27.5 Fast Turbulent Displace — 低 octave feTurbulence 直結（G bias のみ）。 */
export function fastTurbulentDisplace(opts: {
  amount: number;
  size: number;
  complexity: number;
  evolution: number;
  offsetX: number;
  offsetY: number;
  randomSeed: number;
  w: number;
  h: number;
  antiAlias?: boolean;
}): string {
  const {
    amount,
    size,
    complexity,
    evolution,
    offsetX,
    offsetY,
    randomSeed,
    w,
    h,
    antiAlias = false,
  } = opts;
  const freq = sizeToFrequency(size);
  const octaves = Math.max(1, Math.min(2, Math.round(complexity)));
  const { dx: evoDx, dy: evoDy } = evolutionToOffsetPx(evolution, size);
  return turbulenceDisplace({
    scale: amount,
    baseFrequencyX: freq,
    baseFrequencyY: freq,
    seed: randomSeed,
    numOctaves: octaves,
    type: "fractalNoise",
    w,
    h,
    offsetX,
    offsetY,
    evolutionOffsetX: evoDx,
    evolutionOffsetY: evoDy,
    skipBias: false,
    antiAlias,
  });
}

/**
 * mask 画像（luminance で reveal を表現）を alpha に変換して SourceGraphic を切り抜く。
 *
 * feComposite operator="in" は in2 の **alpha** で切り抜くため、白黒 luminance を
 * `feColorMatrix type="luminanceToAlpha"` で alpha に変換してから合成する。
 * feather は alpha 化後に feGaussianBlur で適用（二重 feather を避ける）。
 */
function maskComposite(maskUri: string, featherPx: number, w: number, h: number): string {
  const blur =
    featherPx > 0
      ? `<feGaussianBlur in="maskA" stdDeviation="${featherPx}" result="maskBlur"/>`
      : "";
  const maskIn = featherPx > 0 ? "maskBlur" : "maskA";
  return [
    feImageLayer(maskUri, w, h, "maskImg"),
    `<feColorMatrix in="maskImg" type="luminanceToAlpha" result="maskA"/>`,
    blur,
    `<feComposite in="SourceGraphic" in2="${maskIn}" operator="in"/>`,
  ].join("");
}

function allBlackMaskSvg(w: number, h: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="black"/></svg>`;
}

/**
 * Linear Wipe 用グラデーション端点（userSpaceOnUse）。
 *
 * objectBoundingBox + rotate だと斜め角度で矩形の角がグラデーション範囲外に
 * pad され、completion≈1 でも白（表示）が残り completion=1 の全黒マスクへ
 * 急跳びする。四隅の射影 min/max で軸を張れば任意角度で completion が線形に効く。
 */
export function linearWipeGradientCoords(
  angleDeg: number,
  w: number,
  h: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const corners: [number, number][] = [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ];
  let minP = Infinity;
  let maxP = -Infinity;
  for (const [x, y] of corners) {
    const p = x * dx + y * dy;
    minP = Math.min(minP, p);
    maxP = Math.max(maxP, p);
  }
  const cx = w / 2;
  const cy = h / 2;
  const centerP = cx * dx + cy * dy;
  return {
    x1: cx + dx * (minP - centerP),
    y1: cy + dy * (minP - centerP),
    x2: cx + dx * (maxP - centerP),
    y2: cy + dy * (maxP - centerP),
  };
}

/**
 * §27.3 Linear Wipe（AE 準拠の completion 極性）。
 * completion 0 = 完全表示（恒等）、1 = 完全 wipe（非表示）。
 * 表示領域 = (1 − completion)。angle で wipe の向きを回転。
 */
export function linearWipeMask(
  completion: number,
  angleDeg: number,
  featherPx: number,
  w: number,
  h: number,
): string {
  if (completion <= 0) return "";
  if (completion >= 1) {
    return maskComposite(svgDataUri(allBlackMaskSvg(w, h)), 0, w, h);
  }

  const t = clamp01(completion);
  const edge = ((1 - t) * 100).toFixed(3); // 表示境界
  const { x1, y1, x2, y2 } = linearWipeGradientCoords(angleDeg, w, h);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`,
    `<defs>`,
    `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${x1.toFixed(3)}" y1="${y1.toFixed(3)}" x2="${x2.toFixed(3)}" y2="${y2.toFixed(3)}">`,
    `<stop offset="0%" stop-color="white"/>`,
    `<stop offset="${edge}%" stop-color="white"/>`,
    `<stop offset="${edge}%" stop-color="black"/>`,
    `<stop offset="100%" stop-color="black"/>`,
    `</linearGradient>`,
    `</defs>`,
    `<rect width="100%" height="100%" fill="url(#g)"/>`,
    `</svg>`,
  ].join("");
  return maskComposite(svgDataUri(svg), featherPx, w, h);
}

/**
 * §27.3 Angular Wipe（AE 準拠の completion 極性）。
 * completion 0 = 完全表示、1 = 完全 wipe。黒い扇形（= 消える領域）が
 * startAngle から時計回りに sweep = completion·360° で広がる（startAngle 0 = 真上）。
 */
export function angularWipeMask(
  completion: number,
  startAngleDeg: number,
  centerX: number,
  centerY: number,
  featherPx: number,
  w: number,
  h: number,
): string {
  if (completion <= 0) return "";
  if (completion >= 1) {
    return maskComposite(svgDataUri(allBlackMaskSvg(w, h)), 0, w, h);
  }

  const t = clamp01(completion);
  const sweep = t * 360; // 消える扇形の角度
  const cxPx = clamp01(centerX) * w;
  const cyPx = clamp01(centerY) * h;
  const r = Math.hypot(w, h) * 1.5;
  const startRad = ((startAngleDeg - 90) * Math.PI) / 180; // 0 = 真上
  const endRad = startRad + (sweep * Math.PI) / 180;
  const x1 = cxPx + r * Math.cos(startRad);
  const y1 = cyPx + r * Math.sin(startRad);
  const x2 = cxPx + r * Math.cos(endRad);
  const y2 = cyPx + r * Math.sin(endRad);
  const largeArc = sweep > 180 ? 1 : 0;
  const path = `M ${cxPx} ${cyPx} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
  // 白背景（表示）＋黒扇形（消去）。
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`,
    `<rect width="100%" height="100%" fill="white"/>`,
    `<path d="${path}" fill="black"/>`,
    `</svg>`,
  ].join("");
  return maskComposite(svgDataUri(svg), featherPx, w, h);
}

/** Wave / ripple 用 baseFrequency（wavelength px → cycles per user unit）。 */
export function wavelengthToFrequency(wavelengthPx: number): number {
  return 1 / Math.max(1, wavelengthPx);
}

/**
 * Turbulent Displace: AE Size ≈ feature wavelength (px)。
 * feTurbulence baseFrequency = 1 / sizePx（userSpace・レイヤー寸法と整合）。
 */
export function sizeToFrequency(sizePx: number): number {
  return 1 / Math.max(1, sizePx);
}

/** Evolution（deg）→ noise 場パン量（px）。1 revolution ≈ 1 feature size 分の移動。 */
export function evolutionToOffsetPx(evolutionDeg: number, sizePx: number): { dx: number; dy: number } {
  const dist = (evolutionDeg / 360) * Math.max(1, sizePx);
  const rad = (evolutionDeg * Math.PI) / 180;
  return { dx: Math.cos(rad) * dist, dy: Math.sin(rad) * dist };
}

/**
 * §27.3 pixelSortLite — ストリップ displacement map（GPU 近似ピクセルソート）。
 *
 * angle 方向へ引き延ばす map を、angle に垂直な stripWidth ストリップごとに生成する。
 * feDisplacementMap: 変位 = scale·(channel − 0.5)。G チャンネル = streak 方向成分（回転 g 内）。
 */
export function lightPixelSortDisplaceMapSvg(
  angleDeg: number,
  threshold: number,
  streakLength: number,
  stripWidth: number,
  intensity: number,
  phaseDeg: number,
  w: number,
  h: number,
): { uri: string; scale: number } {
  const sw = Math.max(1, Math.round(stripWidth));
  const span = Math.max(w, h);
  const numStrips = Math.max(1, Math.ceil(span / sw));
  const baseSeed = phaseToSeed(phaseDeg);
  const thr = clamp01(threshold);
  const inten = clamp01(intensity);

  const rects: string[] = [];
  for (let i = 0; i < numStrips; i++) {
    const rng = seededRandom((baseSeed + i) >>> 0)();
    const active = rng >= 1 - thr;
    const x = i * sw;
    if (!active || inten <= 0) {
      rects.push(`<rect x="${x}" y="0" width="${sw}" height="${h}" fill="rgb(128,128,128)"/>`);
      continue;
    }
    const mag01 = inten * (0.35 + 0.65 * rng);
    const g = Math.round(clamp01(0.5 + 0.5 * mag01) * 255);
    rects.push(`<rect x="${x}" y="0" width="${sw}" height="${h}" fill="rgb(128,${g},128)"/>`);
  }

  const cx = w / 2;
  const cy = h / 2;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`,
    `<g transform="rotate(${angleDeg} ${cx} ${cy})">`,
    rects.join(""),
    `</g>`,
    `</svg>`,
  ].join("");
  return { uri: svgDataUri(svg), scale: 2 * Math.max(0, streakLength) };
}

/**
 * pixelSortLite — 輝度しきい値ゲート + displacement streak（1 url filter 内）。
 */
export function lightPixelSortFilter(
  angleDeg: number,
  threshold: number,
  streakLength: number,
  stripWidth: number,
  intensity: number,
  phaseDeg: number,
  w: number,
  h: number,
): string {
  if (streakLength <= 0 || intensity <= 0) return "";
  const { uri, scale } = lightPixelSortDisplaceMapSvg(
    angleDeg,
    threshold,
    streakLength,
    stripWidth,
    intensity,
    phaseDeg,
    w,
    h,
  );
  if (scale <= 0) return "";

  const thr = clamp01(threshold);
  const slope = thr >= 1 ? 100 : 1 / Math.max(0.001, 1 - thr);
  const intercept = thr >= 1 ? -100 : -thr * slope;

  // lumGate で streak を輝度しきい値以上に限定するが、operator="in" だけだと
  // しきい値未満が透明になり backdrop-filter 調整レイヤーで黒潰れする。
  // マスク反転で元画を残し feMerge で合成する。
  return [
    `<feColorMatrix in="SourceGraphic" type="luminanceToAlpha" result="lumA"/>`,
    `<feComponentTransfer in="lumA" result="lumGate">`,
    `<feFuncA type="linear" slope="${slope.toFixed(4)}" intercept="${intercept.toFixed(4)}"/>`,
    `</feComponentTransfer>`,
    feImageLayer(uri, w, h, "dmap"),
    `<feDisplacementMap in="SourceGraphic" in2="dmap" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="displaced"/>`,
    `<feComposite in="displaced" in2="lumGate" operator="in" result="streak"/>`,
    `<feComponentTransfer in="lumGate" result="lumInv">`,
    `<feFuncA type="table" tableValues="1 0"/>`,
    `</feComponentTransfer>`,
    `<feComposite in="SourceGraphic" in2="lumInv" operator="in" result="base"/>`,
    `<feMerge>`,
    `<feMergeNode in="base"/>`,
    `<feMergeNode in="streak"/>`,
    `</feMerge>`,
  ].join("");
}
