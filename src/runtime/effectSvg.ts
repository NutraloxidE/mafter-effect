/** §27 — SVG filter primitive 組み立て（純関数・INV-1）。 */

import { ditherVisibleAt, normalizeDitherPattern, type DitherPattern } from "./ditherMask";
import { quantizeDitherReveal } from "./ditherReveal";
import { seededRandom } from "./exprHelpers";
import { rgbaToPngDataUri } from "./pngDataUri";

export { ditherEffectiveReveal, quantizeDitherReveal } from "./ditherReveal";

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

/**
 * `feImage`+`feTile` タイルの縮退方向（変化しない軸）の最小ピクセル数。
 *
 * §27.3 改定1（2026-07-13・重大バグ修正）: `scanlineTilePng` は当初、変化しない軸を
 * 1px に切り詰めていた（`glitchSlice` の「冗長軸は 1px に潰して軽量化」と同じ発想）。
 * しかし実 Chrome で検証したところ、**1px 幅の `feImage` を `feTile` で反復し、さらに
 * その要素が祖先の CSS `transform: scale(...)` で縮小表示される**（Preview パネルの
 * "Fit" ズームは常にこの状態）と、GPU のテクスチャ縮小サンプリングが破綻し、縞が
 * 一切描画されない（多重化/モアレの上、実質透明になり `feBlend multiply` が no-op と
 * 化して原色がそのまま透過する）。`mosaicGridSnapFilter` が同じ `feImage`+`feTile` 構成で
 * `MOSAIC_TILE_MIN_DIM = 16` を最小タイル寸法として使っているのは同じ理由（この定数は
 * 既存の対策を再利用の発想）。1px 幅と比べデータ量はわずかに増えるが 16×64 でも数十 KB
 * 程度に収まり、§2.5 の「生 PNG + feTile」自体の軽さは変わらない。
 * （`MOSAIC_TILE_MIN_DIM` はこのファイル後方で定義されるため値を直接複製する。同じ規約。）
 */
const SCANLINE_TILE_MIN_STATIC_DIM = 16;

/**
 * §27.3 Scanlines — 1 タイル分の明暗バンドを RGBA バッファへ焼く（§2.5: 生 PNG + native feTile）。
 *
 * `<pattern>` を `feImage` に渡すネスト SVG 文書構成は毎フレーム再ラスタライズされ致命的に重い
 * （implement-visual-effect §7c 実測）。ここでは 1 本の帯だけを生 PNG に焼き、呼び出し側で
 * `feTile` によりフィルタグラフ内でネイティブに全域反復する。
 * horizontal は縦方向（Y）に周期を持つため tile は `SCANLINE_TILE_MIN_STATIC_DIM`×lineHeight、
 * vertical はその転置（変化しない軸を 1px にはしない・改定1参照）。
 */
export function scanlineTilePng(
  lineHeight: number,
  duty: number,
  opacity: number,
  direction: "horizontal" | "vertical",
): { uri: string; w: number; h: number } {
  const lh = Math.max(1, Math.round(lineHeight));
  const d = Math.min(0.95, Math.max(0.05, duty));
  const op = Math.min(1, Math.max(0, opacity));
  const darkLen = Math.min(lh, Math.max(0, Math.round(lh * d)));
  const darkGray = Math.round(255 * (1 - op));
  const horizontal = direction !== "vertical";
  const tw = horizontal ? SCANLINE_TILE_MIN_STATIC_DIM : lh;
  const th = horizontal ? lh : SCANLINE_TILE_MIN_STATIC_DIM;
  const rgba = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const bandIdx = horizontal ? y : x;
      const gray = bandIdx < darkLen ? darkGray : 255;
      const o = (y * tw + x) * 4;
      rgba[o] = gray;
      rgba[o + 1] = gray;
      rgba[o + 2] = gray;
      rgba[o + 3] = 255;
    }
  }
  return { uri: rgbaToPngDataUri(rgba, tw, th), w: tw, h: th };
}

/**
 * §27.3 Glitch Slice — 水平スライスの変位マップを生 PNG に焼く（§2.2/§2.5・改定1: 1 列化）。
 *
 * スライスごとに変位が異なるためタイル化不可（`feTile` は使わず、`feImageLayer` で
 * レイヤー実寸 `(0,0,w,h)` へ引き伸ばして渡す）。R チャンネルに正規化変位（0.5=無変位）、
 * G は中立 0.5 固定（水平スライスなので Y 変位は使わない）。`seededRandom` +
 * `phaseToSeed(evolution)` で INV-1 決定論。
 *
 * **改定1（重さ対策）**: 初版は `w×h` フル解像度でバッファを埋めていたが、値は各行内で
 * x に依存しない（水平スライスは行内一様）ため **x 方向は完全に冗長**だった。1920×1080 なら
 * 8.3MB の raw buffer を毎 apply() で生成・PNG エンコード・base64 化しており、これが
 * 「重すぎる」の実体（JS 側の生成コストであって §2.5 の feImage ネスト文書コストとは別軸）。
 * `feImage`(1×h の生 PNG) を `width="{w}"` で水平方向にのみ引き伸ばす（1 列を複製するだけ
 * なので拡大縮小補間の余地がなく exact）。垂直方向は h=h の 1:1（スケーリングなし）を維持し、
 * スライス境界の離散性（グリッチは離散が正）を崩さない。w×h → 1×h で ~w 倍軽量。
 */
export function glitchSliceDisplaceMapPng(opts: {
  w: number;
  h: number;
  sliceHeight: number;
  maxShift: number;
  density: number;
  seed: number;
  evolution: number;
}): { uri: string; scale: number } {
  const h = Math.max(1, Math.round(opts.h));
  const sliceHeight = Math.max(2, Math.round(opts.sliceHeight));
  const maxShift = Math.max(0, opts.maxShift);
  const density = Math.min(1, Math.max(0, opts.density));
  const baseSeed = Math.max(0, Math.floor(opts.seed)) % 100000;
  const evoSeed = phaseToSeed(opts.evolution);
  const rgba = new Uint8Array(1 * h * 4);
  const numSlices = Math.ceil(h / sliceHeight);
  for (let k = 0; k < numSlices; k++) {
    const rng = seededRandom((baseSeed * 1000003 + k * 97 + evoSeed) >>> 0);
    const jumpRoll = rng();
    const shiftRoll = rng();
    const jumps = jumpRoll < density;
    const shiftNorm = jumps ? shiftRoll * 2 - 1 : 0; // -1..1、未変位帯は 0
    const rVal = Math.min(255, Math.max(0, Math.round(255 * (0.5 + shiftNorm * 0.5))));
    const y0 = k * sliceHeight;
    const y1 = Math.min(h, y0 + sliceHeight);
    for (let y = y0; y < y1; y++) {
      const o = y * 4;
      rgba[o] = rVal;
      rgba[o + 1] = 128;
      rgba[o + 2] = 0;
      rgba[o + 3] = 255;
    }
  }
  return { uri: rgbaToPngDataUri(rgba, 1, h), scale: maxShift };
}

/**
 * §27.3 Pixel Stretch（WP-D Ticket D-1 spike・go/no-go はユーザー確認待ち）— 線形ランプ変位マップ。
 *
 * `dy(y) = -(y - pivot)` を R チャンネル（8-bit・`0.5 + dy/(2*amount)` にクランプ）へ焼く。
 * `feDisplacementMap` は pull 型（出力行 y は入力行 `y + dy(y)` をサンプルする）ため、
 * pivot 近傍（`|y-pivot| < amount` の非クランプ域）は `y + dy(y) = pivot` に収束し
 * **同一入力行が全域に引き伸ばされる**（AE Pixel Stretch のスミア）。pivot から離れた
 * クランプ域は `dy = ±amount`（一定）となり**元の内容が剛体シフトしたコピー**になる。
 * 8-bit R チャンネル由来の階段量子化がスミア/シフト境界に段差として現れるのが本エフェクトの
 * 見た目の実体（D-1 spike・味として受け入れるか実機で判断中・§6 参照）。x 方向は値が変化
 * しないため 1 列に圧縮する（`feTile` を使わない plain `feImage` stretch なので §2.5 系の
 * feTile 縮小サンプリング罠には該当しない・[[svg-fetile-1px-source-vanishes-under-css-scale]] 非該当）。
 */
export function pixelStretchDisplaceMapPng(opts: {
  h: number;
  amount: number;
  pivot: number;
}): { uri: string; scale: number } {
  const h = Math.max(1, Math.round(opts.h));
  const amount = Math.max(1, opts.amount);
  const pivot = Math.min(1, Math.max(0, opts.pivot)) * h;
  const rgba = new Uint8Array(1 * h * 4);
  for (let y = 0; y < h; y++) {
    const dy = pivot - y;
    const norm = 0.5 + dy / (2 * amount);
    const r = Math.min(255, Math.max(0, Math.round(norm * 255)));
    const o = y * 4;
    rgba[o] = r;
    rgba[o + 1] = 128;
    rgba[o + 2] = 0;
    rgba[o + 3] = 255;
  }
  return { uri: rgbaToPngDataUri(rgba, 1, h), scale: amount };
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
  "opticsCompensation",
  "mosaicLite",
  "fastWave",
  "fastRipple",
  "fastTurbulentDisplace",
  "glitchSlice",
  "pixelStretch",
]);

/** §27.12 Draft Preview Fast Path 対象。 */
export const FAST_DISPLACEMENT_EFFECT_TYPES = new Set([
  "mosaicLite",
  "fastWave",
  "fastRipple",
  "fastTurbulentDisplace",
  "glitchSlice",
  "pixelStretch",
]);

/** §27.3 — live CSS filter 完結 displacement（raster capture 対象外）。Fast* + opticsCompensation + glitchSlice。 */
export const LIVE_DISPLACEMENT_EFFECT_TYPES = new Set([
  ...FAST_DISPLACEMENT_EFFECT_TYPES,
  "opticsCompensation",
]);

/** Optics Compensation — FOV 上限（tan 発散回避）。 */
export const OPTICS_MAX_FOV_DEG = 170;

/** AE FOV 目視キャリブ用内部スケール（ユーザーパラメータではない）。 */
export const OPTICS_FOV_DEG_SCALE = 1;

/** §27.5 Fast displacement — optional map blur stdDeviation (px, userSpace). */
export const FAST_DISPLACE_AA_STD_DEV = 1;

/**
 * §27.5 改定5 — Fast displacement の常時 map smoothing 量。
 * 特徴サイズ（wave: λ / ripple: radius/frequency / turbulent: size）に比例した
 * feGaussianBlur stdDeviation を [FAST_SMOOTH_MIN, FAST_SMOOTH_MAX]px に clamp して使う。
 * 大きすぎると変位の山が均されて効果が消えるため控えめ（0.12）。
 */
export const FAST_SMOOTH_FRACTION = 0.06;
export const FAST_SMOOTH_MIN = 0.75;
export const FAST_SMOOTH_MAX = 6;

/** 特徴サイズ → 常時 map smoothing 用 stdDeviation(px)。 */
export function fastSmoothPx(featurePx: number): number {
  const v = FAST_SMOOTH_FRACTION * Math.max(0, featurePx);
  return Math.min(FAST_SMOOTH_MAX, Math.max(FAST_SMOOTH_MIN, v));
}

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
  /** §27.5 改定5 — noise map に常時かける feGaussianBlur stdDeviation (px・antiAlias と加算)。 */
  smoothPx?: number;
  /** §27.5 改定5 — feTurbulence 生成域を ±pad 対称拡張し feOffset パン後も layer を被覆。 */
  regionPadX?: number;
  regionPadY?: number;
  /** §27.5 改定5 — stitchTiles の有無。false で座標安定場（生成域変化で boiling しない）。 */
  stitch?: boolean;
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
    smoothPx = 0,
    regionPadX = 0,
    regionPadY = 0,
    stitch = true,
  } = opts;
  const bx = Math.max(0.0001, baseFrequencyX);
  const by = Math.max(0.0001, baseFrequencyY);
  const s = Math.max(0, Math.floor(seed)) % 4096;
  const lw = Math.max(1, w);
  const lh = Math.max(1, h);
  const padX = Math.max(0, Math.ceil(regionPadX));
  const padY = Math.max(0, Math.ceil(regionPadY));
  const tx = -padX;
  const ty = -padY;
  const tw = lw + 2 * padX;
  const th = lh + 2 * padY;
  const dx = offsetX + evolutionOffsetX;
  const dy = offsetY + evolutionOffsetY;
  const stitchAttr = stitch ? ` stitchTiles="stitch"` : "";
  const parts = [
    `<feTurbulence type="${type}" baseFrequency="${bx} ${by}" numOctaves="${numOctaves}" seed="${s}"${stitchAttr} x="${tx}" y="${ty}" width="${tw}" height="${th}" result="noiseRaw"/>`,
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
  const blurStd = Math.max(0, smoothPx) + (antiAlias ? FAST_DISPLACE_AA_STD_DEV : 0);
  if (blurStd > 0) {
    parts.push(displaceMapBlur(noiseIn, "noiseAA", blurStd));
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

/** 中心 (cx,cy) からレイヤー四隅までの最大距離。 */
export function opticsRMax(cx: number, cy: number, w: number, h: number): number {
  const lw = Math.max(1, w);
  const lh = Math.max(1, h);
  let max = 0;
  for (const [px, py] of [[0, 0], [lw, 0], [0, lh], [lw, lh]] as const) {
    max = Math.max(max, Math.hypot(px - cx, py - cy));
  }
  return Math.max(max, 1);
}

/** 正規化半径 rn に対する Optics Compensation 写像先 rn'。 */
export function opticsMappedRn(rn: number, fovDeg: number, reverse: boolean): number {
  const clampedFov = Math.min(OPTICS_MAX_FOV_DEG, Math.max(0, fovDeg)) * OPTICS_FOV_DEG_SCALE;
  const theta = (clampedFov * Math.PI) / 360;
  if (theta < 1e-8 || rn <= 0) return rn;
  const tanTheta = Math.tan(theta);
  if (Math.abs(tanTheta) < 1e-8) return rn;
  if (reverse) {
    return Math.atan(rn * tanTheta) / theta;
  }
  return Math.tan(theta * rn) / tanTheta;
}

/** rn∈[0,1] 上の max |rn'−rn|（scale 算出用・四隅 rn=1 では 0 になり得る）。 */
export function opticsMaxRadialDelta(fovDeg: number, reverse: boolean): number {
  if (fovDeg <= 0) return 0;
  let max = 0;
  const steps = 128;
  for (let i = 0; i <= steps; i++) {
    const rn = i / steps;
    const mapped = opticsMappedRn(rn, fovDeg, reverse);
    max = Math.max(max, Math.abs(mapped - rn));
  }
  return max;
}

/** §27.3 Optics Compensation — 放射方向変位（正規化成分 [-1,1]）。純関数（INV-1）。 */
export function opticsDisplacementSample(
  dx: number,
  dy: number,
  rMax: number,
  fovDeg: number,
  reverse: boolean,
): { x: number; y: number } {
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6 || rMax < 1e-6) return { x: 0, y: 0 };
  const maxDeltaRn = opticsMaxRadialDelta(fovDeg, reverse);
  if (maxDeltaRn < 1e-9) return { x: 0, y: 0 };
  const rn = dist / rMax;
  const rnPrime = opticsMappedRn(rn, fovDeg, reverse);
  const radialDelta = (rnPrime - rn) * rMax;
  const scalePx = rMax * maxDeltaRn;
  const ux = dx / dist;
  const uy = dy / dist;
  return { x: (ux * radialDelta) / scalePx, y: (uy * radialDelta) / scalePx };
}

/** feDisplacementMap scale（px）— effectChain region 推定用。 */
export function opticsDisplaceScalePx(
  fieldOfView: number,
  reverse: boolean,
  w: number,
  h: number,
  centerX: number,
  centerY: number,
): number {
  const fov = Math.max(0, fieldOfView);
  const maxDeltaRn = opticsMaxRadialDelta(fov, reverse);
  if (maxDeltaRn < 1e-9) return 0;
  const lw = Math.max(1, Math.round(w));
  const lh = Math.max(1, Math.round(h));
  const cx = clamp01(centerX) * lw;
  const cy = clamp01(centerY) * lh;
  return opticsRMax(cx, cy, lw, lh) * maxDeltaRn;
}

/**
 * §27.3 Optics Compensation — FOV ベース放射 displacement map（PNG data URI）。
 *
 * AE Optics Compensation 相当（Resize / 色収差は Phase 2）。ripple と同型の 2D ベクトル map。
 */
export function opticsCompensationDisplaceMap(
  fieldOfView: number,
  reverse: boolean,
  centerX: number,
  centerY: number,
  w: number,
  h: number,
  quality = 1,
): { uri: string; scale: number } {
  const fov = Math.max(0, fieldOfView);
  const maxDeltaRn = opticsMaxRadialDelta(fov, reverse);
  const lw = Math.max(1, Math.round(w));
  const lh = Math.max(1, Math.round(h));
  const cx = clamp01(centerX) * lw;
  const cy = clamp01(centerY) * lh;
  const rMax = opticsRMax(cx, cy, lw, lh);
  const scalePx = rMax * maxDeltaRn;
  const scale = 2 * scalePx;

  const { mw, mh } = rippleMapDims(lw, lh, quality);
  const rgba = new Uint8Array(mw * mh * 4);
  for (let my = 0; my < mh; my++) {
    const ly = ((my + 0.5) / mh) * lh;
    for (let mx = 0; mx < mw; mx++) {
      const lx = ((mx + 0.5) / mw) * lw;
      const { x, y } = opticsDisplacementSample(lx - cx, ly - cy, rMax, fov, reverse);
      const o = (my * mw + mx) * 4;
      rgba[o] = Math.round(clamp01(0.5 + 0.5 * x) * 255);
      rgba[o + 1] = Math.round(clamp01(0.5 + 0.5 * y) * 255);
      rgba[o + 2] = 128;
      rgba[o + 3] = 255;
    }
  }
  return { uri: rgbaToPngDataUri(rgba, mw, mh), scale };
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
 * §27.5 改定4 — Fast Wave（`feTurbulence` 近似・`feImage` なし・Web 軽量）。
 *
 * フル `wave` の linearGradient 正弦 map（`feImage`・data URI・毎フレーム再デコード）を捨て、
 * GPU ネイティブな `feTurbulence`（`type="fractalNoise"`・`numOctaves=1`）へ置換する。
 * 正弦の見た目は意図的に放棄し（ユーザー承認 2026-06-21）、進行方向に沿って揺れる方向性ノイズ
 * 歪みになる。per-frame コストは `fastTurbulentDisplace` と同等。
 * - 進行方向(direction)軸 = `1/λ`、直交軸 = `1/(4λ)`（低周波で稜線を伸ばし波 train 風に）。
 * - `phase` は進行方向の `feOffset` パン（`(phase/360)·λ` px）でスクロールを再現。
 */
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
  const lambda = Math.max(1, wavelength);
  const horizontal = direction !== "vertical";
  const freqAlong = 1 / lambda;
  const freqPerp = 1 / (lambda * 4);
  // 改定5: phase は連続パン（% 360 折返しなし）で段差ジャンプを解消。
  const phasePan = (phaseDeg / 360) * lambda;
  // 改定5: stitch を外した座標安定場とし、生成域を |pan| ぶん対称拡張して露出を防ぐ
  //（pan で生成域が変化しても noise 値が変わらず boiling しない）。
  const pad = Math.abs(phasePan) + 2;
  return turbulenceDisplace({
    scale: 2 * Math.max(0, amplitude),
    baseFrequencyX: horizontal ? freqAlong : freqPerp,
    baseFrequencyY: horizontal ? freqPerp : freqAlong,
    seed: 1,
    numOctaves: 1,
    type: "fractalNoise",
    w,
    h,
    offsetX: horizontal ? phasePan : 0,
    offsetY: horizontal ? 0 : phasePan,
    smoothPx: fastSmoothPx(lambda),
    regionPadX: horizontal ? pad : 0,
    regionPadY: horizontal ? 0 : pad,
    stitch: false,
    antiAlias,
  });
}

/**
 * §27.5 改定4 — Fast Ripple（`feTurbulence` 近似・`feImage`/PNG なし・Web 軽量）。
 *
 * フル `ripple` の per-pixel PNG 放射 map も WIP radialGradient map（旧 `rippleDisplaceMapSvg`）も
 * 捨て、`feTurbulence`（`type="fractalNoise"`・`numOctaves=1`・等方）へ置換する。同心円の見た目は
 * 意図的に放棄し（ユーザー承認 2026-06-21）、`frequency`/`radius` からリング間隔相当の特徴サイズを
 * 導いた等方ノイズ歪みになる。`center` は noise 場の `feOffset` パンで近似。
 */
export function fastRippleDisplace(opts: {
  radius: number;
  amplitude: number;
  frequency: number;
  centerX: number;
  centerY: number;
  w: number;
  h: number;
  antiAlias?: boolean;
}): string {
  const { radius, amplitude, frequency, centerX, centerY, w, h, antiAlias = false } = opts;
  const r = Math.max(1, radius);
  const freq = Math.max(0.1, frequency);
  const bf = freq / r; // リング間隔 ≈ radius/frequency px → baseFrequency
  const lw = Math.max(1, w);
  const lh = Math.max(1, h);
  // 改定5: center パンは ±0.5·{w,h} に収まるので定数 pad で被覆（生成域一定・stitch 維持で boiling なし）。
  return turbulenceDisplace({
    scale: 2 * Math.max(0, amplitude),
    baseFrequencyX: bf,
    baseFrequencyY: bf,
    seed: 7,
    numOctaves: 1,
    type: "fractalNoise",
    w,
    h,
    offsetX: (clamp01(centerX) - 0.5) * lw,
    offsetY: (clamp01(centerY) - 0.5) * lh,
    smoothPx: fastSmoothPx(r / freq),
    regionPadX: 0.5 * lw + 2,
    regionPadY: 0.5 * lh + 2,
    antiAlias,
  });
}

/** mosaicGridSnapFilter の 1 タイル分ラスタ解像度（block×block・16..256 に clamp）。 */
export const MOSAIC_TILE_MAX_DIM = 256;
export const MOSAIC_TILE_MIN_DIM = 16;

/**
 * §27.5 改定6/7 — Mosaic Lite タイル 1 個分の block-center-snap 変位を RGBA バッファへ焼く。
 *
 * 旧実装（`<pattern>` 内で 2×`linearGradient` + `mix-blend-mode:screen` をブラウザに解決させる）
 * は compositor の per-draw コストが極端に重いことが実測で判明（§6.5 mosaic-lite-phase-a-bench-report.md、
 * `MainFrame.Draw` 208倍）。gradient の連続ランプを JS 側で事前計算し、`rippleDisplaceMap`/
 * `opticsCompensationDisplaceMap` と同じ「PNG に焼いて feImage で参照する」方式に統一する。
 * R = X 変位ランプ、G = Y 変位ランプ（どちらも tile 内で hi→lo の線形ランプ）、B は中立 128。
 */
function mosaicTileRgba(block: number, tile: number): Uint8Array {
  const hi = (1 - 0.5 / block) * 255;
  const lo = (0.5 / block) * 255;
  const rgba = new Uint8Array(tile * tile * 4);
  const rowR = new Uint8Array(tile);
  for (let tx = 0; tx < tile; tx++) {
    rowR[tx] = Math.round(hi + (lo - hi) * (tx / tile));
  }
  for (let ty = 0; ty < tile; ty++) {
    const g = Math.round(hi + (lo - hi) * (ty / tile));
    const rowOffset = ty * tile * 4;
    for (let tx = 0; tx < tile; tx++) {
      const o = rowOffset + tx * 4;
      rgba[o] = rowR[tx]!;
      rgba[o + 1] = g;
      rgba[o + 2] = 128;
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/**
 * §27.5 Mosaic Lite — block center snap displacement map（live 近似）。
 *
 * 改定7（2026-07-12）: displacement map の全域タイリングを **native `feTile` プリミティブ**で行う。
 * 改定6 では PNG タイルを `feImage`(ネスト SVG 文書内の `<pattern>`) で全域へ敷いていたが、
 * backdrop-filter 下では Chrome がこのネスト SVG 文書を**毎フレーム再ラスタライズ**しており、
 * それが `MainFrame.Draw` 残コスト（≈21ms/frame）の実体だった（実測: mosaic-lite-phase-a-bench-report.md §6.7）。
 * `feImage`(block×block の生 PNG 1 枚) → `feTile`(フィルタグラフ内で全域反復) に変えると
 * ネスト文書のパース/ラスタが消え、`MainFrame.Draw` はベースライン同等（≈0.6ms/frame・97%減）になる。
 */
export function mosaicGridSnapFilter(opts: {
  blockSize: number;
  w: number;
  h: number;
}): string {
  const block = Math.max(1, Math.round(opts.blockSize));
  if (block <= 1) return "";
  const w = Math.max(1, Math.round(opts.w));
  const h = Math.max(1, Math.round(opts.h));
  const tile = Math.min(MOSAIC_TILE_MAX_DIM, Math.max(MOSAIC_TILE_MIN_DIM, block));
  const tileUri = rgbaToPngDataUri(mosaicTileRgba(block, tile), tile, tile);
  // feImage は block×block の 1 タイルだけを原点に置き（`feTile` の反復単位になる）、
  // feTile がフィルタ領域 (0,0,w,h) 全域へ敷き詰める。ネスト SVG `<pattern>` は使わない。
  const primitives =
    `<feImage href="${tileUri}" x="0" y="0" width="${block}" height="${block}" preserveAspectRatio="none" result="mtile"/>` +
    `<feTile in="mtile" x="0" y="0" width="${w}" height="${h}" result="mmap"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="mmap" scale="${block}" xChannelSelector="R" yChannelSelector="G"/>`;
  return `${primitives}<!--mafter:mosaicLite-->`;
}

/** §27.5 Fast Turbulent Displace — feTurbulence 直結（octaves cap 2・G bias）。 */
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
    // 改定5: 既存の region/stitch/pan は維持し検証済み centroid を保全。map smoothing のみ追加。
    smoothPx: fastSmoothPx(size),
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
 * §27.3 Dither Dissolve — 8×8 Bayer pattern を敷いた layer 寸法マスク SVG。
 */
function ditherPatternMaskSvg(
  w: number,
  h: number,
  reveal: number,
  pattern: DitherPattern,
): string {
  const t = quantizeDitherReveal(reveal);
  const tile = pattern === "blueNoise" ? 64 : 8;
  const patternId = pattern === "blueNoise" ? "blueNoise" : "bayer";
  const cells: string[] = [];
  for (let y = 0; y < tile; y++) {
    for (let x = 0; x < tile; x++) {
      const on = ditherVisibleAt(pattern, x, y, t);
      cells.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${on ? "white" : "black"}"/>`);
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`,
    `<defs><pattern id="${patternId}" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse">`,
    cells.join(""),
    `</pattern></defs>`,
    `<rect width="100%" height="100%" fill="url(#${patternId})"/>`,
    `</svg>`,
  ].join("");
}

/** §27.3 Dither Dissolve — 8×8 Bayer pattern（ordered）。 */
export function bayerMaskSvg(w: number, h: number, reveal: number): string {
  return ditherPatternMaskSvg(w, h, reveal, "ordered");
}

/** §27.3 Dither Dissolve — 64×64 blue noise rank tile。 */
export function blueNoiseMaskSvg(w: number, h: number, reveal: number): string {
  return ditherPatternMaskSvg(w, h, reveal, "blueNoise");
}

/**
 * §27.3 Dither Dissolve — wipe と同型の SVG filter primitives（feTile 不使用）。
 * reveal は呼び出し側で ditherEffectiveReveal 済みを渡す。
 */
export function ditherDissolveMask(
  reveal: number,
  w: number,
  h: number,
  pattern: DitherPattern = "ordered",
): string {
  const q = quantizeDitherReveal(reveal);
  if (q >= 1) return "";
  if (q <= 0) return maskComposite(svgDataUri(allBlackMaskSvg(w, h)), 0, w, h);
  const p = normalizeDitherPattern(pattern);
  const maskSvg = p === "blueNoise" ? blueNoiseMaskSvg(w, h, q) : bayerMaskSvg(w, h, q);
  return maskComposite(svgDataUri(maskSvg), 0, w, h);
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

/** chromaSplit のオフセット（px）。INV-1 純関数。 */
export function chromaOffsetPx(amount: number, angleDeg: number): { dx: number; dy: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { dx: amount * Math.cos(rad), dy: amount * Math.sin(rad) };
}

/**
 * chromaSplit — RGB Split / Chromatic Aberration（§27.3）
 * 指定角度方向へ R/B チャンネルをオフセットして色収差風の効果を出す。
 * mode="rgb": R を +offset、B を -offset、G は固定（AE 標準）
 * mode="rb": R/B のみ動き、G は SourceGraphic のまま
 * @returns SVG primitives string
 */
export function chromaSplitFilter(
  amount: number, // px
  angleDeg: number, // deg
  mode: "rgb" | "rb",
): string {
  if (amount === 0) return "";

  const { dx, dy } = chromaOffsetPx(amount, angleDeg);

  const primitives: string[] = [];

  if (mode === "rgb") {
    // R/G/B を個別に抽出
    // R チャンネル抽出（G/B=0、アルファ=1）
    primitives.push(`<feComponentTransfer in="SourceGraphic" result="r">`);
    primitives.push(`<feFuncR type="linear" slope="1"/><feFuncG type="linear" slope="0"/><feFuncB type="linear" slope="0"/><feFuncA type="linear" slope="1"/>`);
    primitives.push(`</feComponentTransfer>`);

    // G チャンネル抽出（R/B=0、アルファ=1）
    primitives.push(`<feComponentTransfer in="SourceGraphic" result="g">`);
    primitives.push(`<feFuncR type="linear" slope="0"/><feFuncG type="linear" slope="1"/><feFuncB type="linear" slope="0"/><feFuncA type="linear" slope="1"/>`);
    primitives.push(`</feComponentTransfer>`);

    // B チャンネル抽出（R/G=0、アルファ=1）
    primitives.push(`<feComponentTransfer in="SourceGraphic" result="b">`);
    primitives.push(`<feFuncR type="linear" slope="0"/><feFuncG type="linear" slope="0"/><feFuncB type="linear" slope="1"/><feFuncA type="linear" slope="1"/>`);
    primitives.push(`</feComponentTransfer>`);

    // R を +offset
    primitives.push(`<feOffset in="r" dx="${dx}" dy="${dy}" result="rOff"/>`);

    // B を -offset
    primitives.push(`<feOffset in="b" dx="${-dx}" dy="${-dy}" result="bOff"/>`);

    // 加算合成（screen mode）で RGB チャンネルを再合成
    // R offset と G を screen で加算
    primitives.push(`<feBlend in="rOff" in2="g" mode="screen" result="rg"/>`);
    // RG と B offset を screen で加算
    primitives.push(`<feBlend in="rg" in2="bOff" mode="screen" result="rgb"/>`);

    // アルファを SourceGraphic から取る（透明レイヤー縁の色暴れ防止）
    primitives.push(`<feComposite in="rgb" in2="SourceGraphic" operator="in"/>`);
  } else {
    // mode === "rb": G は SourceGraphic から取り、R/B のみオフセット
    // R チャンネル抽出（アルファ透過）
    primitives.push(`<feComponentTransfer in="SourceGraphic" result="r">`);
    primitives.push(`<feFuncR type="linear" slope="1"/><feFuncG type="linear" slope="0"/><feFuncB type="linear" slope="0"/><feFuncA type="linear" slope="1"/>`);
    primitives.push(`</feComponentTransfer>`);

    // B チャンネル抽出（アルファ透過）
    primitives.push(`<feComponentTransfer in="SourceGraphic" result="b">`);
    primitives.push(`<feFuncR type="linear" slope="0"/><feFuncG type="linear" slope="0"/><feFuncB type="linear" slope="1"/><feFuncA type="linear" slope="1"/>`);
    primitives.push(`</feComponentTransfer>`);

    // オフセット
    primitives.push(`<feOffset in="r" dx="${dx}" dy="${dy}" result="rOff"/>`);
    primitives.push(`<feOffset in="b" dx="${-dx}" dy="${-dy}" result="bOff"/>`);

    // R offset と SourceGraphic (G 含む) を screen で加算
    primitives.push(`<feBlend in="rOff" in2="SourceGraphic" mode="screen" result="rg"/>`);
    // RG と B offset を screen で加算
    primitives.push(`<feBlend in="rg" in2="bOff" mode="screen" result="rgb"/>`);

    // アルファを SourceGraphic から取る（screen ブレンドのエッジ色暴れ防止）
    primitives.push(`<feComposite in="rgb" in2="SourceGraphic" operator="in"/>`);
  }

  return primitives.join("");
}

// ---------------------------------------------------------------------------
// gradientMap — 輝度 → グラデーション写像（§27.3 / acid-digi Ticket A-2）
// ---------------------------------------------------------------------------

export type GradientMapStop = { stop: number; r: number; g: number; b: number };

/** thermal / acid / cyber / chrome の stop 定義（値 0..1）。duotone は colorA/B から動的生成。 */
export const GRADIENT_MAP_PRESETS: Record<string, GradientMapStop[]> = {
  // サーモグラフィ: 黒 → 紫 → 赤 → 黄 → 白
  thermal: [
    { stop: 0, r: 0, g: 0, b: 0 },
    { stop: 0.25, r: 0.45, g: 0, b: 0.55 },
    { stop: 0.5, r: 1, g: 0.05, b: 0 },
    { stop: 0.75, r: 1, g: 0.9, b: 0 },
    { stop: 1, r: 1, g: 1, b: 1 },
  ],
  // Acid green
  acid: [
    { stop: 0, r: 0, g: 0, b: 0 },
    { stop: 0.3, r: 0.05, g: 0.35, b: 0 },
    { stop: 0.55, r: 0.15, g: 0.95, b: 0.1 },
    { stop: 0.8, r: 0.75, g: 1, b: 0.15 },
    { stop: 1, r: 0.95, g: 1, b: 0.7 },
  ],
  // Cyberpunk: 暗青 → マゼンタ → シアン → ホットピンク
  cyber: [
    { stop: 0, r: 0.02, g: 0, b: 0.12 },
    { stop: 0.35, r: 0.55, g: 0, b: 0.85 },
    { stop: 0.65, r: 0, g: 0.9, b: 1 },
    { stop: 1, r: 1, g: 0.15, b: 0.85 },
  ],
  // 金属クローム: 暗→明→暗→明の非単調
  chrome: [
    { stop: 0, r: 0.08, g: 0.08, b: 0.1 },
    { stop: 0.22, r: 0.88, g: 0.9, b: 0.95 },
    { stop: 0.48, r: 0.18, g: 0.2, b: 0.22 },
    { stop: 0.72, r: 0.96, g: 0.97, b: 1 },
    { stop: 1, r: 0.35, g: 0.37, b: 0.4 },
  ],
};

const GRADIENT_MAP_SAMPLE_COUNT = 17;

function lerpChannel(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** stop 配列上で t∈[0,1] を線形補間サンプル。 */
export function sampleGradientStops(
  stops: GradientMapStop[],
  t: number,
): { r: number; g: number; b: number } {
  if (stops.length === 0) return { r: 0, g: 0, b: 0 };
  if (stops.length === 1) return { r: stops[0]!.r, g: stops[0]!.g, b: stops[0]!.b };
  const u = clamp01(t);
  if (u <= stops[0]!.stop) return { r: stops[0]!.r, g: stops[0]!.g, b: stops[0]!.b };
  const last = stops[stops.length - 1]!;
  if (u >= last.stop) return { r: last.r, g: last.g, b: last.b };
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (u >= a.stop && u <= b.stop) {
      const span = b.stop - a.stop;
      const local = span <= 1e-12 ? 0 : (u - a.stop) / span;
      return {
        r: lerpChannel(a.r, b.r, local),
        g: lerpChannel(a.g, b.g, local),
        b: lerpChannel(a.b, b.b, local),
      };
    }
  }
  return { r: last.r, g: last.g, b: last.b };
}

/**
 * 輝度→RGB の feComponentTransfer table 値（各 17 点・スペース区切り）。
 * phaseDeg/360 分だけサンプル位置を巡回シフト。duotone のみ colorA→colorB。
 */
export function gradientMapTable(
  preset: string,
  phaseDeg: number,
  colorA: { r: number; g: number; b: number },
  colorB: { r: number; g: number; b: number },
): { r: string; g: string; b: string } {
  const stops: GradientMapStop[] =
    preset === "duotone"
      ? [
          { stop: 0, r: colorA.r, g: colorA.g, b: colorA.b },
          { stop: 1, r: colorB.r, g: colorB.g, b: colorB.b },
        ]
      : (GRADIENT_MAP_PRESETS[preset] ?? GRADIENT_MAP_PRESETS["thermal"]!);

  // 負の phase も正規化（mod 1）。phase=0 のときは端点 t=1 を保持（1%1→0 を避ける）。
  const phaseFrac = ((phaseDeg / 360) % 1 + 1) % 1;
  const n = GRADIENT_MAP_SAMPLE_COUNT;
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let i = 0; i < n; i++) {
    const base = i / (n - 1);
    // phase=0: base をそのまま（最終サンプル = 1.0 → 末尾 stop）。
    // phase>0: [0,1) へ wrap（s===1 → 0。hue cycle の巡回）。
    let sampleT: number;
    if (phaseFrac === 0) {
      sampleT = base;
    } else {
      const s = base + phaseFrac;
      sampleT = s >= 1 ? s - Math.floor(s) : s;
    }
    const c = sampleGradientStops(stops, sampleT);
    rs.push(c.r);
    gs.push(c.g);
    bs.push(c.b);
  }
  return {
    r: rs.join(" "),
    g: gs.join(" "),
    b: bs.join(" "),
  };
}
