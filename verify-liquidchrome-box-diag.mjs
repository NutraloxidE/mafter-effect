// liquidChrome の evolution で「動く四角枠」が見える問題を、実アプリと同じフィルタ領域
// ((0,0,w,h) userSpaceOnUse・displacement クランプ) で再現・診断する。
// 既存 verify-liquidchrome-evolution-seam.mjs は領域を -25%/150% にしていて実描画と不一致だった。
import { chromium } from "playwright";
import fs from "node:fs";

const PORT = process.env.VERIFY_PORT ?? "5175";
const URL = `https://localhost:${PORT}/`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 700, height: 500 }, ignoreHTTPSErrors: true });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const out = await page.evaluate(async () => {
  const { liquidChromePrimitives } = await import("/src/runtime/effectSvg.ts");
  const W = 300, H = 200;

  // テクスチャ付きコンテンツ（グリッド）: displacement のエッジ帯が見えるようにする。
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  c.fillStyle = "#3a3a3a"; c.fillRect(0, 0, W, H);
  c.strokeStyle = "#c8c8c8"; c.lineWidth = 1;
  for (let x = 0; x <= W; x += 20) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
  for (let y = 0; y <= H; y += 20) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
  const contentUrl = cv.toDataURL("image/png");

  async function renderAt(evolution) {
    const primitives = liquidChromePrimitives({
      amount: 40, size: 100, evolution, highlight: 1, depth: 6, seed: 7, quality: 1, w: W, h: H,
    });
    const filterId = `lc_${evolution}`;
    // 実アプリ createSvgFilterElement と同じ: displacement 系は (0,0,w,h) userSpaceOnUse にクランプ。
    const filterMarkup =
      `<filter id="${filterId}" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">${primitives}</filter>`;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<defs>${filterMarkup}</defs>` +
      `<image href="${contentUrl}" x="0" y="0" width="${W}" height="${H}" style="filter:url(#${filterId})"/></svg>`;
    const url = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
    const img = new Image();
    img.src = url;
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    const cc = document.createElement("canvas");
    cc.width = W; cc.height = H;
    cc.getContext("2d").drawImage(img, 0, 0);
    return cc.toDataURL("image/png");
  }

  const frames = [];
  for (const evo of [0, 90, 180, 270]) frames.push({ evo, png: await renderAt(evo) });
  return frames;
});

for (const f of out) {
  fs.writeFileSync(`verify-lc-box-evo${f.evo}.png`, Buffer.from(f.png.split(",")[1], "base64"));
}
console.log("wrote:", out.map((f) => `evo${f.evo}`).join(", "));
console.log("errors:", errors.length ? errors.slice(0, 10) : "none");
await browser.close();
