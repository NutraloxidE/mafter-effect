// §5.4d 描画モードの合成ヘルパ。
// preview/Live は CSS mix-blend-mode（16 種）。
// 動画キャプチャは Canvas 2D globalCompositeOperation で合成し直す（INV-2）。

import type { BlendMode } from "../core/schema";

// CSS mix-blend-mode に直接対応する非 normal の 15 種。
// これらを持つレイヤーがあると capture は Canvas 合成経路へ分岐する。
const CSS_BLEND_SET: ReadonlySet<string> = new Set<BlendMode>([
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);

/** CSS mix-blend-mode で合成する非 normal の 15 種か。 */
export function isCssBlendMode(mode: BlendMode): boolean {
  return CSS_BLEND_SET.has(mode);
}

/**
 * blendMode を Canvas 2D の globalCompositeOperation に写像する。
 * normal → "source-over"。他 15 種は CSS と同名の合成オペレーション。
 */
export function blendModeToCompositeOp(mode: BlendMode): GlobalCompositeOperation {
  if (isCssBlendMode(mode)) return mode as GlobalCompositeOperation;
  return "source-over";
}
