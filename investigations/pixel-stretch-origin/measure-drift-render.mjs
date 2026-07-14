// 実 Chrome の feDisplacementMap 出力で pixelStretch の帯サンプル位置ドリフトを計測。
// ソースは line 中心の緩い輝度ランプ（R=clamp(128+(x-line)*SLOPE)）。スムーズ=bilinear補間が正確、
// 256境界/per列デコードの罠なし。帯ピクセルの出力 R から drift=(R-128)/SLOPE を厳密復元。
// 比較: フルフィルタ(stage1+stage2) vs stage1のみ。stage2 が実効か切り分ける。
import { chromium } from "playwright";
const PORT = process.env.VERIFY_PORT ?? "5175";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 200 }, ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const out = await page.evaluate(async () => {
  const esvg = await import("/src/runtime/effectSvg.ts");
  const rcap = await import("/src/runtime/rasterCapture.ts");
  const H = 20, SLOPE = 2; // 2 code/px → ±63px を分解、0.5px 精度

  function makeRamp(W, line) {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    const id = c.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const r = Math.max(0, Math.min(255, Math.round(128 + (x - line) * SLOPE)));
      id.data[o] = r; id.data[o + 1] = r; id.data[o + 2] = r; id.data[o + 3] = 255;
    }
    c.putImageData(id, 0, 0);
    return cv.toDataURL("image/png");
  }

  const direction = "right", linePos = 0.5, density = 1;
  const lengths = [300, 600, 1000, 1500, 2000];
  const results = [];

  for (const length of lengths) {
    const W = Math.max(600, Math.round(length * 2.2 + 300));
    const line = Math.round(linePos * W);
    const src = makeRamp(W, line);

    const maps = esvg.pixelStretchDisplaceMaps({ w: W, h: H, direction, linePos, length, density });
    // full: 実 primitives（stage1[+stage2]）
    const fullPrims = esvg.pixelStretchPrimitives({ w: W, h: H, direction, linePos, length, density });
    // stage1-only: stage2 を落とした単段
    const feImg = (uri, res) => `<feImage href="${uri}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none" result="${res}"/>`;
    const s1only =
      feImg(maps.stage1.uri, "psA") +
      `<feDisplacementMap in="SourceGraphic" in2="psA" scale="${maps.stage1.scale}" xChannelSelector="R" yChannelSelector="G"/>`;

    const maxScale = maps.stage1.scale + (maps.stage2 ? maps.stage2.scale : 0);
    async function driftOf(prims) {
      const markup = esvg.svgDisplaceFilterMarkup("p", prims, W, H, maxScale, true);
      const canvas = await rcap.rasterizeFilteredImage(src, W, H, markup, "url(#p)");
      const px = canvas.getContext("2d").getImageData(0, 0, W, H).data;
      const midY = H >> 1;
      const readDrift = (x) => (px[(midY * W + x) * 4] - 128) / SLOPE;
      // 帯先頭付近の平均（line..line+10）と数点
      let sum = 0, cnt = 0;
      for (let d = 2; d <= 12; d++) { sum += readDrift(line + d); cnt++; }
      return {
        head: +readDrift(line + 2).toFixed(2),
        headAvg: +(sum / cnt).toFixed(2),
        mid: +readDrift(Math.min(W - 1, line + Math.round(length / 2))).toFixed(2),
      };
    }

    results.push({
      length, line, hasStage2: !!maps.stage2,
      predicted_len_over_255: +(length / 255).toFixed(2),
      full: await driftOf(fullPrims),
      stage1only: await driftOf(s1only),
    });
  }
  return results;
});

console.log(JSON.stringify(out, null, 2));
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
