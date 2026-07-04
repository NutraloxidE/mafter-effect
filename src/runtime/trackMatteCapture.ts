import type { TrackMatteMode } from "../core/schema";
import { flattenShadow, inlineExportMedia, svgToDataUrl } from "./rasterCapture";
import { applyEmptyTrackMatte, applyTrackMatte, type RgbaBuffer } from "./trackMatteApply";

const XHTML = "http://www.w3.org/1999/xhtml";

function canvasToRgba(canvas: HTMLCanvasElement): RgbaBuffer {
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    width: canvas.width,
    height: canvas.height,
    data: new Uint8ClampedArray(imageData.data),
  };
}

/**
 * レイヤー DOM（transform 付き）を comp 空間 (nw×nh) にラスタ化する。
 * visibility:hidden でもクローン側は visible にしてキャプチャする。
 */
export async function captureLayerCompSpace(
  layerEl: HTMLElement,
  nw: number,
  nh: number,
  perspective = "",
  perspectiveOrigin = "50% 50%",
): Promise<RgbaBuffer> {
  const cloned = flattenShadow(layerEl) as HTMLElement;
  cloned.setAttribute("xmlns", XHTML);
  cloned.style.setProperty("visibility", "visible");
  await inlineExportMedia(cloned, layerEl);

  const inner = new XMLSerializer().serializeToString(cloned);
  const content = perspective
    ? `<div xmlns="${XHTML}" style="position:absolute;top:0;left:0;width:${nw}px;height:${nh}px;`
      + `perspective:${perspective};perspective-origin:${perspectiveOrigin}">${inner}</div>`
    : inner;
  const svgStr = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${nw}" height="${nh}">`,
    `<foreignObject x="0" y="0" width="${nw}" height="${nh}">`,
    content,
    `</foreignObject>`,
    `</svg>`,
  ].join("");

  const img = new Image();
  img.src = svgToDataUrl(svgStr);
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("track matte layer capture failed"));
  });

  const canvas = document.createElement("canvas");
  canvas.width = nw;
  canvas.height = nh;
  canvas.getContext("2d")!.drawImage(img, 0, 0);
  return canvasToRgba(canvas);
}

/**
 * fill / matte をラスタして applyTrackMatte。matteEl が null なら空マット。
 * 結果を destCanvas に描く。
 */
export async function composeTrackMatteToCanvas(
  fillEl: HTMLElement,
  matteEl: HTMLElement | null,
  mode: TrackMatteMode,
  nw: number,
  nh: number,
  destCanvas: HTMLCanvasElement,
  perspective = "",
  perspectiveOrigin = "50% 50%",
): Promise<void> {
  const fillBuf = await captureLayerCompSpace(fillEl, nw, nh, perspective, perspectiveOrigin);
  let out: RgbaBuffer;
  if (!matteEl) {
    out = applyEmptyTrackMatte(fillBuf, mode);
  } else {
    const matteBuf = await captureLayerCompSpace(matteEl, nw, nh, perspective, perspectiveOrigin);
    out = applyTrackMatte(fillBuf, matteBuf, mode);
  }
  if (destCanvas.width !== nw || destCanvas.height !== nh) {
    destCanvas.width = nw;
    destCanvas.height = nh;
  }
  const ctx = destCanvas.getContext("2d")!;
  const imageData = ctx.createImageData(out.width, out.height);
  imageData.data.set(out.data);
  ctx.putImageData(imageData, 0, 0);
}

