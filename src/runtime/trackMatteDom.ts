import { trackMatteMaskId } from "../core/trackMatte";

/** fillHost に付与。export / verify がトラックマット塗りを識別する。 */
export const TRACK_MATTE_MASK_ATTR = "data-track-matte-mask";

/**
 * §5.4f 正準: canvas `applyTrackMatte`（preview/export 共通）。
 * CSS mask / mix-blend-mode destination-* は使わない（Chromium で text マット不可・不正 CSS）。
 */

/** 塗りを full-comp host + inner 構造にする。contentRoot（inner）を返す。 */
export function ensureTrackMatteFillStructure(
  host: HTMLDivElement,
  width: number,
  height: number,
): HTMLDivElement {
  host.style.position = "absolute";
  host.style.top = "0";
  host.style.left = "0";
  host.style.width = `${width}px`;
  host.style.height = `${height}px`;
  host.style.transform = "";
  host.style.transformOrigin = "0 0";
  host.style.isolation = "isolate";

  let inner = host.querySelector(":scope > [data-track-matte-inner]") as HTMLDivElement | null;
  if (!inner) {
    inner = document.createElement("div");
    inner.dataset.trackMatteInner = "1";
    inner.style.position = "absolute";
    inner.style.top = "0";
    inner.style.left = "0";
    inner.style.transformOrigin = "0 0";
    const migrate: Node[] = [];
    for (const child of [...host.childNodes]) {
      if (child instanceof HTMLElement && child.dataset.objectId) continue;
      if (child instanceof HTMLCanvasElement && child.dataset.trackMatteResult === "1") continue;
      if (child instanceof SVGSVGElement) continue;
      migrate.push(child);
    }
    for (const n of migrate) inner.appendChild(n);
    const firstMatte = host.querySelector(":scope > [data-object-id]");
    if (firstMatte) host.insertBefore(inner, firstMatte);
    else host.appendChild(inner);
  }
  return inner;
}

/** 合成結果表示用 canvas（fillHost 全面）。 */
export function ensureTrackMatteResultCanvas(host: HTMLDivElement, width: number, height: number): HTMLCanvasElement {
  let canvas = host.querySelector(":scope > canvas[data-track-matte-result]") as HTMLCanvasElement | null;
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.dataset.trackMatteResult = "1";
    canvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;z-index:2";
    host.appendChild(canvas);
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  return canvas;
}

export function markTrackMatteFillHost(fillHost: HTMLElement, fillId: string): void {
  fillHost.setAttribute(TRACK_MATTE_MASK_ATTR, trackMatteMaskId(fillId));
  fillHost.style.isolation = "isolate";
  fillHost.style.removeProperty("mask-image");
  fillHost.style.removeProperty("-webkit-mask-image");
}

export function clearTrackMatteFillHost(fillHost: HTMLElement): void {
  fillHost.removeAttribute(TRACK_MATTE_MASK_ATTR);
  fillHost.style.isolation = "";
  fillHost.style.removeProperty("mask-image");
  fillHost.style.removeProperty("-webkit-mask-image");
  const canvas = fillHost.querySelector(":scope > canvas[data-track-matte-result]");
  canvas?.remove();
}

/** キャプチャ用に残しつつ画面には出さない。 */
export function hideTrackMatteSources(fillInner: HTMLElement, matteEl: HTMLElement | null): void {
  fillInner.style.visibility = "hidden";
  if (matteEl) {
    matteEl.style.visibility = "hidden";
    matteEl.style.pointerEvents = "none";
    matteEl.style.removeProperty("mix-blend-mode");
    delete matteEl.dataset.trackMatteBlend;
  }
}

export function showTrackMatteSourcesForTeardown(fillInner: HTMLElement, matteEl: HTMLElement | null): void {
  fillInner.style.visibility = "";
  if (matteEl) {
    matteEl.style.visibility = "";
    matteEl.style.pointerEvents = "";
  }
}

export function applyMatteSourceLayout(matteLayer: HTMLElement, cssTransform: string, opacity: number): void {
  matteLayer.style.position = "absolute";
  matteLayer.style.top = "0";
  matteLayer.style.left = "0";
  matteLayer.style.transformOrigin = "0 0";
  matteLayer.style.transform = cssTransform;
  matteLayer.style.opacity = String(opacity);
  matteLayer.style.pointerEvents = "none";
  matteLayer.style.mixBlendMode = "";
  matteLayer.style.filter = "";
  matteLayer.style.zIndex = "1";
}

export function clearMatteSourceStyle(matteLayer: HTMLElement): void {
  matteLayer.style.removeProperty("mix-blend-mode");
  matteLayer.style.filter = "";
  matteLayer.style.pointerEvents = "";
  matteLayer.style.zIndex = "";
  matteLayer.style.visibility = "";
  delete matteLayer.dataset.trackMatteBlend;
}
