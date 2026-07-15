// pixelStretch: length を広く振り、帯先頭(line)・中央・末尾が実際に引くソース列を
// 頑健な 3byte 符号化（R=x>>16,G=(x>>8)&255,B=x&255）で厳密計測する。本番コード無変更。
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
  const H = 20;

  function makeSrc(W) {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    const id = c.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        id.data[o] = (x >> 16) & 255;
        id.data[o + 1] = (x >> 8) & 255;
        id.data[o + 2] = x & 255;
        id.data[o + 3] = 255;
      }
    }
    c.putImageData(id, 0, 0);
    return cv.toDataURL("image/png");
  }
  function decodeAt(px, W, y, x) {
    const o = (y * W + x) * 4;
    return (px[o] << 16) | (px[o + 1] << 8) | px[o + 2];
  }

  const direction = "right", linePos = 0.5, density = 1;
  const lengths = [20, 60, 100, 127, 128, 150, 200, 250, 300, 350, 400, 500, 700, 900, 1200];

  const results = [];
  for (const length of lengths) {
    const W = Math.max(600, Math.round(length * 2.2 + 300));
    const line = Math.round(linePos * W);
    const src = makeSrc(W);
    const primitives = esvg.pixelStretchPrimitives({ w: W, h: H, direction, linePos, length, density });
    const markup = esvg.svgDisplaceFilterMarkup("p", primitives, W, H, length * 2, true);
    const canvas = await rcap.rasterizeFilteredImage(src, W, H, markup, "url(#p)");
    const rc = canvas.getContext("2d");
    const px = rc.getImageData(0, 0, W, H).data;
    const midY = H >> 1;
    const head = [];
    for (let d = 0; d <= 5; d++) head.push(decodeAt(px, W, midY, line + d) - line);
    const midX = Math.min(W - 1, line + Math.round(length / 2));
    const mid = decodeAt(px, W, midY, midX) - line;
    const tailX = Math.min(W - 1, line + length - 1);
    const tail = decodeAt(px, W, midY, tailX) - line;
    results.push({ length, W, line, head, mid, tail });
  }
  return results;
});

console.log(JSON.stringify(out, null, 2));
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
