// 帯 seam（ストレッチ開始位置）ドリフト計測。ramp で「引いたソース元」が x(帯外)→line(帯) に
// 切り替わる境界 x を length 別に求める。seam が全 length で line 固定なら帯ドリフト無し。
import { chromium } from "playwright";
const PORT = process.env.VERIFY_PORT ?? "5175";
const browser = await chromium.launch();
const page = await browser.newPage({ ignoreHTTPSErrors: true });
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);
const out = await page.evaluate(async () => {
  const esvg = await import("/src/runtime/effectSvg.ts");
  const rcap = await import("/src/runtime/rasterCapture.ts");
  const H = 20, SLOPE = 2, linePos = 0.5;
  const results = [];
  for (const length of [100, 300, 600, 1000, 1500, 2000]) {
    const W = Math.max(700, Math.round(length * 2.2 + 400));
    const line = Math.round(linePos * W);
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const c = cv.getContext("2d"); const id = c.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4; const r = Math.max(0, Math.min(255, Math.round(128 + (x - line) * SLOPE)));
      id.data[o] = r; id.data[o + 1] = r; id.data[o + 2] = r; id.data[o + 3] = 255;
    }
    c.putImageData(id, 0, 0);
    const src = cv.toDataURL("image/png");
    const prims = esvg.pixelStretchPrimitives({ w: W, h: H, direction: "right", linePos, length, density: 1 });
    const maps = esvg.pixelStretchDisplaceMaps({ w: W, h: H, direction: "right", linePos, length, density: 1 });
    const maxScale = maps.stage1.scale + (maps.stage2 ? maps.stage2.scale : 0);
    const markup = esvg.svgDisplaceFilterMarkup("p", prims, W, H, maxScale, true);
    const canvas = await rcap.rasterizeFilteredImage(src, W, H, markup, "url(#p)");
    const px = canvas.getContext("2d").getImageData(0, 0, W, H).data;
    const y = H >> 1;
    const sampled = (x) => (px[(y * W + x) * 4] - 128) / SLOPE + line; // 引いたソース元列
    // 帯外は sampled≈x, 帯は sampled≈line。左から走査し sampled が line 付近で安定し始める x=seam
    let seam = -1;
    for (let x = line - 40; x < line + 60; x++) {
      if (Math.abs(sampled(x) - line) <= 1 && Math.abs(sampled(x + 3) - line) <= 1) { seam = x; break; }
    }
    results.push({ length, line, seam, seamMinusLine: seam - line });
  }
  return results;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
