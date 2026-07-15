// デバッグ: length=350 の異常値（-256）が実際の feDisplacementMap 挙動なのか、
// 計測スクリプトの符号化/デコードの不備なのかを切り分ける。生ピクセルを直接ダンプする。
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
  const direction = "right", linePos = 0.5, density = 1, length = 350;
  const W = 1075;
  const line = Math.round(linePos * W); // 538

  // ソース: 各列に一意な色。x を 3byte (R=high,G=mid,B=low, 8bit each, but x<1075 so R always 0..4)
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
  const src = cv.toDataURL("image/png");

  const primitives = esvg.pixelStretchPrimitives({ w: W, h: H, direction, linePos, length, density });
  const markup = esvg.svgDisplaceFilterMarkup("p", primitives, W, H, length * 2, true);
  const canvas = await rcap.rasterizeFilteredImage(src, W, H, markup, "url(#p)");
  const rc = canvas.getContext("2d");
  const px = rc.getImageData(0, 0, W, H).data;
  const midY = H >> 1;

  function decodedAt(x) {
    const o = (midY * W + x) * 4;
    const r = px[o], g = px[o + 1], b = px[o + 2], a = px[o + 3];
    return { x, r, g, b, a, val: (r << 16) | (g << 8) | b };
  }

  const dump = [];
  for (let d = -3; d <= 8; d++) dump.push(decodedAt(line + d));

  // also check what's really at x=line-256 and x=line in the SOURCE (sanity, should equal the encoding formula)
  const srcCheck = { atLine: line, atLineMinus256: line - 256 };

  return { line, W, length, dump, srcCheck };
});

console.log(JSON.stringify(out, null, 2));
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
