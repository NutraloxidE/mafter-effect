import type { Font } from "opentype.js";
import type { RGBA } from "../core/schema";
import {
  computeTextContentBounds,
  resolveTextLayout,
  textBaselineY,
  type LocalBounds,
  type TextAlign,
} from "./textLayout";

export interface TextStyleProps {
  text: string;
  font: string;
  size: number;
  color: RGBA;
  align: TextAlign;
  tracking: number;
  leading: number;
  boxWidth: number;
  boxHeight: number;
  weight: number;
  italic: boolean;
  strokeColor: RGBA;
  strokeWidth: number;
}

const DEFAULT_RGBA: RGBA = { r: 1, g: 1, b: 1, a: 1 };
const DEFAULT_STROKE: RGBA = { r: 0, g: 0, b: 0, a: 1 };

function isRgba(v: unknown): v is RGBA {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as RGBA).r === "number" &&
    typeof (v as RGBA).g === "number" &&
    typeof (v as RGBA).b === "number" &&
    typeof (v as RGBA).a === "number"
  );
}

function asAlign(v: unknown): TextAlign {
  if (v === "center" || v === "right" || v === "justify") return v;
  return "left";
}

/** ResolvedScene の text props を描画用に正規化する。 */
export function parseTextProps(props: Record<string, unknown>): TextStyleProps {
  return {
    text: typeof props["text"] === "string" ? props["text"] : "",
    font: typeof props["font"] === "string" ? props["font"] : "sans-serif",
    size: typeof props["size"] === "number" && props["size"] > 0 ? props["size"] : 48,
    color: isRgba(props["color"]) ? props["color"] : DEFAULT_RGBA,
    align: asAlign(props["align"]),
    tracking: typeof props["tracking"] === "number" ? props["tracking"] : 0,
    leading: typeof props["leading"] === "number" ? props["leading"] : 0,
    boxWidth: typeof props["boxWidth"] === "number" && props["boxWidth"] > 0 ? props["boxWidth"] : 0,
    boxHeight: typeof props["boxHeight"] === "number" && props["boxHeight"] > 0 ? props["boxHeight"] : 0,
    weight: typeof props["weight"] === "number" ? props["weight"] : 400,
    italic: props["italic"] === true,
    strokeColor: isRgba(props["strokeColor"]) ? props["strokeColor"] : DEFAULT_STROKE,
    strokeWidth: typeof props["strokeWidth"] === "number" ? Math.max(0, props["strokeWidth"]) : 0,
  };
}

export function rgbaCss(c: RGBA): string {
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;
}

function createMeasureCtx(): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  return canvas.getContext("2d");
}

function applyMeasureFont(ctx: CanvasRenderingContext2D, p: TextStyleProps): void {
  ctx.font = `${p.italic ? "italic" : "normal"} ${p.weight} ${p.size}px ${p.font}`;
}

/**
 * Draft DOM / プレビューハンドル共用の Canvas 実測境界（content-local）。
 * solid の props.size と同様、描画 box とハンドル bounds を一致させる。
 */
export function measureTextCanvasBounds(p: TextStyleProps): LocalBounds {
  const ctx = createMeasureCtx();
  if (!ctx) {
    return computeTextContentBounds(
      p.text, p.size, p.tracking, p.leading, p.align, null, undefined, p.boxWidth,
    );
  }
  applyMeasureFont(ctx, p);
  const measureChar = (char: string): number => ctx.measureText(char).width;
  return computeTextContentBounds(
    p.text, p.size, p.tracking, p.leading, p.align, null, measureChar, p.boxWidth,
  );
}

/** Best=precise 時は opentype、Draft 時は Canvas 実測でハンドル bounds を決める。 */
export function computeTextBoundsForHandles(
  p: TextStyleProps,
  font: Font | null,
  useFontMetrics: boolean,
): LocalBounds {
  if (useFontMetrics && font) {
    return computeTextContentBounds(p.text, p.size, p.tracking, p.leading, p.align, font, undefined, p.boxWidth, p.boxHeight);
  }
  const measureCtx = createMeasureCtx();
  if (measureCtx) applyMeasureFont(measureCtx, p);
  const measureChar = (char: string): number =>
    measureCtx ? measureCtx.measureText(char).width : p.size * 0.6;
  return resolveTextLayout(
    p.text, p.size, p.tracking, p.leading, p.align, null, measureChar, p.boxWidth, p.boxHeight,
  ).bounds;
}

/** §26.4 DOM 描画。レイアウト座標で 1 文字ずつ配置し Best / グリフ分解と一致させる。 */
export function applyDraftText(el: HTMLElement, p: TextStyleProps): void {
  el.style.whiteSpace = "normal";
  el.style.margin = "0";
  el.style.padding = "0";
  el.style.position = "relative";
  el.style.color = rgbaCss(p.color);
  el.style.fontFamily = p.font;
  el.style.fontSize = `${p.size}px`;
  el.style.fontWeight = String(p.weight);
  el.style.fontStyle = p.italic ? "italic" : "normal";
  el.style.letterSpacing = "0";
  el.style.textAlign = "left";
  if (p.strokeWidth > 0) {
    el.style.webkitTextStroke = `${p.strokeWidth}px ${rgbaCss(p.strokeColor)}`;
    el.style.paintOrder = "stroke fill";
  } else {
    el.style.webkitTextStroke = "";
    el.style.paintOrder = "";
  }

  const measureCtx = createMeasureCtx();
  if (measureCtx) applyMeasureFont(measureCtx, p);
  const measureChar = (char: string): number =>
    measureCtx ? measureCtx.measureText(char).width : p.size * 0.6;
  const { lines, bounds, lineHeight } = resolveTextLayout(
    p.text, p.size, p.tracking, p.leading, p.align, null, measureChar, p.boxWidth, p.boxHeight,
  );

  const boxW = bounds.maxX - bounds.minX;
  const boxH = bounds.maxY - bounds.minY;
  el.style.width = `${Math.max(1, boxW)}px`;
  el.style.height = `${Math.max(1, boxH)}px`;
  el.style.lineHeight = `${lineHeight}px`;
  // 固定高さボックス（boxHeight>0）でははみ出しをクリップ。それ以外は従来通り可視。
  el.style.overflow = p.boxWidth > 0 && p.boxHeight > 0 ? "hidden" : "visible";
  el.style.transform = "";
  // align（center/right）では bounds.minX が負になる。グリフは 0 基準に正規化済みなので、
  // 要素全体を minX だけシフトして anchor(原点) 相対の配置にする。これでギズモ bounds
  // [minX,maxX] と描画矩形が一致する（左寄せ=minX=0 は無変化＝非破壊・§26.4）。
  el.style.left = `${bounds.minX}px`;
  el.style.top = `${bounds.minY}px`;

  el.textContent = "";
  for (const line of lines) {
    for (const g of line.glyphs) {
      if (!g.char || g.char === "\n") continue;
      const span = document.createElement("span");
      span.style.position = "absolute";
      span.style.left = `${g.x - bounds.minX}px`;
      span.style.top = `${g.y - bounds.minY}px`;
      span.style.lineHeight = `${lineHeight}px`;
      span.textContent = g.char;
      el.appendChild(span);
    }
  }
}

/** §26.4.1 precise: SVG アウトライン（asset フォント）または SVG `<text>` フォールバック。 */
export function renderPreciseText(
  container: HTMLElement,
  p: TextStyleProps,
  font: Font | null,
): void {
  let svg = container.querySelector("svg[data-mafter-text]") as SVGSVGElement | null;
  if (!svg) {
    container.textContent = "";
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.dataset.mafterText = "1";
    svg.style.cssText = "position:absolute;top:0;left:0;overflow:visible;pointer-events:none";
    container.appendChild(svg);
  }
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const measureCtx = createMeasureCtx();
  if (measureCtx) applyMeasureFont(measureCtx, p);
  const sampleChar = p.text.match(/\S/)?.[0];
  const { lines, bounds } = resolveTextLayout(
    p.text, p.size, p.tracking, p.leading, p.align, font,
    measureCtx ? (char) => measureCtx.measureText(char).width : undefined,
    p.boxWidth, p.boxHeight,
  );
  const boxW = bounds.maxX - bounds.minX;
  const boxH = bounds.maxY - bounds.minY;
  svg.setAttribute("width", String(Math.ceil(Math.max(1, boxW))));
  svg.setAttribute("height", String(Math.ceil(Math.max(1, boxH))));
  svg.style.transform = "";
  // applyDraftText と同じく anchor 相対へ：path/tspan は bounds 左上(0)基準なので
  // コンテナを minX/minY だけシフトしてギズモ bounds と一致させる。
  container.style.left = `${bounds.minX}px`;
  container.style.top = `${bounds.minY}px`;
  // 固定高さボックスはコンテナでクリップ（svg は overflow:visible のまま）。
  container.style.overflow = p.boxWidth > 0 && p.boxHeight > 0 ? "hidden" : "visible";
  container.style.width = `${Math.max(1, boxW)}px`;
  container.style.height = `${Math.max(1, boxH)}px`;

  const fill = rgbaCss(p.color);
  const stroke = rgbaCss(p.strokeColor);
  const strokeW = p.strokeWidth;

  if (font) {
    for (const line of lines) {
      const baseline = textBaselineY(line.y, p.size, p.leading, font, measureCtx, sampleChar);
      for (const g of line.glyphs) {
        if (!g.char || g.char === "\n") continue;
        const path = font.getPath(g.char, g.x - bounds.minX, baseline, p.size);
        const d = path.toPathData(2);
        const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
        pathEl.setAttribute("d", d);
        pathEl.setAttribute("fill", fill);
        if (strokeW > 0) {
          pathEl.setAttribute("stroke", stroke);
          pathEl.setAttribute("stroke-width", String(strokeW));
          pathEl.setAttribute("paint-order", "stroke fill");
        }
        svg.appendChild(pathEl);
      }
    }
    return;
  }

  // system フォント: グリフ単位 SVG <tspan>（layoutTextLines 座標 = グリフ分解と一致）
  const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
  textEl.setAttribute("fill", fill);
  textEl.setAttribute("font-family", p.font);
  textEl.setAttribute("font-size", String(p.size));
  textEl.setAttribute("font-weight", String(p.weight));
  if (p.italic) textEl.setAttribute("font-style", "italic");
  if (strokeW > 0) {
    textEl.setAttribute("stroke", stroke);
    textEl.setAttribute("stroke-width", String(strokeW));
    textEl.setAttribute("paint-order", "stroke fill");
  }
  for (const line of lines) {
    const baseline = textBaselineY(line.y, p.size, p.leading, null, measureCtx, sampleChar);
    for (const g of line.glyphs) {
      if (!g.char || g.char === "\n") continue;
      const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      tspan.setAttribute("x", String(g.x - bounds.minX));
      tspan.setAttribute("y", String(baseline));
      tspan.textContent = g.char;
      textEl.appendChild(tspan);
    }
  }
  svg.appendChild(textEl);
}

/** draft/precise 切替。Draft=DOM が正、Best は DOM line box に合わせる。 */
export function applyTextEl(
  el: HTMLElement,
  props: Record<string, unknown>,
  mode: "draft" | "precise",
  font: Font | null,
): void {
  const p = parseTextProps(props);
  if (mode === "draft") {
    const svg = el.querySelector("svg[data-mafter-text]");
    if (svg) svg.remove();
    applyDraftText(el, p);
    return;
  }
  renderPreciseText(el, p, font);
}
