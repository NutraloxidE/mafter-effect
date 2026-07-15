// 仮説検証: 変位マップを表示デバイス解像度に合わせて k=scale 倍に細かく生成すると、
// 拡大(scale>1)でもテクセルと出力ピクセルが 1:1 化してスパイクが消えるか。
// マップは w*k texel で作り、feImage width=W(userSpace) に stretch、
// feDisplacementMap scale は userSpace px(=2*length)に据える(len を k 倍したぶんを打ち消す)。
import { chromium } from "playwright";
const PORT = process.env.VERIFY_PORT ?? "5175";
const browser = await chromium.launch({ args: ["--force-color-profile=srgb"] });
const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);
const H = 120;

async function buildCase({ length, scale, k }) {
  const prep = await page.evaluate(async ({ length, H, scale, k }) => {
    const esvg = await import("/src/runtime/effectSvg.ts");
    const W = Math.max(700, Math.round(length * 1.6 + 200));
    const line = Math.round(0.25 * W);
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const c = cv.getContext("2d"); const id = c.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4; const v = x < line ? 30 : 220;
      id.data[o] = v; id.data[o + 1] = v; id.data[o + 2] = v; id.data[o + 3] = 255;
    }
    c.putImageData(id, 0, 0);
    // 実コードパス: superSample パラメータで細分化（k=1 で従来と等価）。
    const prims = esvg.pixelStretchPrimitives({ w: W, h: H, direction: "right", linePos: 0.25, length, density: 1, superSample: k });
    return { W, prims, src: cv.toDataURL("image/png"), line };
  }, { length, H, scale, k });

  const html = `<div id="wrap" style="position:absolute;left:0;top:0;transform:scale(${scale});transform-origin:0 0">
    <svg width="0" height="0" style="position:absolute"><defs>
      <filter id="ps" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="0" y="0" width="${prep.W}" height="${H}">${prep.prims}</filter>
    </defs></svg>
    <img id="t" src="${prep.src}" width="${prep.W}" height="${H}" style="display:block;filter:url(#ps)"/>
  </div>`;
  await page.setContent(`<body style="margin:0;background:#000">${html}</body>`);
  await page.waitForTimeout(200);
  const buf = await page.locator("#wrap").screenshot();
  const dataUrl = "data:image/png;base64," + buf.toString("base64");
  return await page.evaluate(async ({ dataUrl, line, scale }) => {
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = dataUrl; });
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const cc = cv.getContext("2d", { willReadFrequently: true }); cc.imageSmoothingEnabled = false;
    cc.drawImage(img, 0, 0);
    const W = cv.width, Hh = cv.height; const px = cc.getImageData(0, 0, W, Hh).data;
    const my = Math.floor(Hh / 2); const lineDev = Math.round(line * scale);
    const cols = []; for (let x = lineDev + 4; x < W - 2; x++) cols.push(px[(my * W + x) * 4]);
    let maxJump = 0, jumps = 0;
    for (let i = 1; i < cols.length; i++) { const d = Math.abs(cols[i] - cols[i - 1]); if (d > maxJump) maxJump = d; if (d > 20) jumps++; }
    return { spikeJumps: jumps, maxJump };
  }, { dataUrl, line: prep.line, scale });
}

const out = [];
for (const length of [400, 800]) {
  for (const scale of [3, 6]) {
    const base = await buildCase({ length, scale, k: 1 });
    const dyn = await buildCase({ length, scale, k: scale });
    out.push({ length, scale, base_spikes: base.spikeJumps, dynres_spikes: dyn.spikeJumps });
  }
}
console.log(JSON.stringify(out, null, 2));
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
