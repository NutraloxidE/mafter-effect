// pixelStretch 起点ズレ調査（2026-07-14 追加）— length（帯の長さ）を細かく振り、
// 帯の先頭付近（line, line+1, line+2, ...）が実際にどのソース列を引いているかを実 Chrome の
// feDisplacementMap 実画素で計測する。本番コードは一切変更しない（pixelStretchPrimitives を
// そのまま呼ぶのみ、lineBias は渡さない = 0 相当）。
//
// 目的: 「Length が長いと実体（帯の先頭がサンプルする列）がズレる」という仮説の検証。
// 帯が canvas を超えないよう W を length に対して十分大きく取る。
//
// 実行: VERIFY_PORT=5175 node measure-length-sweep.mjs
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
        id.data[o] = x % 256;
        id.data[o + 1] = 0;
        id.data[o + 2] = x >= 256 ? 255 : (x >= 512 ? 128 : 0);
        // encode srcX = R + (B==255?256:0) + (B==128?512:0)  -- supports up to ~768 with 2 flag levels
        id.data[o + 3] = 255;
      }
    }
    c.putImageData(id, 0, 0);
    return cv.toDataURL("image/png");
  }
  function decodeX(px, o) {
    const r = px[o], b = px[o + 2];
    if (b > 200) return r + 256;
    if (b > 90 && b <= 200) return r + 512;
    return r;
  }

  const direction = "right", linePos = 0.5, density = 1;
  const lengths = [20, 60, 100, 127, 128, 150, 200, 250, 300, 350, 400];

  const results = [];
  for (const length of lengths) {
    const W = Math.max(500, Math.round(length * 2.5 + 200));
    const line = Math.round(linePos * W);
    const src = makeSrc(W);
    const primitives = esvg.pixelStretchPrimitives({ w: W, h: H, direction, linePos, length, density });
    const markup = esvg.svgDisplaceFilterMarkup("p", primitives, W, H, length * 2, true);
    const canvas = await rcap.rasterizeFilteredImage(src, W, H, markup, "url(#p)");
    const rc = canvas.getContext("2d");
    const px = rc.getImageData(0, 0, W, H).data;
    const midY = H >> 1;
    const decoded = [];
    for (let x = 0; x < W; x++) {
      const o = (midY * W + x) * 4;
      decoded.push(decodeX(px, o));
    }
    // 帯先頭付近 (line..line+5) が引いたソース列
    const headSamples = [];
    for (let d = 0; d <= 5; d++) headSamples.push(decoded[line + d] - line);
    // 帯中央付近
    const midX = line + Math.round(length / 2);
    const midSample = midX < W ? decoded[midX] - line : null;
    // 帯末尾付近 (band end - 5..band end)
    const tailX = Math.min(W - 1, line + length - 1);
    const tailSample = decoded[tailX] - line;
    results.push({ length, W, line, head: headSamples, mid: midSample, tail: tailSample });
  }
  return results;
});

console.log(JSON.stringify(out, null, 2));
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
