// 実 live CSS-filter コンポジタ経路（プレビューと同一）で pixelStretch ドリフトを計測。
// raster 経路は既に drift=0 と確認済み。ここは DOM に filter:url() を直適用し、Fit ズーム相当の
// transform:scale(s) 下で帯サンプル位置を測る。stage2(1px厚補正)が downscale で潰れる仮説の検証。
// 計測: filtered 要素をスクショ→PNG(lossless)を再ロード→canvas で R 直読→drift=(R-128)/SLOPE。
import { chromium } from "playwright";
const PORT = process.env.VERIFY_PORT ?? "5175";
const browser = await chromium.launch({ args: ["--force-color-profile=srgb"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const SLOPE = 2, H = 40;

async function buildCase(length, scale) {
  // ソースramp と filter primitives を生成
  const prep = await page.evaluate(async ({ length, H, SLOPE }) => {
    const esvg = await import("/src/runtime/effectSvg.ts");
    const W = Math.max(600, Math.round(length * 2.2 + 300));
    const line = Math.round(0.5 * W);
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const c = cv.getContext("2d"); const id = c.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const r = Math.max(0, Math.min(255, Math.round(128 + (x - line) * SLOPE)));
      id.data[o] = r; id.data[o + 1] = r; id.data[o + 2] = r; id.data[o + 3] = 255;
    }
    c.putImageData(id, 0, 0);
    const prims = esvg.pixelStretchPrimitives({ w: W, h: H, direction: "right", linePos: 0.5, length, density: 1 });
    return { W, line, src: cv.toDataURL("image/png"), prims };
  }, { length, H, SLOPE });

  // DomRenderer と同じ: filter region を layer bounds [0,0,W,H] にクランプ
  const html = `<div id="wrap" style="position:absolute;left:0;top:0;transform:scale(${scale});transform-origin:0 0">
    <svg width="0" height="0" style="position:absolute"><defs>
      <filter id="ps" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="0" y="0" width="${prep.W}" height="${H}">${prep.prims}</filter>
    </defs></svg>
    <img id="t" src="${prep.src}" width="${prep.W}" height="${H}" style="display:block;filter:url(#ps)"/>
  </div>`;
  await page.setContent(`<body style="margin:0;background:#000">${html}</body>`);
  await page.waitForTimeout(250);
  const buf = await page.locator("#wrap").screenshot();
  const dataUrl = "data:image/png;base64," + buf.toString("base64");

  return await page.evaluate(async ({ dataUrl, W, line, length, scale, SLOPE, H }) => {
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = dataUrl; });
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const cc = cv.getContext("2d", { willReadFrequently: true }); cc.imageSmoothingEnabled = false;
    cc.drawImage(img, 0, 0);
    const px = cc.getImageData(0, 0, cv.width, cv.height).data;
    const midY = Math.floor((H * scale) / 2);
    const readAtSrcX = (srcX) => {
      const sx = Math.round(srcX * scale), sy = midY;
      return (px[(sy * cv.width + sx) * 4] - 128) / SLOPE;
    };
    const band = [];
    for (let d = 2; d <= 14; d += 3) band.push(+readAtSrcX(line + d).toFixed(2));
    return { length, scale, imgW: img.width, driftHead: +readAtSrcX(line + 3).toFixed(2), band };
  }, { dataUrl, W: prep.W, line: prep.line, length, scale, SLOPE, H });
}

const out = [];
for (const length of [600, 1000, 2000]) {
  for (const scale of [1, 0.5]) {
    out.push(await buildCase(length, scale));
  }
}
console.log(JSON.stringify(out, null, 2));
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
