// liquidChrome 作り直しプロトタイプ v2（fill 方式・pic1 志向）。
// pic1 の正体 = シャープな金属環境の縞グラデを流体 turbulence で歪ませたもの。
// 縞グラデ(bake PNG)を feImage で敷き、feDisplacementMap(turbulence) で歪ませ、SourceAlpha に閉じ込める。
import { chromium } from "playwright";
import fs from "node:fs";

const PORT = process.env.VERIFY_PORT ?? "5175";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 700, height: 500 }, ignoreHTTPSErrors: true });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const out = await page.evaluate(async () => {
  const W = 480, H = 270;

  // レイヤー形状（白い角丸矩形）。中身がクローム化される。
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  const r = 24, m = 16, x = m, y = m, ww = W - 2 * m, hh = H - 2 * m;
  c.fillStyle = "#ffffff";
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + ww, y, x + ww, y + hh, r);
  c.arcTo(x + ww, y + hh, x, y + hh, r);
  c.arcTo(x, y + hh, x, y, r);
  c.arcTo(x, y, x + ww, y, r);
  c.closePath(); c.fill();
  const contentUrl = cv.toDataURL("image/png");

  // 金属環境の縞グラデ（縦・K 周期）を bake。1 周期内: 黒(青み)→スチール→鋭い白ハイライト→ピンク(イリデ)→暗紫→黒。
  function chromeStripUrl(periods, stopsOverride) {
    const GH = 512, GW = 2;
    const g = document.createElement("canvas");
    g.width = GW; g.height = GH;
    const gx = g.getContext("2d");
    const period = GH / periods;
    const stops = stopsOverride || [
      [0.0, "#080810"], [0.30, "#38486a"], [0.46, "#dfe8ff"],
      [0.50, "#ffffff"], [0.58, "#cbb6d6"], [0.74, "#241d33"], [1.0, "#080810"],
    ];
    for (let k = 0; k < periods; k++) {
      const y0 = k * period;
      const grad = gx.createLinearGradient(0, y0, 0, y0 + period);
      for (const [t, col] of stops) grad.addColorStop(t, col);
      gx.fillStyle = grad;
      gx.fillRect(0, y0, GW, period);
    }
    return g.toDataURL("image/png");
  }

  function chromeFilter(v) {
    const { size, octaves, scale, scale2, stripUrl, evolution } = v;
    const freq = (1 / Math.max(1, size)).toFixed(5);
    const freq2 = (1 / Math.max(1, size * 0.45)).toFixed(5); // 2 段目は細かい curl
    // evolution パン（周期タイル方式）
    const dist = (evolution / 360) * size;
    const rad = (evolution * Math.PI) / 180;
    const evoDx = Math.cos(rad) * dist, evoDy = Math.sin(rad) * dist;
    const panX = ((evoDx % W) + W) % W, panY = ((evoDy % H) + H) % H;
    const off = `<feOffset in="noiseTiled" dx="${panX.toFixed(2)}" dy="${panY.toFixed(2)}" result="noise"/>`;
    return (
      // 流体場（生成域固定＋タイルで枠なし）
      `<feTurbulence type="fractalNoise" baseFrequency="${freq} ${freq}" numOctaves="${octaves}" seed="7" stitchTiles="stitch" x="0" y="0" width="${W}" height="${H}" result="noiseRaw"/>` +
      `<feTile in="noiseRaw" x="${-W}" y="${-H}" width="${3 * W}" height="${3 * H}" result="noiseTiled"/>` +
      off +
      // 金属縞グラデを全域に敷く
      `<feImage href="${stripUrl}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none" result="strip"/>` +
      // 1 段目: 大きく折る（渦の骨格）
      `<feDisplacementMap in="strip" in2="noise" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="warp1"/>` +
      // 2 段目: 細かい turbulence で更に curl させて閉ループ/eddy を作る
      `<feTurbulence type="turbulence" baseFrequency="${freq2} ${freq2}" numOctaves="2" seed="19" stitchTiles="stitch" x="0" y="0" width="${W}" height="${H}" result="noise2"/>` +
      `<feDisplacementMap in="warp1" in2="noise2" scale="${scale2}" xChannelSelector="R" yChannelSelector="G" result="warped"/>` +
      // レイヤー形状に閉じ込め
      `<feComposite in="warped" in2="SourceAlpha" operator="in"/>`
    );
  }

  async function render(v) {
    const primitives = chromeFilter(v);
    const id = `lc_${v.id}`;
    const markup = `<filter id="${id}" color-interpolation-filters="sRGB" x="-10%" y="-10%" width="120%" height="120%">${primitives}</filter>`;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<defs>${markup}</defs><rect width="${W}" height="${H}" fill="#000"/>` +
      `<image href="${contentUrl}" x="0" y="0" width="${W}" height="${H}" style="filter:url(#${id})"/></svg>`;
    const url = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
    const img = new Image();
    img.src = url;
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    const cc = document.createElement("canvas");
    cc.width = W; cc.height = H;
    cc.getContext("2d").fillStyle = "#000"; cc.getContext("2d").fillRect(0, 0, W, H);
    cc.getContext("2d").drawImage(img, 0, 0);
    return cc.toDataURL("image/png");
  }

  // よりシルバー寄り＋青/ピンクのイリデを控えめに
  const silverStops = [
    [0.0, "#0a0c14"], [0.28, "#4a5570"], [0.45, "#e6ecff"],
    [0.50, "#ffffff"], [0.57, "#d8c2d8"], [0.72, "#2a2636"], [1.0, "#0a0c14"],
  ];
  const strip6 = chromeStripUrl(6, silverStops);
  const strip8 = chromeStripUrl(8, silverStops);
  const variants = [
    { id: "A", size: 130, octaves: 3, scale: 150, scale2: 40, stripUrl: strip6, evolution: 0 },
    { id: "B", size: 160, octaves: 3, scale: 200, scale2: 55, stripUrl: strip6, evolution: 0 },
    { id: "C", size: 120, octaves: 3, scale: 170, scale2: 45, stripUrl: strip8, evolution: 0 },
    { id: "A_evo", size: 130, octaves: 3, scale: 150, scale2: 40, stripUrl: strip6, evolution: 120 },
  ];
  const res = {};
  for (const v of variants) res[v.id] = await render(v);
  return res;
});

for (const [id, png] of Object.entries(out)) {
  fs.writeFileSync(`verify-lc-proto-${id}.png`, Buffer.from(png.split(",")[1], "base64"));
}
console.log("wrote:", Object.keys(out).join(", "));
console.log("errors:", errors.length ? errors.slice(0, 8) : "none");
await browser.close();
