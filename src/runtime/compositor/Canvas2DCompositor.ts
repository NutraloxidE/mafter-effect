// GPU Raster Pipeline — Phase 1 の唯一 backend（reference / fallback）。
//
// 従来 compositeExportFrame / compositeContainer / applyAdjustmentToMaster が inline で行っていた
// 「master canvas への z 順累積 + 調整 chain 適用」を、挙動を変えずにこのクラスへ移設したもの。
// 同じ Canvas2D オペレーションを同じ順序で実行するため出力は byte-identical（parity ゲート:
// bench-gpu-raster-parity.mjs）。WebGL2 backend が入るまでの reference 実装。

import type { BlendMode } from "../../core/schema";
import type { ExportChain } from "../exportComposite";
import type { RasterCompositor } from "./RasterCompositor";
import { blendModeToCompositeOp } from "../blendCompose";
import { canvasToRasterBuffer } from "../pixelSort";
import { processRasterChainAsync } from "../rasterProcessAsync";
import { applyFilterChainToBuffer } from "../effectRaster";

export class Canvas2DCompositor implements RasterCompositor {
  readonly master: HTMLCanvasElement;
  private readonly mctx: CanvasRenderingContext2D;

  constructor(nw: number, nh: number, bg: string) {
    const c = document.createElement("canvas");
    c.width = nw;
    c.height = nh;
    this.master = c;
    this.mctx = c.getContext("2d")!;
    if (bg !== "transparent") {
      this.mctx.fillStyle = bg;
      this.mctx.fillRect(0, 0, nw, nh);
    }
  }

  drawLayer(sub: HTMLCanvasElement, blendMode: BlendMode): void {
    this.mctx.globalCompositeOperation = blendModeToCompositeOp(blendMode);
    this.mctx.drawImage(sub, 0, 0);
  }

  async applyAdjustment(chain: ExportChain, nw: number, nh: number): Promise<void> {
    let buffer = canvasToRasterBuffer(this.master);
    if (chain.preFilterStr) {
      buffer = await applyFilterChainToBuffer(buffer, nw, nh, chain.preFilterStr, chain.preSvgFilters, chain.region);
    }
    if (chain.rasterChain.length > 0) {
      buffer = await processRasterChainAsync(buffer, chain.rasterChain, { width: nw, height: nh, frame: chain.frame });
    }
    if (chain.postFilterStr) {
      buffer = await applyFilterChainToBuffer(buffer, nw, nh, chain.postFilterStr, chain.postSvgFilters, chain.region);
    }
    this.mctx.globalCompositeOperation = "source-over";
    this.mctx.putImageData(new ImageData(new Uint8ClampedArray(buffer.data), buffer.width, buffer.height), 0, 0);
  }

  finish(): HTMLCanvasElement {
    this.mctx.globalCompositeOperation = "source-over";
    return this.master;
  }
}
