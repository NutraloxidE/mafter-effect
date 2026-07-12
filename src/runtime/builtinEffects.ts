import type { RGBA } from "../core/schema";
import type { EffectDef, EffectRenderCtx, RasterBuffer } from "./plugin";
import { globalPluginRegistry } from "./pluginRegistry";
import {
  chromaSplitFilter,
  displaceWithMap,
  angularWipeMask,
  ditherDissolveMask,
  ditherEffectiveReveal,
  evolutionToOffsetPx,
  gradientMapTable,
  lightPixelSortFilter,
  linearWipeMask,
  opticsCompensationDisplaceMap,
  phaseToSeed,
  rippleDisplaceMap,
  sizeToFrequency,
  turbulenceDisplace,
  waveDisplaceMapSvg,
} from "./effectSvg";
import {
  blockAverage,
  isPixelSortIdentity,
  processPixelSort,
} from "./pixelSort";
import { parsePixelSortParams } from "./pixelSortParams";

import { registerFastEffects } from "./fastEffects";

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/** §27.4 軽量化ノブ。未設定は 1（従来挙動・後方互換）。0.1..1 にクランプ。 */
function quality(props: Record<string, unknown>): number {
  return Math.min(1, Math.max(0.1, num(props["quality"], 1)));
}

function rgba(v: unknown, fallback: RGBA): RGBA {
  if (typeof v === "object" && v !== null && "r" in v && "g" in v && "b" in v) {
    const o = v as RGBA;
    return {
      r: num(o.r, fallback.r),
      g: num(o.g, fallback.g),
      b: num(o.b, fallback.b),
      a: num(o.a, fallback.a),
    };
  }
  return fallback;
}

const BLUR_EFFECT_DEF: EffectDef = {
  type: "blur",
  label: "Blur",
  category: "ぼかし",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "blurriness", label: "Blurriness", kind: "scalar", default: 0, animatable: true, min: 0, max: 500, step: 0.1 },
  ],
  apply(props) {
    const blurriness = Math.max(0, num(props["blurriness"], 0));
    if (blurriness === 0) return null;
    return { kind: "css", fn: `blur(${blurriness}px)` };
  },
};

const TINT_EFFECT_DEF: EffectDef = {
  type: "tint",
  label: "Tint",
  category: "カラー補正",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "mapBlack", label: "Map Black To", kind: "color", default: { r: 0, g: 0, b: 0, a: 1 }, animatable: true },
    { key: "mapWhite", label: "Map White To", kind: "color", default: { r: 1, g: 1, b: 1, a: 1 }, animatable: true },
    { key: "amount", label: "Amount to Tint", kind: "scalar", default: 1, animatable: true, min: 0, max: 1, step: 0.01 },
  ],
  apply(props, _ctx: EffectRenderCtx) {
    const amount = Math.min(1, Math.max(0, num(props["amount"], 1)));
    if (amount === 0) return null;
    const black = rgba(props["mapBlack"], { r: 0, g: 0, b: 0, a: 1 });
    const white = rgba(props["mapWhite"], { r: 1, g: 1, b: 1, a: 1 });
    const sr = white.r - black.r;
    const sg = white.g - black.g;
    const sb = white.b - black.b;
    const primitives = [
      `<feColorMatrix in="SourceGraphic" type="saturate" values="0" result="gray"/>`,
      `<feComponentTransfer in="gray" result="tinted">`,
      `<feFuncR type="linear" slope="${sr}" intercept="${black.r}"/>`,
      `<feFuncG type="linear" slope="${sg}" intercept="${black.g}"/>`,
      `<feFuncB type="linear" slope="${sb}" intercept="${black.b}"/>`,
      `<feFuncA type="linear" slope="1" intercept="0"/>`,
      `</feComponentTransfer>`,
      `<feComponentTransfer in="tinted" result="tintedAlpha">`,
      `<feFuncR type="linear" slope="1" intercept="0"/>`,
      `<feFuncG type="linear" slope="1" intercept="0"/>`,
      `<feFuncB type="linear" slope="1" intercept="0"/>`,
      `<feFuncA type="linear" slope="${amount}" intercept="0"/>`,
      `</feComponentTransfer>`,
      `<feMerge>`,
      `<feMergeNode in="SourceGraphic"/>`,
      `<feMergeNode in="tintedAlpha"/>`,
      `</feMerge>`,
    ].join("");
    return { kind: "svg", primitives };
  },
};

/** Posterize discrete tableValues: levels equally spaced values in [0,1]. L<2 → clamp to 2. */
export function posterizeTable(levels: number): string {
  const L = Math.max(2, Math.round(levels));
  const values: number[] = [];
  for (let i = 0; i < L; i++) {
    values.push(i / (L - 1));
  }
  return values.join(" ");
}

const POSTERIZE_EFFECT_DEF: EffectDef = {
  type: "posterize",
  label: "Posterize",
  category: "カラー補正",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "levels", label: "Levels", kind: "scalar", default: 6, animatable: true, min: 2, max: 32, step: 1 },
  ],
  apply(props) {
    const levels = Math.max(2, Math.round(num(props["levels"], 6)));
    const t = posterizeTable(levels);
    const primitives = [
      `<feComponentTransfer in="SourceGraphic">`,
      `<feFuncR type="discrete" tableValues="${t}"/>`,
      `<feFuncG type="discrete" tableValues="${t}"/>`,
      `<feFuncB type="discrete" tableValues="${t}"/>`,
      `</feComponentTransfer>`,
    ].join("");
    return { kind: "svg", primitives };
  },
};

const CHROMASPLIT_EFFECT_DEF: EffectDef = {
  type: "chromaSplit",
  label: "Chroma Split",
  category: "スタイライズ",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "amount", label: "Amount", kind: "scalar", default: 4, animatable: true, min: 0, max: 100, step: 0.1 },
    { key: "angle", label: "Angle", kind: "scalar", default: 0, animatable: true, step: 1 },
    { key: "mode", label: "Mode", kind: "enum", default: "rgb", animatable: false, options: ["rgb", "rb"] },
  ],
  apply(props, _ctx: EffectRenderCtx) {
    const amount = Math.max(0, num(props["amount"], 4));
    if (amount === 0) return null;
    const angle = num(props["angle"], 0);
    const mode = (props["mode"] as string) ?? "rgb";
    const primitives = chromaSplitFilter(amount, angle, mode as "rgb" | "rb");
    return { kind: "svg", primitives };
  },
};

const GRADIENT_MAP_EFFECT_DEF: EffectDef = {
  type: "gradientMap",
  label: "Gradient Map",
  category: "カラー補正",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    {
      key: "preset",
      label: "Preset",
      kind: "enum",
      default: "thermal",
      animatable: false,
      options: ["thermal", "acid", "cyber", "chrome", "duotone"],
    },
    { key: "colorA", label: "Color A", kind: "color", default: { r: 0, g: 0, b: 0, a: 1 }, animatable: true },
    { key: "colorB", label: "Color B", kind: "color", default: { r: 1, g: 1, b: 1, a: 1 }, animatable: true },
    { key: "phase", label: "Phase", kind: "scalar", default: 0, animatable: true, min: 0, max: 360, step: 1 },
    { key: "amount", label: "Amount", kind: "scalar", default: 1, animatable: true, min: 0, max: 1, step: 0.01 },
  ],
  apply(props, _ctx: EffectRenderCtx) {
    const amount = Math.min(1, Math.max(0, num(props["amount"], 1)));
    if (amount === 0) return null;
    const preset = str(props["preset"], "thermal");
    const phase = num(props["phase"], 0);
    const colorA = rgba(props["colorA"], { r: 0, g: 0, b: 0, a: 1 });
    const colorB = rgba(props["colorB"], { r: 1, g: 1, b: 1, a: 1 });
    const { r, g, b } = gradientMapTable(preset, phase, colorA, colorB);
    const k2 = amount;
    const k3 = 1 - amount;
    const primitives = [
      `<feColorMatrix in="SourceGraphic" type="saturate" values="0" result="gray"/>`,
      `<feComponentTransfer in="gray" result="mapped">`,
      `<feFuncR type="table" tableValues="${r}"/>`,
      `<feFuncG type="table" tableValues="${g}"/>`,
      `<feFuncB type="table" tableValues="${b}"/>`,
      `</feComponentTransfer>`,
      `<feComposite in="mapped" in2="SourceGraphic" operator="arithmetic" k1="0" k2="${k2}" k3="${k3}" k4="0"/>`,
    ].join("");
    return { kind: "svg", primitives };
  },
};

const NOISE_GRAIN_EFFECT_DEF: EffectDef = {
  type: "noiseGrain",
  label: "Noise Grain",
  category: "スタイライズ",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "amount", label: "Amount", kind: "scalar", default: 0.15, animatable: true, min: 0, max: 1, step: 0.01 },
    { key: "size", label: "Size", kind: "scalar", default: 1, animatable: true, min: 0.5, max: 8, step: 0.1 },
    { key: "animated", label: "Animated", kind: "bool", default: false, animatable: false },
    { key: "monochrome", label: "Monochrome", kind: "bool", default: true, animatable: false },
    { key: "seed", label: "Seed", kind: "scalar", default: 0, animatable: false, min: 0, max: 9999, step: 1 },
  ],
  apply(props, ctx: EffectRenderCtx) {
    const amount = Math.min(1, Math.max(0, num(props["amount"], 0.15)));
    if (amount === 0) return null;
    const size = Math.min(8, Math.max(0.5, num(props["size"], 1)));
    const animated = bool(props["animated"], false);
    const monochrome = bool(props["monochrome"], true);
    const baseSeed = Math.max(0, Math.floor(num(props["seed"], 0))) % 10000;
    const seed = animated ? (baseSeed + Math.floor(ctx.frame)) % 65536 : baseSeed;
    const bf = 1 / Math.max(0.5, size);
    const primitives = [
      `<feTurbulence type="fractalNoise" baseFrequency="${bf}" numOctaves="1" seed="${seed}" stitchTiles="stitch" result="noise"/>`,
      monochrome
        ? `<feColorMatrix in="noise" type="matrix" values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 0 1" result="mono"/>`
        : `<feColorMatrix in="noise" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1" result="mono"/>`,
      `<feComposite in="mono" in2="SourceGraphic" operator="arithmetic" k1="0" k2="${amount}" k3="1" k4="${-0.5 * amount}" result="grained"/>`,
      `<feComposite in="grained" in2="SourceGraphic" operator="in"/>`,
    ].join("");
    return { kind: "svg", primitives };
  },
};

/** Threshold linear transfer: t→0, 1→1 output; clamps to 0 below t. t>=1 guarded by epsilon. */
export function thresholdTransfer(t: number): { slope: number; intercept: number } {
  const clamped = Math.min(1 - 1e-6, Math.max(0, t));
  const slope = 1 / (1 - clamped);
  const intercept = -clamped / (1 - clamped);
  return { slope, intercept };
}

const HYPER_GLOW_EFFECT_DEF: EffectDef = {
  type: "hyperGlow",
  label: "Hyper Glow",
  category: "スタイライズ",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "threshold", label: "Threshold", kind: "scalar", default: 0.7, animatable: true, min: 0, max: 1, step: 0.01 },
    { key: "radius", label: "Radius", kind: "scalar", default: 24, animatable: true, min: 0, max: 200, step: 0.1 },
    { key: "intensity", label: "Intensity", kind: "scalar", default: 1.5, animatable: true, min: 0, max: 8, step: 0.01 },
    { key: "tint", label: "Tint", kind: "color", default: { r: 1, g: 1, b: 1, a: 1 }, animatable: true },
    { key: "quality", label: "Quality", kind: "scalar", default: 1, animatable: true, min: 0.1, max: 1, step: 0.05 },
  ],
  apply(props) {
    const radius = Math.max(0, num(props["radius"], 24));
    const intensity = Math.max(0, num(props["intensity"], 1.5));
    if (radius === 0 || intensity === 0) return null;
    const threshold = Math.min(1, Math.max(0, num(props["threshold"], 0.7)));
    const { slope, intercept } = thresholdTransfer(threshold);
    const stdDeviation = radius * quality(props);
    const tint = rgba(props["tint"], { r: 1, g: 1, b: 1, a: 1 });
    const primitives = [
      `<feComponentTransfer in="SourceGraphic" result="bright">`,
      `<feFuncR type="linear" slope="${slope}" intercept="${intercept}"/>`,
      `<feFuncG type="linear" slope="${slope}" intercept="${intercept}"/>`,
      `<feFuncB type="linear" slope="${slope}" intercept="${intercept}"/>`,
      `</feComponentTransfer>`,
      `<feGaussianBlur in="bright" stdDeviation="${stdDeviation}" result="blur"/>`,
      `<feComponentTransfer in="blur" result="glow">`,
      `<feFuncR type="linear" slope="${intensity}"/>`,
      `<feFuncG type="linear" slope="${intensity}"/>`,
      `<feFuncB type="linear" slope="${intensity}"/>`,
      `</feComponentTransfer>`,
      tint.r === 1 && tint.g === 1 && tint.b === 1
        ? ``
        : `<feColorMatrix in="glow" type="matrix" values="${tint.r} 0 0 0 0  0 ${tint.g} 0 0 0  0 0 ${tint.b} 0 0  0 0 0 1 0" result="glow"/>`,
      `<feBlend in="SourceGraphic" in2="glow" mode="screen"/>`,
    ].join("");
    return { kind: "svg", primitives };
  },
};

const WAVE_EFFECT_DEF: EffectDef = {
  type: "wave",
  label: "Wave",
  category: "ディストーション",
  previewBakeRequired: false,
  executionPath: "raster",
  params: [
    { key: "amplitude", label: "Amplitude", kind: "scalar", default: 20, animatable: true, min: 0, max: 500, step: 0.1 },
    { key: "wavelength", label: "Wavelength", kind: "scalar", default: 50, animatable: true, min: 1, max: 500, step: 0.1 },
    { key: "direction", label: "Direction", kind: "enum", default: "horizontal", animatable: false, options: ["horizontal", "vertical"] },
    { key: "phase", label: "Phase", kind: "scalar", default: 0, animatable: true, min: 0, max: 360, step: 1 },
    { key: "quality", label: "Quality", kind: "scalar", default: 1, animatable: true, min: 0.1, max: 1, step: 0.05 },
  ],
  apply(props, ctx: EffectRenderCtx) {
    const amplitude = Math.max(0, num(props["amplitude"], 0));
    if (amplitude === 0) return null;
    const wavelength = Math.max(1, num(props["wavelength"], 50));
    const direction = str(props["direction"], "horizontal");
    const phase = num(props["phase"], 0);
    const w = Math.max(1, ctx.width);
    const h = Math.max(1, ctx.height);
    const { uri, scale } = waveDisplaceMapSvg(amplitude, wavelength, direction, phase, w, h, quality(props));
    return { kind: "svg", primitives: displaceWithMap(uri, scale, w, h) };
  },
};

const TURBULENT_DISPLACE_EFFECT_DEF: EffectDef = {
  type: "turbulentDisplace",
  label: "Turbulent Displace",
  category: "ディストーション",
  previewBakeRequired: false,
  executionPath: "raster",
  params: [
    { key: "amount", label: "Amount", kind: "scalar", default: 50, animatable: true, min: 0, max: 500, step: 0.1 },
    { key: "size", label: "Size", kind: "scalar", default: 100, animatable: true, min: 1, max: 2000, step: 0.1 },
    { key: "complexity", label: "Complexity", kind: "scalar", default: 2, animatable: true, min: 1, max: 6, step: 1 },
    { key: "evolution", label: "Evolution", kind: "scalar", default: 0, animatable: true, step: 1 },
    { key: "offsetX", label: "Offset X", kind: "scalar", default: 0, animatable: true, step: 1 },
    { key: "offsetY", label: "Offset Y", kind: "scalar", default: 0, animatable: true, step: 1 },
    { key: "randomSeed", label: "Random Seed", kind: "scalar", default: 0, animatable: false, min: 0, max: 9999, step: 1 },
    { key: "quality", label: "Quality", kind: "scalar", default: 1, animatable: true, min: 0.1, max: 1, step: 0.05 },
  ],
  apply(props, ctx: EffectRenderCtx) {
    const amount = Math.max(0, num(props["amount"], 0));
    if (amount === 0) return null;
    const size = Math.max(1, num(props["size"], 100));
    const complexity = Math.min(6, Math.max(1, Math.round(num(props["complexity"], 2))));
    const evolution = num(props["evolution"], 0);
    const offsetX = num(props["offsetX"], 0);
    const offsetY = num(props["offsetY"], 0);
    const randomSeed = Math.max(0, Math.floor(num(props["randomSeed"], 0))) % 4096;
    const w = Math.max(1, ctx.width);
    const h = Math.max(1, ctx.height);
    const freq = sizeToFrequency(size);
    // §27.4 軽量化: octave が feTurbulence の支配コスト。quality で削減（粗化）。
    const octaves = Math.max(1, Math.round(complexity * quality(props)));
    const { dx: evoDx, dy: evoDy } = evolutionToOffsetPx(evolution, size);
    const primitives = turbulenceDisplace({
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
    });
    return { kind: "svg", primitives };
  },
};

const RIPPLE_EFFECT_DEF: EffectDef = {
  type: "ripple",
  label: "Ripple",
  category: "ディストーション",
  previewBakeRequired: false,
  executionPath: "raster",
  params: [
    { key: "radius", label: "Radius", kind: "scalar", default: 100, animatable: true, min: 0, max: 1000, step: 0.1 },
    { key: "amplitude", label: "Amplitude", kind: "scalar", default: 10, animatable: true, min: 0, max: 200, step: 0.1 },
    { key: "frequency", label: "Frequency", kind: "scalar", default: 5, animatable: true, min: 0.1, max: 50, step: 0.1 },
    { key: "centerX", label: "Center X", kind: "scalar", default: 0.5, animatable: true, min: 0, max: 1, step: 0.01 },
    { key: "centerY", label: "Center Y", kind: "scalar", default: 0.5, animatable: true, min: 0, max: 1, step: 0.01 },
    { key: "quality", label: "Quality", kind: "scalar", default: 1, animatable: true, min: 0.1, max: 1, step: 0.05 },
  ],
  apply(props, ctx: EffectRenderCtx) {
    const amplitude = Math.max(0, num(props["amplitude"], 0));
    if (amplitude === 0) return null;
    const radius = Math.max(1, num(props["radius"], 100));
    const frequency = Math.max(0.1, num(props["frequency"], 5));
    const centerX = Math.min(1, Math.max(0, num(props["centerX"], 0.5)));
    const centerY = Math.min(1, Math.max(0, num(props["centerY"], 0.5)));
    const w = Math.max(1, ctx.width);
    const h = Math.max(1, ctx.height);
    const { uri, scale } = rippleDisplaceMap(radius, amplitude, frequency, centerX, centerY, w, h, 0, quality(props));
    return { kind: "svg", primitives: displaceWithMap(uri, scale, w, h) };
  },
};

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

const OPTICS_COMPENSATION_EFFECT_DEF: EffectDef = {
  type: "opticsCompensation",
  label: "Optics Compensation",
  category: "ディストーション",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "fieldOfView", label: "Field Of View", kind: "scalar", default: 50, animatable: true, min: 0, max: 170, step: 0.1 },
    { key: "reverse", label: "Reverse Lens Distortion", kind: "bool", default: false, animatable: false },
    { key: "centerX", label: "Center X", kind: "scalar", default: 0.5, animatable: true, min: 0, max: 1, step: 0.01 },
    { key: "centerY", label: "Center Y", kind: "scalar", default: 0.5, animatable: true, min: 0, max: 1, step: 0.01 },
    { key: "quality", label: "Quality", kind: "scalar", default: 1, animatable: true, min: 0.1, max: 1, step: 0.05 },
  ],
  apply(props, ctx: EffectRenderCtx) {
    const fieldOfView = Math.max(0, num(props["fieldOfView"], 0));
    if (fieldOfView === 0) return null;
    const w = Math.max(1, ctx.width);
    const h = Math.max(1, ctx.height);
    const reverse = bool(props["reverse"], false);
    const centerX = Math.min(1, Math.max(0, num(props["centerX"], 0.5)));
    const centerY = Math.min(1, Math.max(0, num(props["centerY"], 0.5)));
    const { uri, scale } = opticsCompensationDisplaceMap(
      fieldOfView,
      reverse,
      centerX,
      centerY,
      w,
      h,
      quality(props),
    );
    if (scale === 0) return null;
    return { kind: "svg", primitives: displaceWithMap(uri, scale, w, h) };
  },
};

const LINEAR_WIPE_EFFECT_DEF: EffectDef = {
  type: "linearWipe",
  label: "Linear Wipe",
  category: "ワイプ",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "completion", label: "Transition Completion", kind: "scalar", default: 0, animatable: true, min: 0, max: 1, step: 0.01 },
    { key: "angle", label: "Wipe Angle", kind: "scalar", default: 0, animatable: true, step: 1 },
    { key: "feather", label: "Feather", kind: "scalar", default: 0, animatable: true, min: 0, max: 200, step: 0.1 },
  ],
  apply(props, ctx: EffectRenderCtx) {
    const completion = num(props["completion"], 0);
    if (completion <= 0) return null;
    const w = Math.max(1, ctx.width);
    const h = Math.max(1, ctx.height);
    const angle = num(props["angle"], 0);
    const feather = Math.max(0, num(props["feather"], 0));
    const primitives = linearWipeMask(completion, angle, feather, w, h);
    if (!primitives) return null;
    return { kind: "svg", primitives };
  },
};

const ANGULAR_WIPE_EFFECT_DEF: EffectDef = {
  type: "angularWipe",
  label: "Angular Wipe",
  category: "ワイプ",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "completion", label: "Transition Completion", kind: "scalar", default: 0, animatable: true, min: 0, max: 1, step: 0.01 },
    { key: "startAngle", label: "Start Angle", kind: "scalar", default: 0, animatable: true, step: 1 },
    { key: "centerX", label: "Center X", kind: "scalar", default: 0.5, animatable: true, min: 0, max: 1, step: 0.01 },
    { key: "centerY", label: "Center Y", kind: "scalar", default: 0.5, animatable: true, min: 0, max: 1, step: 0.01 },
    { key: "feather", label: "Feather", kind: "scalar", default: 0, animatable: true, min: 0, max: 200, step: 0.1 },
  ],
  apply(props, ctx: EffectRenderCtx) {
    // AE 準拠: completion 0 = 恒等（表示）、1 = 完全 wipe（非表示）。
    const completion = num(props["completion"], 0);
    if (completion <= 0) return null;
    const w = Math.max(1, ctx.width);
    const h = Math.max(1, ctx.height);
    const startAngle = num(props["startAngle"], 0);
    const centerX = Math.min(1, Math.max(0, num(props["centerX"], 0.5)));
    const centerY = Math.min(1, Math.max(0, num(props["centerY"], 0.5)));
    const feather = Math.max(0, num(props["feather"], 0));
    const primitives = angularWipeMask(completion, startAngle, centerX, centerY, feather, w, h);
    if (!primitives) return null;
    return { kind: "svg", primitives };
  },
};

const DITHER_DISSOLVE_EFFECT_DEF: EffectDef = {
  type: "ditherDissolve",
  label: "Dither Dissolve",
  category: "ワイプ",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "completion", label: "Transition Completion", kind: "scalar", default: 0, animatable: true, min: 0, max: 1, step: 0.01 },
    {
      key: "pattern",
      label: "Pattern",
      kind: "enum",
      default: "ordered",
      animatable: false,
      options: ["ordered", "blueNoise"],
    },
  ],
  apply(props, ctx: EffectRenderCtx) {
    const reveal = ditherEffectiveReveal(ctx.layerOpacity ?? 1, num(props["completion"], 0));
    if (reveal >= 1) return null;
    const w = Math.max(1, ctx.width);
    const h = Math.max(1, ctx.height);
    const pattern = props["pattern"] === "blueNoise" ? "blueNoise" : "ordered";
    const primitives = ditherDissolveMask(reveal, w, h, pattern);
    if (!primitives) return null;
    return { kind: "svg", primitives };
  },
};

const PIXEL_SORTER_EFFECT_DEF: EffectDef = {
  type: "pixelSorter",
  label: "Pixel Sorter (WIP)",
  category: "スタイライズ",
  previewBakeRequired: true,
  executionPath: "raster",
  params: [
    { key: "sortingMode", label: "Sorting Mode", kind: "enum", default: "simple", animatable: false, options: ["simple", "highlights", "shadows", "random"] },
    { key: "thresholdLow", label: "Threshold Low", kind: "scalar", default: 0.25, animatable: true, min: 0, max: 1, step: 0.01 },
    { key: "thresholdHigh", label: "Threshold High", kind: "scalar", default: 0.75, animatable: true, min: 0, max: 1, step: 0.01 },
    { key: "angle", label: "Angle", kind: "scalar", default: 0, animatable: true, step: 1 },
    { key: "length", label: "Length", kind: "scalar", default: 256, animatable: true, min: 0, max: 4096, step: 1 },
    { key: "offset", label: "Offset", kind: "scalar", default: 0, animatable: true, min: 0, max: 4096, step: 1 },
    { key: "feather", label: "Feather", kind: "scalar", default: 0, animatable: true, min: 0, max: 200, step: 0.1 },
    { key: "sortBlocks", label: "Sort Blocks", kind: "scalar", default: 1, animatable: true, min: 1, max: 64, step: 1 },
  ],
  apply(props) {
    if (isPixelSortIdentity(parsePixelSortParams(props))) return null;
    return { kind: "raster" };
  },
  processPixels(input: RasterBuffer, props, ctx: EffectRenderCtx) {
    return processPixelSort(input, parsePixelSortParams(props), phaseToSeed(ctx.frame));
  },
};

const MOSAIC_EFFECT_DEF: EffectDef = {
  type: "mosaic",
  label: "Mosaic",
  category: "スタイライズ",
  previewBakeRequired: true,
  executionPath: "raster",
  params: [
    { key: "blockSize", label: "Block Size", kind: "scalar", default: 16, animatable: true, min: 1, max: 512, step: 1 },
  ],
  apply(props) {
    const blockSize = Math.max(1, Math.round(num(props["blockSize"], 16)));
    if (blockSize <= 1) return null;
    return { kind: "raster" };
  },
  processPixels(input: RasterBuffer, props) {
    const blockSize = Math.max(1, Math.round(num(props["blockSize"], 16)));
    return blockAverage(input, blockSize);
  },
};

const PIXEL_SORT_LITE_EFFECT_DEF: EffectDef = {
  type: "pixelSortLite",
  label: "Light Pixel Sort (WIP)",
  category: "スタイライズ",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "angle", label: "Angle", kind: "scalar", default: 90, animatable: true, step: 1 },
    { key: "threshold", label: "Threshold", kind: "scalar", default: 0.5, animatable: true, min: 0, max: 1, step: 0.01 },
    { key: "streakLength", label: "Streak Length", kind: "scalar", default: 64, animatable: true, min: 0, max: 512, step: 1 },
    { key: "stripWidth", label: "Strip Width", kind: "scalar", default: 8, animatable: true, min: 1, max: 64, step: 1 },
    { key: "intensity", label: "Intensity", kind: "scalar", default: 1, animatable: true, min: 0, max: 1, step: 0.01 },
    { key: "phase", label: "Phase", kind: "scalar", default: 0, animatable: true, step: 1 },
  ],
  apply(props, ctx: EffectRenderCtx) {
    const streakLength = Math.max(0, Math.round(num(props["streakLength"], 64)));
    const intensity = Math.min(1, Math.max(0, num(props["intensity"], 1)));
    if (streakLength === 0 || intensity === 0) return null;
    const w = Math.max(1, ctx.width);
    const h = Math.max(1, ctx.height);
    const primitives = lightPixelSortFilter(
      num(props["angle"], 90),
      Math.min(1, Math.max(0, num(props["threshold"], 0.5))),
      streakLength,
      Math.max(1, Math.min(64, Math.round(num(props["stripWidth"], 8)))),
      intensity,
      num(props["phase"], 0),
      w,
      h,
    );
    if (!primitives) return null;
    return { kind: "svg", primitives };
  },
};

export function registerBuiltinEffects(): void {
  globalPluginRegistry.registerEffect(BLUR_EFFECT_DEF);
  globalPluginRegistry.registerEffect(TINT_EFFECT_DEF);
  globalPluginRegistry.registerEffect(CHROMASPLIT_EFFECT_DEF);
  globalPluginRegistry.registerEffect(GRADIENT_MAP_EFFECT_DEF);
  globalPluginRegistry.registerEffect(POSTERIZE_EFFECT_DEF);
  globalPluginRegistry.registerEffect(NOISE_GRAIN_EFFECT_DEF);
  globalPluginRegistry.registerEffect(HYPER_GLOW_EFFECT_DEF);
  globalPluginRegistry.registerEffect(WAVE_EFFECT_DEF);
  globalPluginRegistry.registerEffect(TURBULENT_DISPLACE_EFFECT_DEF);
  globalPluginRegistry.registerEffect(RIPPLE_EFFECT_DEF);
  globalPluginRegistry.registerEffect(OPTICS_COMPENSATION_EFFECT_DEF);
  globalPluginRegistry.registerEffect(LINEAR_WIPE_EFFECT_DEF);
  globalPluginRegistry.registerEffect(ANGULAR_WIPE_EFFECT_DEF);
  globalPluginRegistry.registerEffect(DITHER_DISSOLVE_EFFECT_DEF);
  globalPluginRegistry.registerEffect(PIXEL_SORTER_EFFECT_DEF);
  globalPluginRegistry.registerEffect(MOSAIC_EFFECT_DEF);
  globalPluginRegistry.registerEffect(PIXEL_SORT_LITE_EFFECT_DEF);
  registerFastEffects();
}

export {
  BLUR_EFFECT_DEF,
  TINT_EFFECT_DEF,
  CHROMASPLIT_EFFECT_DEF,
  GRADIENT_MAP_EFFECT_DEF,
  POSTERIZE_EFFECT_DEF,
  NOISE_GRAIN_EFFECT_DEF,
  HYPER_GLOW_EFFECT_DEF,
  WAVE_EFFECT_DEF,
  TURBULENT_DISPLACE_EFFECT_DEF,
  RIPPLE_EFFECT_DEF,
  OPTICS_COMPENSATION_EFFECT_DEF,
  LINEAR_WIPE_EFFECT_DEF,
  ANGULAR_WIPE_EFFECT_DEF,
  DITHER_DISSOLVE_EFFECT_DEF,
  PIXEL_SORTER_EFFECT_DEF,
  MOSAIC_EFFECT_DEF,
  PIXEL_SORT_LITE_EFFECT_DEF,
};
