// DOM → canvas ラスタ化（exporter §11.4 と共有・foreignObject 経路）

/** Shadow DOM を持つノードを再帰的に clone し、shadowRoot の内容を inline に展開する。 */
export function flattenShadow(node: Node): Node {
  if (!(node instanceof Element)) return node.cloneNode(true);

  const clone = node.cloneNode(false) as Element;
  const shadow = (node as HTMLElement).shadowRoot;
  if (shadow) {
    const styles = Array.from(shadow.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");
    if (styles) {
      const styleEl = document.createElement("style");
      styleEl.textContent = styles;
      clone.appendChild(styleEl);
    }
    for (const child of shadow.childNodes) {
      if (child instanceof HTMLStyleElement) continue;
      clone.appendChild(flattenShadow(child));
    }
  }
  for (const child of node.childNodes) {
    clone.appendChild(flattenShadow(child));
  }
  return clone;
}

/**
 * foreignObject シリアライズ前に canvas ピクセルを img に焼き込む。
 * flattenShadow の cloneNode は canvas bitmap を複製しないため、source 側から読む。
 */
export async function inlineCanvasBitmaps(cloned: HTMLElement, source: HTMLElement): Promise<void> {
  const sources = [...source.querySelectorAll("canvas")];
  const clones = [...cloned.querySelectorAll("canvas")];
  const loads: Promise<void>[] = [];
  for (let i = 0; i < clones.length; i++) {
    const node = clones[i];
    const srcCanvas = sources[i];
    if (!(node instanceof HTMLCanvasElement) || !(srcCanvas instanceof HTMLCanvasElement)) continue;
    if (srcCanvas.width === 0 || srcCanvas.height === 0) continue;
    const img = document.createElement("img");
    img.setAttribute("width", String(srcCanvas.width));
    img.setAttribute("height", String(srcCanvas.height));
    const style = node.getAttribute("style");
    if (style) img.setAttribute("style", style);
    const url = srcCanvas.toDataURL("image/png");
    loads.push(
      new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("canvas inline img load failed"));
        img.src = url;
      }),
    );
    node.replaceWith(img);
  }
  await Promise.all(loads);
}

/**
 * foreignObject シリアライズ前に video の現在フレームを img に焼き込む。
 * SVG foreignObject は <video> を描画できずブラウザのプレイヤー UI が出るため。
 * flushVideoFrames 済み前提（ここでは二重 wait しない）。表示サイズで JPEG 化して export を軽くする。
 */
function videoInlineDimensions(video: HTMLVideoElement): { dw: number; dh: number } {
  let dw = video.clientWidth > 0 ? Math.round(video.clientWidth) : video.videoWidth;
  let dh = video.clientHeight > 0 ? Math.round(video.clientHeight) : video.videoHeight;
  if (dw <= 0 || dh <= 0) {
    const sw = parseInt(video.style.width, 10);
    const sh = parseInt(video.style.height, 10);
    if (sw > 0) dw = sw;
    if (sh > 0) dh = sh;
  }
  if (dw <= 0 || dh <= 0) {
    const aw = parseInt(video.getAttribute("width") ?? "", 10);
    const ah = parseInt(video.getAttribute("height") ?? "", 10);
    if (aw > 0) dw = aw;
    if (ah > 0) dh = ah;
  }
  return { dw, dh };
}

export function inlineVideoFrames(cloned: HTMLElement, source: HTMLElement): void {
  const sources = [...source.querySelectorAll("video")];
  const clones = [...cloned.querySelectorAll("video")];
  for (let i = 0; i < clones.length; i++) {
    const node = clones[i];
    const srcVideo = sources[i];
    if (!(node instanceof HTMLVideoElement) || !(srcVideo instanceof HTMLVideoElement)) continue;
    const { dw, dh } = videoInlineDimensions(srcVideo);
    if (dw <= 0 || dh <= 0) {
      // decode 未完了の <video> を foreignObject に残すと黒矩形で下層を覆い隠す。
      node.remove();
      continue;
    }
    const canvas = document.createElement("canvas");
    canvas.width = dw;
    canvas.height = dh;
    canvas.getContext("2d")!.drawImage(srcVideo, 0, 0, dw, dh);
    const img = document.createElement("img");
    img.setAttribute("width", String(dw));
    img.setAttribute("height", String(dh));
    const style = node.getAttribute("style");
    if (style) img.setAttribute("style", style);
    img.src = canvas.toDataURL("image/jpeg", 0.92);
    node.replaceWith(img);
  }
}

/** canvas / video を foreignObject 用の静止画に差し替える。 */
export async function inlineExportMedia(cloned: HTMLElement, source: HTMLElement): Promise<void> {
  await inlineCanvasBitmaps(cloned, source);
  inlineVideoFrames(cloned, source);
}

/** SVG 文字列を tainted にならない data: URL に変換する（UTF-8 → base64）。 */
export function svgToDataUrl(svg: string): string {
  const utf8 = new TextEncoder().encode(svg);
  let binary = "";
  for (let i = 0; i < utf8.length; i++) binary += String.fromCharCode(utf8[i]!);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/**
 * ラスタ画像に filter chain を適用して canvas を返す。
 * `filterChain` は CSS filter property の値（`blur(28px)` 等の関数 + `url(#id)` SVG 参照を
 * スペース区切りで並べたもの）。SVG `<image>` への直接 filter 適用なので、foreignObject 経路とは
 * 別に CSS filter 関数（blur 等）も効く。複数 filter は記述順（左→右）に合成される。
 */
/**
 * `rasterizeFilteredImage` の SVG 文字列を組む純関数（テスト可能・DOM 非依存）。
 * `filterChain` 全体（CSS filter 関数 + `url(#id)` 参照）を `<image>` の CSS filter property に通す。
 * `filter="url(#id)"`（単一参照）へ退行すると blur 等の CSS token が落ちる（§27 Blur 回帰）。
 */
export function buildFilteredImageSvg(
  dataUrl: string,
  w: number,
  h: number,
  filtersMarkup: string,
  filterChain: string,
): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`,
    `<defs>${filtersMarkup}</defs>`,
    `<image href="${dataUrl}" x="0" y="0" width="${w}" height="${h}" style="filter:${filterChain}"/>`,
    `</svg>`,
  ].join("");
}

export async function rasterizeFilteredImage(
  dataUrl: string,
  w: number,
  h: number,
  filtersMarkup: string,
  filterChain: string,
): Promise<HTMLCanvasElement> {
  const svgStr = buildFilteredImageSvg(dataUrl, w, h, filtersMarkup, filterChain);
  const url = svgToDataUrl(svgStr);
  const img = new Image();
  img.src = url;
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("filtered SVG rasterization failed"));
  });
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(img, 0, 0);
  return canvas;
}

/**
 * 要素の DOM コンテンツを SVG foreignObject 経由で canvas にラスタ化する。
 * nw/nh = キャプチャ解像度。scale 省略時は nw×nh のまま返す。
 */
export async function captureElementToCanvas(
  element: HTMLElement,
  nw: number,
  nh: number,
  bg: string,
  scaleW?: number,
  scaleH?: number,
): Promise<HTMLCanvasElement> {
  const w = scaleW ?? nw;
  const h = scaleH ?? nh;

  const cloned = flattenShadow(element) as HTMLElement;
  cloned.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  await inlineExportMedia(cloned, element);

  const serializer = new XMLSerializer();
  const htmlStr = serializer.serializeToString(cloned);

  const svgStr = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${nw}" height="${nh}">`,
    bg !== "transparent" ? `<rect width="${nw}" height="${nh}" fill="${bg}"/>` : "",
    `<foreignObject x="0" y="0" width="${nw}" height="${nh}">`,
    htmlStr,
    `</foreignObject>`,
    `</svg>`,
  ].join("");

  const url = svgToDataUrl(svgStr);
  const img = new Image();
  img.src = url;
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("SVG rasterization failed"));
  });

  const native = document.createElement("canvas");
  native.width = nw;
  native.height = nh;
  const nctx = native.getContext("2d")!;
  if (bg !== "transparent") {
    nctx.fillStyle = bg;
    nctx.fillRect(0, 0, nw, nh);
  }
  nctx.drawImage(img, 0, 0);

  if (w === nw && h === nh) return native;

  const scaled = document.createElement("canvas");
  scaled.width = w;
  scaled.height = h;
  scaled.getContext("2d")!.drawImage(native, 0, 0, w, h);
  return scaled;
}
