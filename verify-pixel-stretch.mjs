// pixelStretch (Directional Line Stretch) の実機検証（本番コード無変更）。
// 検証内容: Chrome の実 feDisplacementMap（1〜2 段チェーン）で
//   (A) density=1 … 帯全域がソースライン 1 列の色で塗り延ばされる（完全ストレッチ・pic2）
//   (B) density=0 … ライン起点の 64px ストリップが反復コピーされる（スライス反復・pic1 系）
// を確認する。content は 8px 幅のカラー縦ストライプ（列ごとに色が変わる）で、
// 「ライン列の色と一致する帯内ピクセルの割合」が density=1 で ~1、density=0 で低くなることを見る。
import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `https://localhost:${PORT}/`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 500 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const out = await page.evaluate(async () => {
  const esvg = await import("/src/runtime/effectSvg.ts");
  const rcap = await import("/src/runtime/rasterCapture.ts");

  const W = 500, H = 120;
  const linePos = 0.3, length = 300, direction = "right";
  const line = Math.round(linePos * W); // 150

  // content: 8px 幅のカラー縦ストライプ（パレット4色）— 列位置で色が識別できる
  const PALETTE = ["#e74c3c", "#2ecc71", "#3498db", "#f1c40f"];
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  for (let x = 0; x < W; x += 8) {
    c.fillStyle = PALETTE[Math.floor(x / 8) % PALETTE.length];
    c.fillRect(x, 0, 8, H);
  }
  const contentUrl = cv.toDataURL("image/png");
  const lineColor = c.getImageData(line, Math.floor(H / 2), 1, 1).data;

  async function run(density) {
    const primitives = esvg.pixelStretchPrimitives({ w: W, h: H, direction, linePos, length, density });
    const markup = esvg.svgDisplaceFilterMarkup("ps", primitives, W, H, length, true);
    const canvas = await rcap.rasterizeFilteredImage(contentUrl, W, H, markup, "url(#ps)");
    const d = canvas.getContext("2d").getImageData(0, 0, W, H).data;
    const y = Math.floor(H / 2);
    const near = (i, ref) =>
      Math.abs(d[i] - ref[0]) < 40 && Math.abs(d[i + 1] - ref[1]) < 40 && Math.abs(d[i + 2] - ref[2]) < 40;
    let matchLine = 0, total = 0, leftIntact = 0, leftTotal = 0;
    for (let x = line + 4; x < Math.min(line + length - 4, W); x++) {
      total++;
      if (near((y * W + x) * 4, lineColor)) matchLine++;
    }
    // ライン手前は元のストライプのまま（元 content の同座標色と一致するか）
    const src = c.getImageData(0, y, W, 1).data;
    for (let x = 4; x < line - 4; x++) {
      leftTotal++;
      if (near((y * W + x) * 4, [src[x * 4], src[x * 4 + 1], src[x * 4 + 2]])) leftIntact++;
    }
    return {
      density,
      lineColorRatio: total ? matchLine / total : 0,
      leftIntactRatio: leftTotal ? leftIntact / leftTotal : 0,
      png: canvas.toDataURL("image/png"),
    };
  }

  return { line, length, full: await run(1), slice: await run(0) };
});

const fs = await import("node:fs");
fs.writeFileSync("verify-pixel-stretch-full.png", Buffer.from(out.full.png.split(",")[1], "base64"));
fs.writeFileSync("verify-pixel-stretch-slice.png", Buffer.from(out.slice.png.split(",")[1], "base64"));

// density=1: 帯はライン 1 列の色一色（>0.9）。density=0: 64px ストリップ反復なので
// ライン色と一致するのはストリップ内の該当ストライプ分だけ（<0.6）。左側はどちらも不変。
const passFull = out.full.lineColorRatio > 0.9 && out.full.leftIntactRatio > 0.9;
const passSlice = out.slice.lineColorRatio < 0.6 && out.slice.leftIntactRatio > 0.9;
console.log(`line=${out.line} length=${out.length}`);
console.log(`density=1  band==lineColor ratio = ${out.full.lineColorRatio.toFixed(3)}  (expect >0.9)  left intact = ${out.full.leftIntactRatio.toFixed(3)}`);
console.log(`density=0  band==lineColor ratio = ${out.slice.lineColorRatio.toFixed(3)}  (expect <0.6)  left intact = ${out.slice.leftIntactRatio.toFixed(3)}`);
console.log(`\n${passFull && passSlice ? "PASS" : "FAIL"}  — pixelStretch density (full smear vs slice repeat)`);
console.log("artifacts: verify-pixel-stretch-full.png / verify-pixel-stretch-slice.png");
console.log("errors:", errors.length ? errors.slice(0, 6) : "none");
await browser.close();
process.exit(passFull && passSlice ? 0 : 1);
