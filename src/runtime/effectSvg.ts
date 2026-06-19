/** §27 — SVG filter primitive 組み立て（純関数・INV-1）。 */

import { seededRandom } from "./exprHelpers";

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

export function turbulenceDisplace(opts: {
  scale: number;
  baseFrequencyX: number;
  baseFrequencyY: number;
  seed: number;
  numOctaves?: number;
  type?: "fractalNoise" | "turbulence";
}): string {
  const {
    scale,
    baseFrequencyX,
    baseFrequencyY,
    seed,
    numOctaves = 3,
    type = "turbulence",
  } = opts;
  const bx = Math.max(0.0001, baseFrequencyX);
  const by = Math.max(0.0001, baseFrequencyY);
  const s = Math.max(0, Math.floor(seed)) % 4096;
  return [
    `<feTurbulence type="${type}" baseFrequency="${bx} ${by}" numOctaves="${numOctaves}" seed="${s}" result="noise"/>`,
    `<feDisplacementMap in="SourceGraphic" in2="noise" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>`,
  ].join("");
}

/** displacement map (data URI) を使って SourceGraphic を変位させる。 */
export function displaceWithMap(uri: string, scale: number, w: number, h: number): string {
  return [
    feImageLayer(uri, w, h, "dmap"),
    `<feDisplacementMap in="SourceGraphic" in2="dmap" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>`,
  ].join("");
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
): { uri: string; scale: number } {
  const lambda = Math.max(1, wavelength);
  const phase = (phaseDeg * Math.PI) / 180;
  const horizontal = direction !== "vertical";
  const span = Math.max(1, horizontal ? w : h);
  const cycles = span / lambda;
  // 1 周期あたり ~8 サンプル。極端な高周波は上限でエイリアスを許容（AE も同様）。
  const samples = Math.min(512, Math.max(2, Math.round(cycles * 8) + 1));
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

/**
 * §27.3 Ripple — 同心円状 displacement map（中心から外へ減衰する波紋）。
 *
 * radialGradient（userSpaceOnUse・円形）で半径方向に sin/cos を載せ、変位ベクトルを
 * 半径に応じて回転させることで「水紋」状の見た目にする。完全な放射方向ではない近似だが
 * （単一 map では半径方向ベクトルを厳密に表現できない）、ノイズより遥かに波紋らしい。
 * 振幅は (1−o) で外側へ減衰し、radius 外（offset 1 の pad）は中立で無変位。
 * center は radialGradient の cx/cy に直結（AE 同様に中心が効く）。
 */
export function rippleDisplaceMapSvg(
  radius: number,
  amplitude: number,
  frequency: number,
  centerX: number,
  centerY: number,
  w: number,
  h: number,
): { uri: string; scale: number } {
  const cx = clamp01(centerX) * w;
  const cy = clamp01(centerY) * h;
  const r = Math.max(1, radius);
  const cycles = Math.max(0.1, frequency);
  const samples = Math.min(512, Math.max(16, Math.round(cycles * 16)));
  const stops: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const o = i / samples;
    const env = 1 - o; // 外側へ減衰
    const ph = 2 * Math.PI * cycles * o;
    const rC = Math.round(clamp01(0.5 + 0.5 * env * Math.sin(ph)) * 255);
    const gC = Math.round(clamp01(0.5 + 0.5 * env * Math.cos(ph)) * 255);
    stops.push(`<stop offset="${(o * 100).toFixed(2)}%" stop-color="rgb(${rC},${gC},128)"/>`);
  }
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`,
    `<defs><radialGradient id="r" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}">`,
    stops.join(""),
    `</radialGradient></defs>`,
    `<rect width="100%" height="100%" fill="url(#r)"/>`,
    `</svg>`,
  ].join("");
  return { uri: svgDataUri(svg), scale: 2 * amplitude };
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
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`,
    `<defs>`,
    `<linearGradient id="g" x1="0" y1="0" x2="1" y2="0" gradientUnits="objectBoundingBox" gradientTransform="rotate(${angleDeg} 0.5 0.5)">`,
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

/** Turbulent Displace: larger size → lower frequency。 */
export function sizeToFrequency(size: number): number {
  return Math.max(0.001, 10 / Math.max(1, size));
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
