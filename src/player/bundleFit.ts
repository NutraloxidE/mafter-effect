/** §11.7 bundle player — ビューポートに comp 全体をフィット（Preview §25.1 と同式）。 */

export interface ViewPan {
  x: number;
  y: number;
}

export function computeFitZoom(
  viewportW: number,
  viewportH: number,
  compW: number,
  compH: number,
): number {
  if (viewportW <= 0 || viewportH <= 0 || compW <= 0 || compH <= 0) return 1;
  return Math.min(viewportW / compW, viewportH / compH);
}

export function computeFitPan(
  viewportW: number,
  viewportH: number,
  compW: number,
  compH: number,
  viewZoom: number,
): ViewPan {
  return {
    x: (viewportW / viewZoom - compW) / 2,
    y: (viewportH / viewZoom - compH) / 2,
  };
}

export function applyFitTransform(
  el: HTMLElement,
  viewportW: number,
  viewportH: number,
  compW: number,
  compH: number,
): void {
  const zoom = computeFitZoom(viewportW, viewportH, compW, compH);
  const pan = computeFitPan(viewportW, viewportH, compW, compH, zoom);
  el.style.width = `${compW}px`;
  el.style.height = `${compH}px`;
  el.style.transform = `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)`;
  el.style.transformOrigin = "0 0";
}
