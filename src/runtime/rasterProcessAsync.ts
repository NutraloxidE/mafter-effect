import type { EffectDef } from "./plugin";
import type { RasterBuffer } from "./plugin";
import { globalRasterWorkerPool } from "./rasterWorkerPool";

export interface RasterChainItem {
  effect: { type: string; props: Record<string, unknown> };
  def: EffectDef;
}

export interface RasterProcessCtx {
  frame: number;
  width: number;
  height: number;
}

/** raster effect チェーンを実行（pixelSorter は Worker プールへオフロード）。 */
export async function processRasterChainAsync(
  input: RasterBuffer,
  chain: RasterChainItem[],
  ctx: RasterProcessCtx,
): Promise<RasterBuffer> {
  let buffer = input;
  for (const { effect, def } of chain) {
    if (!def.processPixels) continue;
    if (effect.type === "pixelSorter" && globalRasterWorkerPool.isAvailable) {
      buffer = await globalRasterWorkerPool.processPixelSort(buffer, effect.props, ctx.frame);
    } else {
      buffer = def.processPixels(buffer, effect.props, ctx);
    }
  }
  return buffer;
}
