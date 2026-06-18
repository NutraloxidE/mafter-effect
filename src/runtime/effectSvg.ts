/** §27 — SVG filter primitive 組み立て（純関数・INV-1）。 */

export function svgDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
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

/** phase/evolution (deg) → 決定論的 seed。 */
export function phaseToSeed(degrees: number): number {
  return Math.floor((((degrees % 360) + 360) % 360) * 11.377);
}

function maskComposite(maskUri: string, featherPx: number): string {
  const blur =
    featherPx > 0
      ? `<feGaussianBlur in="maskImg" stdDeviation="${featherPx}" result="maskBlur"/>`
      : "";
  const maskIn = featherPx > 0 ? "maskBlur" : "maskImg";
  return [
    `<feImage href="${maskUri}" result="maskImg" preserveAspectRatio="none"/>`,
    blur,
    `<feComposite in="SourceGraphic" in2="${maskIn}" operator="in"/>`,
  ].join("");
}

function allBlackMaskSvg(w: number, h: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="black"/></svg>`;
}

/** Linear wipe mask: completion 0..1, angle in degrees (0 = left→right reveal). */
export function linearWipeMask(
  completion: number,
  angleDeg: number,
  featherPx: number,
  w: number,
  h: number,
): string {
  if (completion <= 0) {
    return maskComposite(svgDataUri(allBlackMaskSvg(w, h)), 0);
  }
  if (completion >= 1) return "";

  const t = Math.min(1, Math.max(0, completion));
  const featherNorm = w > 0 ? Math.min(0.5, featherPx / w) : 0;
  const edge = t * 100;
  const softStart = Math.max(0, edge - featherNorm * 100);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`,
    `<defs>`,
    `<linearGradient id="g" x1="0" y1="0" x2="1" y2="0" gradientUnits="objectBoundingBox" gradientTransform="rotate(${angleDeg} 0.5 0.5)">`,
    `<stop offset="0%" stop-color="white"/>`,
    `<stop offset="${softStart}%" stop-color="white"/>`,
    `<stop offset="${edge}%" stop-color="black"/>`,
    `<stop offset="100%" stop-color="black"/>`,
    `</linearGradient>`,
    `</defs>`,
    `<rect width="100%" height="100%" fill="url(#g)"/>`,
    `</svg>`,
  ].join("");
  return maskComposite(svgDataUri(svg), featherPx);
}

/** Angular wipe: sector from startAngle, sweep = completion * 360°. */
export function angularWipeMask(
  completion: number,
  startAngleDeg: number,
  centerX: number,
  centerY: number,
  featherPx: number,
  w: number,
  h: number,
): string {
  if (completion <= 0) {
    return maskComposite(svgDataUri(allBlackMaskSvg(w, h)), 0);
  }
  if (completion >= 1) return "";

  const t = Math.min(1, Math.max(0, completion));
  const sweep = t * 360;
  const cxPx = centerX * w;
  const cyPx = centerY * h;
  const r = Math.hypot(w, h) * 1.5;
  const startRad = ((startAngleDeg - 90) * Math.PI) / 180;
  const endRad = startRad + (sweep * Math.PI) / 180;
  const x1 = cxPx + r * Math.cos(startRad);
  const y1 = cyPx + r * Math.sin(startRad);
  const x2 = cxPx + r * Math.cos(endRad);
  const y2 = cyPx + r * Math.sin(endRad);
  const largeArc = sweep > 180 ? 1 : 0;
  const path = `M ${cxPx} ${cyPx} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`,
    `<rect width="100%" height="100%" fill="black"/>`,
    `<path d="${path}" fill="white"/>`,
    `</svg>`,
  ].join("");
  return maskComposite(svgDataUri(svg), featherPx);
}

/** Wave / ripple 用 baseFrequency（wavelength px → cycles per user unit）。 */
export function wavelengthToFrequency(wavelengthPx: number): number {
  return 1 / Math.max(1, wavelengthPx);
}

/** Turbulent Displace: larger size → lower frequency。 */
export function sizeToFrequency(size: number): number {
  return Math.max(0.001, 10 / Math.max(1, size));
}
