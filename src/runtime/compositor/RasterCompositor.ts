// GPU Raster Pipeline — Phase 1 seam。
//
// z 順の master 累積（背面確定ピクセル）を担う責務境界。現行は Canvas2DCompositor が唯一の
// backend で、挙動は従来の compositeExportFrame の逐次ロジックと byte-identical。将来 WebGL2
// backend（transform/opacity/blend/matte/adjustment を shader 化）を同じ interface で差し込む。
//
// 責務は「master への合成」だけに閉じる。DOM capture（foreignObject / per-layer perspective /
// nested 再帰）は exportComposite.ts 側に残す（plan §2.1: capture と composite を別責務にする）。

import type { BlendMode } from "../../core/schema";
import type { ExportChain } from "../exportComposite";

export interface RasterCompositor {
  /** レイヤ canvas を現在の master に blendMode で合成する（source-over = normal）。 */
  drawLayer(sub: HTMLCanvasElement, blendMode: BlendMode): void;

  /**
   * 調整レイヤーの effect chain を master（＝確定済み背面ピクセル）に適用して in-place 更新する。
   * pre CSS/SVG filter → raster chain → post CSS/SVG filter の順（DomRenderer の調整 pipeline と同順）。
   */
  applyAdjustment(chain: ExportChain, nw: number, nh: number): Promise<void>;

  /** 合成結果を返す（globalCompositeOperation を source-over に戻す）。scale は呼び出し側の責務。 */
  finish(): HTMLCanvasElement;
}
