// lineBias 検証: 帯開始位置(seam)は linePos 固定のまま、引くソース列だけが lineBias 分ずれること。
// ramp ソース(R=128+(x-line)*2)で、帯内が引いた実ソース列 = (R-128)/2 + line を復元。
import { chromium } from "playwright";
const PORT = process.env.VERIFY_PORT ?? "5175";
const browser = await chromium.launch();
const page = await browser.newPage({ ignoreHTTPSErrors: true });
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);
const out = await page.evaluate(async () => {
  const esvg = await import("/src/runtime/effectSvg.ts");
  const rcap = await import("/src/runtime/rasterCapture.ts");
  const W = 900, H = 20, SLOPE = 2, length = 300, linePos = 0.5;
  const line = Math.round(linePos * W);
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const c = cv.getContext("2d"); const id = c.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4; const r = Math.max(0, Math.min(255, Math.round(128 + (x - line) * SLOPE)));
    id.data[o] = r; id.data[o + 1] = r; id.data[o + 2] = r; id.data[o + 3] = 255;
  }
  c.putImageData(id, 0, 0);
  const src = cv.toDataURL("image/png");
  const run = async (lineBias) => {
    const prims = esvg.pixelStretchPrimitives({ w: W, h: H, direction: "right", linePos, length, density: 1, lineBias });
    const maps = esvg.pixelStretchDisplaceMaps({ w: W, h: H, direction: "right", linePos, length, density: 1, lineBias });
    const maxScale = maps.stage1.scale + (maps.stage2 ? maps.stage2.scale : 0);
    const markup = esvg.svgDisplaceFilterMarkup("p", prims, W, H, maxScale, true);
    const canvas = await rcap.rasterizeFilteredImage(src, W, H, markup, "url(#p)");
    const px = canvas.getContext("2d").getImageData(0, 0, W, H).data;
    const y = H >> 1;
    // 帯中央(line+150)が引いた実ソース列
    const readSrc = (x) => (px[(y * W + x) * 4] - 128) / SLOPE + line;
    return { sampledSrcAtBandMid: +readSrc(line + 150).toFixed(1), sampledSrcAtBandHead: +readSrc(line + 3).toFixed(1) };
  };
  return { line, lb0: await run(0), lb40: await run(40), lbm40: await run(-40) };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
