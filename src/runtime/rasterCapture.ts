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
  await inlineCanvasBitmaps(cloned, element);

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
