// §27.4 — 調整 / raster effect の CSS+SVG filter chain を ImageData buffer に適用する純関数。
// DomRenderer（live preview の raster overlay）と exportComposite（オフDOM export 合成）で共有する。
// DOM ツリーには依存せず、buffer→buffer の変換のみ行う。

import { canvasToRasterBuffer, rasterBufferToCanvas } from "./pixelSort";
import { svgDisplaceFilterMarkup } from "./effectSvg";
import { rasterizeFilteredImage } from "./rasterCapture";

export type RasterBuffer = { data: Uint8ClampedArray; width: number; height: number };

/** displacement filter region 用の解決済みレイヤ寸法。`createSvgFilterElement` と対の値。 */
export interface FilterRegion {
  fxLayerW: number;
  fxLayerH: number;
  fxMaxDisplaceScale: number;
  fxUseBackdropDisplace: boolean;
}

/**
 * `filterStr`（CSS filter token + `url(#id)` 参照の順序付き chain）と `svgFilters`（SVG `<filter>` 定義）を
 * buffer に適用して新しい buffer を返す。displacement（`feDisplacementMap`）は region でクランプした
 * filter region を組む（§27.12: layer bounds に固定し定数変位による素矩形露出を防ぐ）。
 */
export async function applyFilterChainToBuffer(
  buffer: RasterBuffer,
  w: number,
  h: number,
  filterStr: string,
  svgFilters: { id: string; primitives: string }[],
  region: FilterRegion,
): Promise<RasterBuffer> {
  const sourceCanvas = rasterBufferToCanvas(buffer);
  const dataUrl = sourceCanvas.toDataURL("image/png");
  const filtersMarkup = svgFilters
    .map(({ id, primitives }) => {
      const isDisplace = primitives.includes("feDisplacementMap");
      if (isDisplace && region.fxLayerW > 0 && region.fxLayerH > 0) {
        return svgDisplaceFilterMarkup(
          id,
          primitives,
          region.fxLayerW,
          region.fxLayerH,
          region.fxMaxDisplaceScale,
          region.fxUseBackdropDisplace,
        );
      }
      return `<filter id="${id}" color-interpolation-filters="sRGB" x="-25%" y="-25%" width="150%" height="150%">${primitives}</filter>`;
    })
    .join("");
  const out = await rasterizeFilteredImage(dataUrl, w, h, filtersMarkup, filterStr);
  return canvasToRasterBuffer(out);
}
