// ライブ CSS filter: url(#id) 経路（実際のプレビューと同じ DOM 経路）で
// 「帯が引いたソース列」を計測し、rasterizeFilteredImage 経路と比較する（INV-2 検証）。
// ユーザー報告「サンプルが左/上に寄る」= 原点方向バイアスを再現するのが狙い。
import { chromium } from "playwright";
const PORT = process.env.VERIFY_PORT ?? "5177";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

await page.evaluate((s) => { window.__psScale = s; }, Number(process.env.PS_SCALE ?? 1));
const decoded = await page.evaluate(async () => {
  const esvg = await import("/src/runtime/effectSvg.ts");
  const W = 400, H = 40;

  // 列 x を色符号化したソース <img>
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  const id = c.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    id.data[o] = x % 256; id.data[o + 1] = 0; id.data[o + 2] = x >= 256 ? 255 : 0; id.data[o + 3] = 255;
  }
  c.putImageData(id, 0, 0);
  const srcUrl = cv.toDataURL("image/png");

  const direction = "right", linePos = 0.5, length = 120, density = 1;
  const line = Math.round(linePos * W);
  const primitives = esvg.pixelStretchPrimitives({ w: W, h: H, direction, linePos, length, density });

  // 実プレビューと同じ filter 要素（DomRenderer.createSvgFilterElement 相当）
  const SCALE = Number(window.__psScale ?? 1);
  const wrap = document.createElement("div");
  wrap.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px;transform:scale(${SCALE});transform-origin:0 0;`;
  const svgns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgns, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  const defs = document.createElementNS(svgns, "defs");
  const filter = document.createElementNS(svgns, "filter");
  filter.setAttribute("id", "pslive");
  filter.setAttribute("color-interpolation-filters", "sRGB");
  filter.setAttribute("filterUnits", "userSpaceOnUse");
  filter.setAttribute("primitiveUnits", "userSpaceOnUse");
  filter.setAttribute("x", "0"); filter.setAttribute("y", "0");
  filter.setAttribute("width", String(W)); filter.setAttribute("height", String(H));
  filter.innerHTML = primitives;
  defs.appendChild(filter); svg.appendChild(defs); wrap.appendChild(svg);

  const img = document.createElement("img");
  img.src = srcUrl;
  img.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px;image-rendering:pixelated;filter:url(#pslive);`;
  await new Promise((r) => { img.onload = r; });
  wrap.appendChild(img);
  document.body.appendChild(wrap);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // 画面を読み戻す: wrap を canvas に描けないので、drawImage 経由は filter を失う。
  // → html→canvas はできないため、playwright screenshot 側で読む。マーカーだけ返す。
  return { W, line, length, ready: true };
});

// live 出力を screenshot して中央行をデコード
const SCALE = Number(process.env.PS_SCALE ?? 1);
const clip = { x: 0, y: 0, width: Math.round(400 * SCALE), height: Math.round(40 * SCALE) };
const buf = await page.screenshot({ clip });
const fs = await import("node:fs");
fs.writeFileSync("live-shot.png", buf);

const shotUri = "data:image/png;base64," + buf.toString("base64");
const res = await page.evaluate(async ({ shotUri, line, length, srcW }) => {
  const img = new Image();
  img.src = shotUri;
  await new Promise((r) => { img.onload = r; });
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const c = cv.getContext("2d");
  c.drawImage(img, 0, 0);
  const px = c.getImageData(0, 0, cv.width, cv.height).data;
  const midY = cv.height >> 1;
  const decAt = (screenX) => {
    const o = (midY * cv.width + screenX) * 4;
    return px[o + 3] === 0 ? -1 : px[o] + (px[o + 2] > 127 ? 256 : 0);
  };
  const scale = cv.width / srcW; // screen px per source px
  // 帯の screen 範囲中央付近を複数サンプルし、引いたソース列の中央値を取る
  const samples = [];
  for (let sx = Math.round((line + 15) * scale); sx <= Math.round((line + length - 15) * scale); sx += 2) {
    const v = decAt(sx); if (v >= 0) samples.push(v);
  }
  samples.sort((a, b) => a - b);
  // seam(screen)= 原画から外れ始める screen 列 → source 列に戻す
  let seamSrc = -1;
  for (let sx = 0; sx < cv.width; sx++) {
    const v = decAt(sx); const srcX = sx / scale;
    if (v >= 0 && Math.abs(v - srcX) > 2) { seamSrc = Math.round(srcX); break; }
  }
  return { W: cv.width, scale, bandSrc: samples[samples.length >> 1], seamSrc };
}, { shotUri, line: decoded.line, length: decoded.length, srcW: decoded.W });

console.log(JSON.stringify({
  path: "live CSS filter:url()",
  scale: Number(process.env.PS_SCALE ?? 1),
  line: decoded.line,
  bandSrc: res.bandSrc,
  bandSrcMinusLine: res.bandSrc - decoded.line,
  seamSrc: res.seamSrc,
  seamSrcMinusLine: res.seamSrc - decoded.line,
}, null, 2));
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
