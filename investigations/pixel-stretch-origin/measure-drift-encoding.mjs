// pixelStretch の length 比例ドリフトを「マップの符号化バイト」から厳密計測する。
// feDisplacementMap の描画（補間・256境界）に一切依存せず、pixelStretchDisplaceMaps が
// 実際に符号化する per-pixel サンプル位置 achieved[i] を PNG バイト直読で復元する。
// 目的: 帯先頭(line)が引くソース位置の drift を length 別に出し、len/255 仮説を検証。
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

  // data URI PNG(n×1 or 1×n) を canvas に 1:1 で描いて R/G バイトを厳密復元
  async function decodeMapChannels(uri, n, horiz) {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = uri;
    });
    const cv = document.createElement("canvas");
    cv.width = horiz ? n : 1;
    cv.height = horiz ? 1 : n;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const R = new Float64Array(n), G = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      R[i] = px[o]; G[i] = px[o + 1];
    }
    return { R, G };
  }

  const direction = "right", linePos = 0.5, density = 1, h = 20;
  const lengths = [100, 300, 600, 1000, 1500, 2000];
  const results = [];

  for (const length of lengths) {
    const w = Math.max(600, Math.round(length * 2.2 + 300));
    const n = w;
    const line = Math.round(linePos * n);
    const { stage1, stage2 } = esvg.pixelStretchDisplaceMaps({ w, h, direction, linePos, length, density });

    const m1 = await decodeMapChannels(stage1.uri, n, true);
    const s1 = stage1.scale;
    // stage1 が符号化する到達位置（R = X変位, 中立128）
    const achieved1 = new Float64Array(n);
    for (let i = 0; i < n; i++) achieved1[i] = i + s1 * (m1.R[i] / 255 - 0.5);

    // stage2 合成（あれば）: 出力i は ps1 を disp2 だけずらして読む → 実サンプルは achieved1[i+disp2]
    let finalPos = achieved1;
    let hasStage2 = false;
    if (stage2) {
      hasStage2 = true;
      const m2 = await decodeMapChannels(stage2.uri, n, true);
      const s2 = stage2.scale;
      finalPos = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const disp2 = s2 * (m2.R[i] / 255 - 0.5);
        const j = Math.max(0, Math.min(n - 1, Math.round(i + disp2)));
        finalPos[i] = achieved1[j];
      }
    }

    // 帯先頭(line)・+5%・中央・末尾での「引いたソース位置 − line」= drift
    const at = (frac) => {
      const i = Math.min(n - 1, line + Math.round(frac * length));
      return +(finalPos[i] - line).toFixed(3);
    };
    results.push({
      length, line, scale1: s1, hasStage2,
      predicted_len_over_255: +(length / 255).toFixed(3),
      driftHead: +(finalPos[line] - line).toFixed(3),
      driftAt5pct: at(0.05),
      driftMid: at(0.5),
      driftTail: at(0.98),
      stage1OnlyHead: +(achieved1[line] - line).toFixed(3),
    });
  }
  return results;
});

console.log(JSON.stringify(out, null, 2));
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
