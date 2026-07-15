// ユーザー実シナリオ再現: 45°斜めソリッド(透明角あり)に pixelStretch(right,lp=0.5,density=1) を掛け、
// length 0→2000 を振って「実レンダのインク位置(seam/bbox/centroid)がドリフトするか」を raster 経路で測る。
// raster = export 経路。ユーザーは export でも drift すると確認済み。
import { chromium } from "playwright";
const PORT = process.env.VERIFY_PORT ?? "5175";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 700, height: 500 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const out = await page.evaluate(async () => {
  const esvg = await import("/src/runtime/effectSvg.ts");
  const rcap = await import("/src/runtime/rasterCapture.ts");
  const W = 480, H = 480;

  function diamond() {
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    c.clearRect(0, 0, W, H);
    c.fillStyle = "#5a9bd8";
    c.save(); c.translate(W / 2, H / 2); c.rotate(Math.PI / 4); c.fillRect(-140, -140, 280, 280); c.restore();
    return cv;
  }
  function alphaStats(px) {
    let minX = W, minY = H, maxX = -1, maxY = -1, sx = 0, sy = 0, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (px[(y * W + x) * 4 + 3] > 20) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; sx += x; sy += y; n++; }
    }
    return { minX, minY, maxX, maxY, cx: n ? +(sx / n).toFixed(1) : -1, cy: n ? +(sy / n).toFixed(1) : -1, n };
  }
  // 中央行で最初に不透明になる列（左端の実体エッジ）
  function seamMidRow(px) {
    const y = H >> 1;
    for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3] > 20) return x;
    return -1;
  }

  const src = diamond().toDataURL("image/png");
  const lengths = [0, 100, 300, 600, 1000, 1500, 2000];
  const rows = [];
  for (const length of lengths) {
    let px;
    if (length === 0) {
      // filter 無効（素通し）と等価: そのままソースを描く
      const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      const img = await new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.src = src; });
      cv.getContext("2d").drawImage(img, 0, 0);
      px = cv.getContext("2d").getImageData(0, 0, W, H).data;
    } else {
      const primitives = esvg.pixelStretchPrimitives({ w: W, h: H, direction: "right", linePos: 0.5, length, density: 1 });
      const maps = esvg.pixelStretchDisplaceMaps({ w: W, h: H, direction: "right", linePos: 0.5, length, density: 1 });
      const maxScale = maps.stage1.scale + (maps.stage2 ? maps.stage2.scale : 0);
      const markup = esvg.svgDisplaceFilterMarkup("p", primitives, W, H, maxScale, true);
      const canvas = await rcap.rasterizeFilteredImage(src, W, H, markup, "url(#p)");
      px = canvas.getContext("2d").getImageData(0, 0, W, H).data;
    }
    const st = alphaStats(px);
    rows.push({ length, seamLeft: seamMidRow(px), minX: st.minX, minY: st.minY, cx: st.cx, cy: st.cy });
  }
  // length=0 基準からの seam/centroid ドリフト
  const base = rows[0];
  return rows.map((r) => ({ ...r, seamDriftVs0: r.seamLeft - base.seamLeft, cxDriftVs0: +(r.cx - base.cx).toFixed(1), cyDriftVs0: +(r.cy - base.cy).toFixed(1) }));
});

console.log(JSON.stringify(out, null, 2));
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
