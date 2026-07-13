// liquidChrome の evolution パン時に feTurbulence 生成域の矩形端が露出しないかを確認する。
// 修正前は x=0 y=0 width=w height=h 固定域を feOffset でパンしていたため、
// evolution が変化すると生成域の縁（矩形の枠）が見えていた。
import { chromium } from "playwright";
import fs from "node:fs";

const PORT = process.env.VERIFY_PORT ?? "5175";
const URL = `https://localhost:${PORT}/`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 500, height: 400 }, ignoreHTTPSErrors: true });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const out = await page.evaluate(async () => {
  const { liquidChromePrimitives } = await import("/src/runtime/effectSvg.ts");
  const W = 300, H = 200;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  cv.getContext("2d").fillStyle = "#808080";
  cv.getContext("2d").fillRect(0, 0, W, H);
  const contentUrl = cv.toDataURL("image/png");

  async function renderAt(evolution) {
    const primitives = liquidChromePrimitives({
      amount: 18, size: 100, evolution, highlight: 1, depth: 6, seed: 7, quality: 1, w: W, h: H,
    });
    const filterId = `lc_${evolution}`;
    const filterMarkup = `<filter id="${filterId}" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">${primitives}</filter>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${filterMarkup}</defs><image href="${contentUrl}" x="0" y="0" width="${W}" height="${H}" style="filter:url(#${filterId})"/></svg>`;
    const url = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
    const img = new Image();
    img.src = url;
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/png");
  }

  const frames = [];
  for (const evo of [0, 45, 90, 135, 180, 270]) frames.push({ evo, png: await renderAt(evo) });
  return frames;
});

for (const f of out) {
  fs.writeFileSync(`verify-liquidchrome-seam-evo${f.evo}.png`, Buffer.from(f.png.split(",")[1], "base64"));
}
console.log("wrote frames for evolution:", out.map((f) => f.evo).join(", "));
console.log("errors:", errors.length ? errors.slice(0, 10) : "none");
await browser.close();
