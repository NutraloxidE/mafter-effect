// プロトタイプ（本番コード無変更）: density = 引き伸ばし方向に直交する smear（feGaussianBlur を
// 直交軸だけに掛ける）で、硬いバー(selected-range copy) → 滑らかなピクセルストレッチ(pic2) に
// なるかを実機で確認する。down ストレッチなら直交 = 横方向 (stdDeviation x のみ)。
import { chromium } from "playwright";
const PORT = process.env.VERIFY_PORT ?? "5173";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 500 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const out = await page.evaluate(async () => {
  const esvg = await import("/src/runtime/effectSvg.ts");
  const rcap = await import("/src/runtime/rasterCapture.ts");
  const W = 320, H = 200;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  c.fillStyle = "#0b0b12"; c.fillRect(0, 0, W, H);
  const cols = ["#ff3366", "#33ff88", "#3388ff", "#ffcc22", "#ff66ff"];
  let x = 20;
  for (let k = 0; k < 12; k++) { c.fillStyle = cols[k % cols.length]; const wdt = 4 + (k % 4) * 6; c.fillRect(x, 20, wdt, 40); x += wdt + 8; }
  const src = cv.toDataURL("image/png");

  // down ストレッチ + 直交(横)方向 smear。smearPx が density の代理。
  async function run(smearPx) {
    const direction = "down", linePos = 40 / H, length = 140;
    const { uri, scale } = esvg.pixelStretchDisplaceMapPng({ w: W, h: H, direction, linePos, length });
    // displaceWithMap 相当を手組みし、displaced 結果に直交軸だけの blur を後段追加
    const disp =
      `<feImage href="${uri}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none" result="dm"/>` +
      `<feDisplacementMap in="SourceGraphic" in2="dm" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="st"/>` +
      (smearPx > 0
        ? `<feGaussianBlur in="st" stdDeviation="${smearPx} 0" edgeMode="duplicate" result="sm"/><feComposite in="sm" in2="SourceGraphic" operator="in"/>`
        : `<feComposite in="st" in2="SourceGraphic" operator="in"/>`);
    const markup = esvg.svgDisplaceFilterMarkup("p", disp, W, H, length, true);
    const canvas = await rcap.rasterizeFilteredImage(src, W, H, markup, "url(#p)");
    return canvas.toDataURL("image/png");
  }
  return { d0: await run(0), d1: await run(6), d2: await run(16) };
});

const fs = await import("node:fs");
const dec = (u) => Buffer.from(u.split(",")[1], "base64");
fs.writeFileSync("verify-ps-density-0.png", dec(out.d0));
fs.writeFileSync("verify-ps-density-6.png", dec(out.d1));
fs.writeFileSync("verify-ps-density-16.png", dec(out.d2));
console.log("artifacts: verify-ps-density-0/6/16.png (smear 0 / 6 / 16 px)");
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
