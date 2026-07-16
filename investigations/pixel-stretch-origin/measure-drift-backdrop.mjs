// 調整レイヤー経路（backdrop-filter + comp サイズ region）で pixelStretch ドリフト計測。
// 背後に line 中心の緩い輝度ランプを敷き、その上に backdrop-filter:url(#ps) の調整 div を重ね、
// 合成結果をスクショ→帯サンプル位置 drift=(R-128)/SLOPE。stage2 が backdrop 経路で効くか検証。
import { chromium } from "playwright";
const PORT = process.env.VERIFY_PORT ?? "5175";
const browser = await chromium.launch({ args: ["--force-color-profile=srgb"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 400 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const SLOPE = 2, H = 200; // comp 高さ相当

async function buildCase(length, scale) {
  const prep = await page.evaluate(async ({ length, H, SLOPE }) => {
    const esvg = await import("/src/runtime/effectSvg.ts");
    const W = Math.max(600, Math.round(length * 2.2 + 300)); // comp 幅相当
    const line = Math.round(0.5 * W);
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const c = cv.getContext("2d"); const id = c.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const r = Math.max(0, Math.min(255, Math.round(128 + (x - line) * SLOPE)));
      id.data[o] = r; id.data[o + 1] = r; id.data[o + 2] = r; id.data[o + 3] = 255;
    }
    c.putImageData(id, 0, 0);
    // 調整レイヤーは ctx=comp サイズで primitives 生成
    const prims = esvg.pixelStretchPrimitives({ w: W, h: H, direction: "right", linePos: 0.5, length, density: 1 });
    return { W, line, src: cv.toDataURL("image/png"), prims };
  }, { length, H, SLOPE });

  const html = `<div id="wrap" style="position:absolute;left:0;top:0;transform:scale(${scale});transform-origin:0 0">
    <svg width="0" height="0" style="position:absolute"><defs>
      <filter id="ps" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="0" y="0" width="${prep.W}" height="${H}">${prep.prims}</filter>
    </defs></svg>
    <div style="position:relative;width:${prep.W}px;height:${H}px">
      <img src="${prep.src}" width="${prep.W}" height="${H}" style="position:absolute;left:0;top:0;display:block"/>
      <div style="position:absolute;left:0;top:0;width:${prep.W}px;height:${H}px;backdrop-filter:url(#ps);-webkit-backdrop-filter:url(#ps)"></div>
    </div>
  </div>`;
  await page.setContent(`<body style="margin:0;background:#000">${html}</body>`);
  await page.waitForTimeout(300);
  const buf = await page.locator("#wrap").screenshot();
  const dataUrl = "data:image/png;base64," + buf.toString("base64");

  return await page.evaluate(async ({ dataUrl, line, length, scale, SLOPE, H }) => {
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = dataUrl; });
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const cc = cv.getContext("2d", { willReadFrequently: true }); cc.imageSmoothingEnabled = false;
    cc.drawImage(img, 0, 0);
    const px = cc.getImageData(0, 0, cv.width, cv.height).data;
    const midY = Math.floor((H * scale) / 2);
    const readAtSrcX = (srcX) => (px[(midY * cv.width + Math.round(srcX * scale)) * 4] - 128) / SLOPE;
    const band = [];
    for (let d = 2; d <= 14; d += 3) band.push(+readAtSrcX(line + d).toFixed(2));
    return { length, scale, driftHead: +readAtSrcX(line + 3).toFixed(2), band, predicted: +(length / 255).toFixed(2) };
  }, { dataUrl, line: prep.line, length, scale, SLOPE, H });
}

const out = [];
for (const length of [600, 1000, 2000]) {
  for (const scale of [1, 0.5]) out.push(await buildCase(length, scale));
}
console.log(JSON.stringify(out, null, 2));
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
