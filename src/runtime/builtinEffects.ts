import type { RGBA } from "../core/schema";
import type { EffectDef, EffectRenderCtx } from "./plugin";
import { globalPluginRegistry } from "./pluginRegistry";

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
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

let registered = false;

export function registerBuiltinEffects(): void {
  if (registered) return;
  globalPluginRegistry.registerEffect(BLUR_EFFECT_DEF);
  globalPluginRegistry.registerEffect(TINT_EFFECT_DEF);
  registered = true;
}

export { BLUR_EFFECT_DEF, TINT_EFFECT_DEF };
