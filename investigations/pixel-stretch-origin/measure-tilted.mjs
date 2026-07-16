// 斜め solid(ダイヤ) を含む複数ソースで、box 中心 vs ink 中心のズレと、
// pixelStretch が実際に引いた列/行を実測。ink は alpha から直接計算（screenshot 不要＝信頼できる）。
//
// 仮説の精緻化: バイアスの決定因は「ink inset が非対称か」。
//  - full solid: inset 0 → bias 0
//  - centered diamond(斜め solid): inset は対称 → bias 0（← ユーザー確認ポイント）
//  - text 風(上/左に偏る): 非対称 inset → bias あり
import { chromium } from "playwright";
const PORT = process.env.VERIFY_PORT ?? "5177";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 700, height: 500 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const out = await page.evaluate(async () => {
  const esvg = await import("/src/runtime/effectSvg.ts");
  const rcap = await import("/src/runtime/rasterCapture.ts");
  const W = 400, H = 400;

  function draw(kind) {
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    c.clearRect(0, 0, W, H);
    c.fillStyle = "#5a9bd8";
    if (kind === "solid") c.fillRect(0, 0, W, H);
    else if (kind === "diamond") { // 中央の斜め正方形（＝斜め solid 相当・対称 inset）
      c.save(); c.translate(W / 2, H / 2); c.rotate(Math.PI / 4); c.fillRect(-120, -120, 240, 240); c.restore();
    } else if (kind === "diamond_offset") { // 中心をずらしたダイヤ（非対称 inset）
      c.save(); c.translate(W * 0.35, H * 0.35); c.rotate(Math.PI / 4); c.fillRect(-90, -90, 180, 180); c.restore();
    } else if (kind === "textlike") { // 上/左に偏る塗り（text の ascent/side-bearing 近似）
      c.fillRect(40, 90, 210, 150); // left=40, top=90（下/右に余白）
    }
    return cv;
  }

  // alpha から ink bbox を直接計算
  function inkBox(cv) {
    const c = cv.getContext("2d");
    const px = c.getImageData(0, 0, W, H).data;
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (px[(y * W + x) * 4 + 3] > 10) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    return { left: minX, top: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  // pixelStretch(right, linePos) を掛けて、中央行が実際に引いた「x 位置の元 alpha」から
  // smear 起点(seam=不透明が一様に始まる列)を測る。ソースが単色なので色でなく alpha 遷移で見る。
  async function seamOf(cv, direction, linePos, length) {
    const src = cv.toDataURL("image/png");
    const primitives = esvg.pixelStretchPrimitives({ w: W, h: H, direction, linePos, length, density: 1 });
    const markup = esvg.svgDisplaceFilterMarkup("p", primitives, W, H, length * 2, true);
    const canvas = await rcap.rasterizeFilteredImage(src, W, H, markup, "url(#p)");
    return canvas;
  }

  const kinds = ["solid", "diamond", "diamond_offset", "textlike"];
  const res = {};
  const linePosList = [0.15, 0.25, 0.5, 0.75, 0.85];
  for (const k of kinds) {
    const cv = draw(k);
    const ink = inkBox(cv);
    // 横方向: box 基準 line = lp*W。ink 基準の望ましい line = ink.left + lp*ink.w。
    // bias(px) = box基準 - ink基準 = lp*W - (ink.left + lp*ink.w)（負なら原点方向へ寄る＝左すぎ）
    const biasX = {};
    for (const lp of linePosList) biasX[lp] = Math.round(lp * W - (ink.left + lp * ink.w));
    const biasY = {};
    for (const lp of linePosList) biasY[lp] = Math.round(lp * H - (ink.top + lp * ink.h));
    res[k] = { ink, biasX_over_linePos: biasX, biasY_over_linePos: biasY };
  }
  return res;
});

console.log(JSON.stringify(out, null, 2));
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
