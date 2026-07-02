// §27.1/§27.4 — effect 配列から解決済み filter chain を組む純ヘルパ（DOM 非依存）。
// トップレベル（DomRenderer.applyEffects）と export のネスト comp タグ付けが同一ロジックを共有し、
// preview と export で chain が 2 本にならないようにする（INV-2）。

import { DISPLACEMENT_EFFECT_TYPES, opticsDisplaceScalePx } from "./effectSvg";
import { globalPluginRegistry } from "./pluginRegistry";
import type { ResolvedEffect } from "./resolved";

export interface EffectChainCtx {
  width: number;
  height: number;
  frame: number;
  layerOpacity?: number;
}

export type RasterChainItem = {
  effect: ResolvedEffect;
  def: NonNullable<ReturnType<typeof globalPluginRegistry.getEffectDef>>;
};

export interface ResolvedEffectChain {
  /** raster section より前の CSS/SVG filter token（`url(#id)` 含む）。 */
  preTokens: string[];
  preSvgFilters: { id: string; primitives: string }[];
  /** raster section より後の CSS/SVG filter token。 */
  postTokens: string[];
  postSvgFilters: { id: string; primitives: string }[];
  /** raster 実行 effect（pixelSorter / 完全 displacement 等）。 */
  rasterChain: RasterChainItem[];
  /** displacement 系 effect の最大スケール（filter region クランプ用）。 */
  fxMaxDisplaceScale: number;
  hasDisplacementFx: boolean;
}

function pushFilterPiece(
  piece: { kind: "css"; fn: string } | { kind: "svg"; primitives: string } | { kind: "raster" },
  tokens: string[],
  svgFilters: { id: string; primitives: string }[],
  id: string,
): void {
  if (piece.kind === "css") {
    tokens.push(piece.fn);
  } else if (piece.kind === "svg") {
    svgFilters.push({ id, primitives: piece.primitives });
    tokens.push(`url(#${id})`);
  }
}

/**
 * effects を pre/raster/post の 3 区画に振り分けて token・svg defs・raster chain を組む。
 * `idPrefix` は SVG filter の id 衝突回避用（top-level は `fx-<objId>`、nested は `nfx-<objId>` 等）。
 */
export function resolveEffectChain(
  effects: ResolvedEffect[],
  ctx: EffectChainCtx,
  idPrefix: string,
): ResolvedEffectChain {
  let fxMaxDisplaceScale = 0;
  let hasDisplacementFx = false;
  for (const effect of effects) {
    if (!effect.enabled) continue;
    if (!DISPLACEMENT_EFFECT_TYPES.has(effect.type)) continue;
    hasDisplacementFx = true;
    const p = effect.props;
    const scale =
      effect.type === "wave" ||
      effect.type === "ripple" ||
      effect.type === "fastWave" ||
      effect.type === "fastRipple"
        ? Math.max(0, typeof p["amplitude"] === "number" ? p["amplitude"] : 0)
        : effect.type === "opticsCompensation"
          ? opticsDisplaceScalePx(
              typeof p["fieldOfView"] === "number" ? p["fieldOfView"] : 0,
              p["reverse"] === true,
              ctx.width,
              ctx.height,
              typeof p["centerX"] === "number" ? p["centerX"] : 0.5,
              typeof p["centerY"] === "number" ? p["centerY"] : 0.5,
            )
          : Math.max(0, typeof p["amount"] === "number" ? p["amount"] : 0);
    fxMaxDisplaceScale = Math.max(fxMaxDisplaceScale, scale);
  }

  const preTokens: string[] = [];
  const postTokens: string[] = [];
  const preSvgFilters: { id: string; primitives: string }[] = [];
  const postSvgFilters: { id: string; primitives: string }[] = [];
  const rasterChain: RasterChainItem[] = [];
  let inRasterSection = false;
  let preSvgIndex = 0;
  let postSvgIndex = 0;

  for (const effect of effects) {
    if (!effect.enabled) continue;
    const def = globalPluginRegistry.getEffectDef(effect.type);
    if (!def) continue;
    const piece = def.apply(effect.props, ctx);
    if (!piece) continue;

    if (piece.kind === "raster") {
      inRasterSection = true;
      rasterChain.push({ effect, def });
    } else if (inRasterSection) {
      pushFilterPiece(piece, postTokens, postSvgFilters, `${idPrefix}-post-${postSvgIndex++}`);
    } else {
      pushFilterPiece(piece, preTokens, preSvgFilters, `${idPrefix}-pre-${preSvgIndex++}`);
    }
  }

  return {
    preTokens,
    preSvgFilters,
    postTokens,
    postSvgFilters,
    rasterChain,
    fxMaxDisplaceScale,
    hasDisplacementFx,
  };
}
