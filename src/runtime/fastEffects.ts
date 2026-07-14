import type { EffectDef, EffectRenderCtx } from "./plugin";
import { globalPluginRegistry } from "./pluginRegistry";
import {
  displaceWithMap,
  fastRippleDisplace,
  fastTurbulentDisplace,
  fastWaveDisplace,
  glitchSliceDisplaceMapPng,
  liquidChromePrimitives,
  mosaicGridSnapFilter,
  pixelStretchPrimitives,
} from "./effectSvg";

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

const ANTI_ALIAS_PARAM = {
  key: "antiAlias",
  label: "Anti Alias",
  kind: "bool" as const,
  default: false,
  animatable: false,
};

const MOSAIC_LITE_EFFECT_DEF: EffectDef = {
  type: "mosaicLite",
  label: "Mosaic (Lite)",
  category: "ディストーション（軽量）",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "blockSize", label: "Block Size", kind: "scalar", default: 16, animatable: true, min: 2, max: 256, step: 1 },
  ],
  apply(props, ctx: EffectRenderCtx) {
    const blockSize = Math.max(1, Math.round(num(props["blockSize"], 16)));
    if (blockSize <= 1) return null;
    const w = Math.max(1, ctx.width);
    const h = Math.max(1, ctx.height);
    const primitives = mosaicGridSnapFilter({ blockSize, w, h });
    if (!primitives) return null;
    return { kind: "svg", primitives };
  },
};

const FAST_WAVE_EFFECT_DEF: EffectDef = {
  type: "fastWave",
  label: "Fast Wave",
  category: "ディストーション（軽量）",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "amplitude", label: "Amplitude", kind: "scalar", default: 20, animatable: true, min: 0, max: 500, step: 0.1 },
    { key: "wavelength", label: "Wavelength", kind: "scalar", default: 50, animatable: true, min: 1, max: 500, step: 0.1 },
    { key: "direction", label: "Direction", kind: "enum", default: "horizontal", animatable: false, options: ["horizontal", "vertical"] },
    { key: "phase", label: "Phase", kind: "scalar", default: 0, animatable: true, min: 0, max: 360, step: 1 },
    ANTI_ALIAS_PARAM,
  ],
  apply(props, ctx: EffectRenderCtx) {
    const amplitude = Math.max(0, num(props["amplitude"], 0));
    if (amplitude === 0) return null;
    const w = Math.max(1, ctx.width);
    const h = Math.max(1, ctx.height);
    return {
      kind: "svg",
      primitives: fastWaveDisplace({
        amplitude,
        wavelength: Math.max(1, num(props["wavelength"], 50)),
        direction: str(props["direction"], "horizontal"),
        phaseDeg: num(props["phase"], 0),
        w,
        h,
        antiAlias: bool(props["antiAlias"], false),
      }),
    };
  },
};

const FAST_RIPPLE_EFFECT_DEF: EffectDef = {
  type: "fastRipple",
  label: "Fast Ripple",
  category: "ディストーション（軽量）",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "radius", label: "Radius", kind: "scalar", default: 100, animatable: true, min: 0, max: 1000, step: 0.1 },
    { key: "amplitude", label: "Amplitude", kind: "scalar", default: 10, animatable: true, min: 0, max: 200, step: 0.1 },
    { key: "frequency", label: "Frequency", kind: "scalar", default: 5, animatable: true, min: 0.1, max: 50, step: 0.1 },
    { key: "centerX", label: "Center X", kind: "scalar", default: 0.5, animatable: true, min: 0, max: 1, step: 0.01 },
    { key: "centerY", label: "Center Y", kind: "scalar", default: 0.5, animatable: true, min: 0, max: 1, step: 0.01 },
    ANTI_ALIAS_PARAM,
  ],
  apply(props, ctx: EffectRenderCtx) {
    const amplitude = Math.max(0, num(props["amplitude"], 0));
    if (amplitude === 0) return null;
    const w = Math.max(1, ctx.width);
    const h = Math.max(1, ctx.height);
    return {
      kind: "svg",
      primitives: fastRippleDisplace({
        radius: Math.max(1, num(props["radius"], 100)),
        amplitude,
        frequency: Math.max(0.1, num(props["frequency"], 5)),
        centerX: Math.min(1, Math.max(0, num(props["centerX"], 0.5))),
        centerY: Math.min(1, Math.max(0, num(props["centerY"], 0.5))),
        w,
        h,
        antiAlias: bool(props["antiAlias"], false),
      }),
    };
  },
};

const FAST_TURBULENT_DISPLACE_EFFECT_DEF: EffectDef = {
  type: "fastTurbulentDisplace",
  label: "Fast Turbulent Displace",
  category: "ディストーション（軽量）",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "amount", label: "Amount", kind: "scalar", default: 50, animatable: true, min: 0, max: 500, step: 0.1 },
    { key: "size", label: "Size", kind: "scalar", default: 100, animatable: true, min: 1, max: 2000, step: 0.1 },
    { key: "complexity", label: "Complexity", kind: "scalar", default: 2, animatable: true, min: 1, max: 6, step: 1 },
    { key: "evolution", label: "Evolution", kind: "scalar", default: 0, animatable: true, step: 1 },
    { key: "offsetX", label: "Offset X", kind: "scalar", default: 0, animatable: true, step: 1 },
    { key: "offsetY", label: "Offset Y", kind: "scalar", default: 0, animatable: true, step: 1 },
    { key: "randomSeed", label: "Random Seed", kind: "scalar", default: 0, animatable: false, min: 0, max: 9999, step: 1 },
    ANTI_ALIAS_PARAM,
  ],
  apply(props, ctx: EffectRenderCtx) {
    const amount = Math.max(0, num(props["amount"], 0));
    if (amount === 0) return null;
    const w = Math.max(1, ctx.width);
    const h = Math.max(1, ctx.height);
    const primitives = fastTurbulentDisplace({
      amount,
      size: Math.max(1, num(props["size"], 100)),
      complexity: Math.min(6, Math.max(1, Math.round(num(props["complexity"], 2)))),
      evolution: num(props["evolution"], 0),
      offsetX: num(props["offsetX"], 0),
      offsetY: num(props["offsetY"], 0),
      randomSeed: Math.max(0, Math.floor(num(props["randomSeed"], 0))) % 4096,
      w,
      h,
      antiAlias: bool(props["antiAlias"], false),
    });
    return { kind: "svg", primitives };
  },
};

const GLITCH_SLICE_EFFECT_DEF: EffectDef = {
  type: "glitchSlice",
  label: "Glitch Slice",
  category: "ディストーション（軽量）",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "intensity", label: "Intensity", kind: "scalar", default: 0.5, animatable: true, min: 0, max: 1, step: 0.01 },
    { key: "maxShift", label: "Max Shift", kind: "scalar", default: 60, animatable: true, min: 0, max: 500, step: 1 },
    { key: "sliceHeight", label: "Slice Height", kind: "scalar", default: 24, animatable: true, min: 2, max: 256, step: 1 },
    { key: "evolution", label: "Evolution", kind: "scalar", default: 0, animatable: true, step: 1 },
    { key: "seed", label: "Seed", kind: "scalar", default: 0, animatable: false, min: 0, max: 9999, step: 1 },
  ],
  apply(props, ctx: EffectRenderCtx) {
    const intensity = Math.min(1, Math.max(0, num(props["intensity"], 0.5)));
    const maxShift = Math.max(0, num(props["maxShift"], 60));
    if (intensity === 0 || maxShift === 0) return null;
    const w = Math.max(1, ctx.width);
    const h = Math.max(1, ctx.height);
    const sliceHeight = Math.max(2, Math.round(num(props["sliceHeight"], 24)));
    const evolution = num(props["evolution"], 0);
    const seed = Math.max(0, Math.floor(num(props["seed"], 0)));
    const { uri, scale } = glitchSliceDisplaceMapPng({
      w,
      h,
      sliceHeight,
      maxShift,
      density: intensity,
      seed,
      evolution,
    });
    return { kind: "svg", primitives: displaceWithMap(uri, scale, w, h) };
  },
};

const PIXEL_STRETCH_DIRECTIONS = ["right", "left", "down", "up"] as const;

const PIXEL_STRETCH_EFFECT_DEF: EffectDef = {
  type: "pixelStretch",
  label: "Pixel Stretch",
  category: "ディストーション（軽量）",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "direction", label: "Direction", kind: "enum", default: "right", animatable: false, options: [...PIXEL_STRETCH_DIRECTIONS] },
    { key: "linePos", label: "Line Pos", kind: "scalar", default: 0.5, animatable: true, min: 0, max: 1, step: 0.01 },
    // PLAN-ALT-1 WP-3: box-vs-ink オフセット（ISSUE.md 実測）の実機平均値を基準として焼き込み。
    // linePos/content 依存で真の根治ではない（ISSUE.md 案C）が、未調整時の見た目を大きく改善する近似値。
    { key: "lineBias", label: "Line Bias", kind: "scalar", default: 8, animatable: true, min: -200, max: 200, step: 1 },
    { key: "length", label: "Length", kind: "scalar", default: 300, animatable: true, min: 0, max: 2000, step: 1 },
    { key: "density", label: "Density", kind: "scalar", default: 1, animatable: true, min: 0, max: 1, step: 0.01 },
  ],
  apply(props, ctx: EffectRenderCtx) {
    const length = Math.max(0, num(props["length"], 300));
    if (length === 0) return null;
    const w = Math.max(1, ctx.width);
    const h = Math.max(1, ctx.height);
    const dir = str(props["direction"], "right");
    const direction = (PIXEL_STRETCH_DIRECTIONS as readonly string[]).includes(dir)
      ? (dir as (typeof PIXEL_STRETCH_DIRECTIONS)[number])
      : "right";
    const linePos = Math.min(1, Math.max(0, num(props["linePos"], 0.5)));
    const lineBias = num(props["lineBias"], 8);
    const density = Math.min(1, Math.max(0, num(props["density"], 1)));
    return {
      kind: "svg",
      primitives: pixelStretchPrimitives({ w, h, direction, linePos, length, density, lineBias }),
    };
  },
};

const LIQUID_CHROME_EFFECT_DEF: EffectDef = {
  type: "liquidChrome",
  label: "Liquid Chrome",
  category: "スタイライズ",
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "size", label: "Size", kind: "scalar", default: 140, animatable: true, min: 1, max: 2000, step: 0.1 },
    { key: "warp", label: "Warp", kind: "scalar", default: 160, animatable: true, min: 0, max: 500, step: 1 },
    { key: "detail", label: "Detail", kind: "scalar", default: 45, animatable: true, min: 0, max: 200, step: 1 },
    { key: "bands", label: "Bands", kind: "scalar", default: 6, animatable: true, min: 1, max: 24, step: 1 },
    { key: "evolution", label: "Evolution", kind: "scalar", default: 0, animatable: true, step: 1 },
    { key: "seed", label: "Seed", kind: "scalar", default: 7, animatable: false, min: 0, max: 9999, step: 1 },
    { key: "quality", label: "Quality", kind: "scalar", default: 1, animatable: true, min: 0.1, max: 1, step: 0.05 },
  ],
  apply(props, ctx: EffectRenderCtx) {
    const w = Math.max(1, ctx.width);
    const h = Math.max(1, ctx.height);
    const primitives = liquidChromePrimitives({
      size: Math.max(1, num(props["size"], 140)),
      warp: Math.max(0, num(props["warp"], 160)),
      detail: Math.max(0, num(props["detail"], 45)),
      bands: Math.min(24, Math.max(1, Math.round(num(props["bands"], 6)))),
      evolution: num(props["evolution"], 0),
      seed: Math.max(0, Math.floor(num(props["seed"], 7))) % 4096,
      quality: Math.min(1, Math.max(0.1, num(props["quality"], 1))),
      w,
      h,
    });
    return { kind: "svg", primitives };
  },
};

export function registerFastEffects(): void {
  globalPluginRegistry.registerEffect(MOSAIC_LITE_EFFECT_DEF);
  globalPluginRegistry.registerEffect(FAST_WAVE_EFFECT_DEF);
  globalPluginRegistry.registerEffect(FAST_RIPPLE_EFFECT_DEF);
  globalPluginRegistry.registerEffect(FAST_TURBULENT_DISPLACE_EFFECT_DEF);
  globalPluginRegistry.registerEffect(GLITCH_SLICE_EFFECT_DEF);
  globalPluginRegistry.registerEffect(PIXEL_STRETCH_EFFECT_DEF);
  // liquidChrome: 今回の PLAN から除外・エフェクトリストから非表示（登録のみ停止、実装は温存）
  // globalPluginRegistry.registerEffect(LIQUID_CHROME_EFFECT_DEF);
}

export {
  MOSAIC_LITE_EFFECT_DEF,
  FAST_WAVE_EFFECT_DEF,
  FAST_RIPPLE_EFFECT_DEF,
  FAST_TURBULENT_DISPLACE_EFFECT_DEF,
  GLITCH_SLICE_EFFECT_DEF,
  PIXEL_STRETCH_EFFECT_DEF,
  LIQUID_CHROME_EFFECT_DEF,
};
