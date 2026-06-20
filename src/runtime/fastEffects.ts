import type { EffectDef, EffectRenderCtx } from "./plugin";
import { globalPluginRegistry } from "./pluginRegistry";
import {
  displaceWithMap,
  fastRippleDisplaceMapSvg,
  fastTurbulentDisplace,
  fastWaveDisplace,
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

const FAST_WAVE_EFFECT_DEF: EffectDef = {
  type: "fastWave",
  label: "Fast Wave",
  category: "ディストーション（軽量）",
  previewBakeRequired: false,
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
    const primitives = fastWaveDisplace({
      amplitude,
      wavelength: Math.max(1, num(props["wavelength"], 50)),
      direction: str(props["direction"], "horizontal"),
      phaseDeg: num(props["phase"], 0),
      w,
      h,
      antiAlias: bool(props["antiAlias"], false),
    });
    return { kind: "svg", primitives };
  },
};

const FAST_RIPPLE_EFFECT_DEF: EffectDef = {
  type: "fastRipple",
  label: "Fast Ripple",
  category: "ディストーション（軽量）",
  previewBakeRequired: false,
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
    const { uri, scale } = fastRippleDisplaceMapSvg(
      Math.max(1, num(props["radius"], 100)),
      amplitude,
      Math.max(0.1, num(props["frequency"], 5)),
      Math.min(1, Math.max(0, num(props["centerX"], 0.5))),
      Math.min(1, Math.max(0, num(props["centerY"], 0.5))),
      w,
      h,
    );
    return {
      kind: "svg",
      primitives: displaceWithMap(uri, scale, w, h, bool(props["antiAlias"], false)),
    };
  },
};

const FAST_TURBULENT_DISPLACE_EFFECT_DEF: EffectDef = {
  type: "fastTurbulentDisplace",
  label: "Fast Turbulent Displace",
  category: "ディストーション（軽量）",
  previewBakeRequired: false,
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

export function registerFastEffects(): void {
  globalPluginRegistry.registerEffect(FAST_WAVE_EFFECT_DEF);
  globalPluginRegistry.registerEffect(FAST_RIPPLE_EFFECT_DEF);
  globalPluginRegistry.registerEffect(FAST_TURBULENT_DISPLACE_EFFECT_DEF);
}

export {
  FAST_WAVE_EFFECT_DEF,
  FAST_RIPPLE_EFFECT_DEF,
  FAST_TURBULENT_DISPLACE_EFFECT_DEF,
};
