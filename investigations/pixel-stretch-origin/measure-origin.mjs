// pixelStretch 起点ズレ調査（本番コード無変更）— 実 Chrome の feDisplacementMap 実画素で
// 「帯がどの列を引いたか」「smear の左端(seam)がどこか」を計測し、要求 linePos とのズレを数値化する。
//
// 手法: ソース画像を「列 x を色に符号化」した横グラデにする（R=x&255, B=(x>=256?255:0)）。
// すると出力の各列の色をデコードすれば "その列が引いたソース列 srcX" が判る。
// direction=right / linePos=0.5 / length=120（scale1=240<=255 → 単段, 量子化誤差最小）。
//
// 実行: dev サーバ(https) を起動して VERIFY_PORT を合わせる。例: VERIFY_PORT=5175 node measure-origin.mjs
import { chromium } from "playwright";
const PORT = process.env.VERIFY_PORT ?? "5175";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 700, height: 300 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const out = await page.evaluate(async () => {
  const esvg = await import("/src/runtime/effectSvg.ts");
  const rcap = await import("/src/runtime/rasterCapture.ts");
  const W = 400, H = 20;

  // 列 x を色に符号化: srcX = R + (B>127 ? 256 : 0)
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  const id = c.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      id.data[o] = x % 256;
      id.data[o + 1] = 0;
      id.data[o + 2] = x >= 256 ? 255 : 0;
      id.data[o + 3] = 255;
    }
  }
  c.putImageData(id, 0, 0);
  const src = cv.toDataURL("image/png");

  const direction = "right", linePos = 0.5, density = 1;
  const line = Math.round(linePos * W); // 期待起点

  async function run(length) {
    const primitives = esvg.pixelStretchPrimitives({ w: W, h: H, direction, linePos, length, density });
    const markup = esvg.svgDisplaceFilterMarkup("p", primitives, W, H, length * 2, true);
    const canvas = await rcap.rasterizeFilteredImage(src, W, H, markup, "url(#p)");
    const rc = canvas.getContext("2d");
    const px = rc.getImageData(0, 0, W, H).data;
    const midY = H >> 1;
    const decoded = [];
    for (let x = 0; x < W; x++) {
      const o = (midY * W + x) * 4;
      const a = px[o + 3];
      const srcX = a === 0 ? -1 : px[o] + (px[o + 2] > 127 ? 256 : 0);
      decoded.push(srcX);
    }
    // 最初に「引いた列がその列自身から離れ始める」列 = smear が始まる列
    let seam = -1;
    for (let x = 0; x < W; x++) {
      if (decoded[x] >= 0 && Math.abs(decoded[x] - x) > 1) { seam = x; break; }
    }
    // 帯中央付近が引いたソース列（中央値）
    const bandSamples = [];
    for (let x = line + 20; x <= line + length - 20; x += 5) bandSamples.push(decoded[x]);
    bandSamples.sort((a, b) => a - b);
    const bandSrc = bandSamples.length ? bandSamples[bandSamples.length >> 1] : null;
    return { length, line, seam, seamMinusLine: seam - line, bandSrc, bandSrcMinusLine: bandSrc == null ? null : bandSrc - line, around: decoded.slice(line - 6, line + 10) };
  }

  return { W, runs: [await run(120), await run(300), await run(600)] };
});

console.log(JSON.stringify(out, null, 2));
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
