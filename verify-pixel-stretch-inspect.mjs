// 調査（本番コード無変更）: 現状 pixelStretch を構造的ソース（縦ストライプ幅バリエーション + 文字）
// に down/right で適用し、"太いコピー"の正体（1px線の櫛歯か / 太いブロックコピーか）を実機で見る。
import { chromium } from "playwright";
const PORT = process.env.VERIFY_PORT ?? "5173";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 700 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const out = await page.evaluate(async () => {
  const esvg = await import("/src/runtime/effectSvg.ts");
  const rcap = await import("/src/runtime/rasterCapture.ts");
  const W = 320, H = 200;

  // 構造的ソース: 上部に文字風の縦ストローク列（太さ変化）+ カラフルな縦ストライプ
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  c.fillStyle = "#0b0b12"; c.fillRect(0, 0, W, H);
  // カラフル縦ストライプ（幅を変えて "太さ" の写り方を見る）
  const cols = ["#ff3366", "#33ff88", "#3388ff", "#ffcc22", "#ff66ff"];
  let x = 20;
  for (let k = 0; k < 12; k++) {
    c.fillStyle = cols[k % cols.length];
    const wdt = 4 + (k % 4) * 6; // 4,10,16,22 px
    c.fillRect(x, 20, wdt, 40); // 上部の帯（source 行 y=40 付近を横切る）
    x += wdt + 8;
  }
  const src = cv.toDataURL("image/png");

  async function run(direction, linePos, length) {
    const { uri, scale } = esvg.pixelStretchDisplaceMapPng({ w: W, h: H, direction, linePos, length });
    const primitives = esvg.displaceWithMap(uri, scale, W, H, false);
    const markup = esvg.svgDisplaceFilterMarkup("p", primitives, W, H, length, true);
    const canvas = await rcap.rasterizeFilteredImage(src, W, H, markup, "url(#p)");
    return canvas.toDataURL("image/png");
  }

  return {
    src,
    down: await run("down", 40 / H, 140),   // 上部の帯(y~40)を下へストレッチ
    right: await run("right", 0.25, 180),   // 左の帯を右へ
  };
});

const fs = await import("node:fs");
const dec = (u) => Buffer.from(u.split(",")[1], "base64");
fs.writeFileSync("verify-ps-src.png", dec(out.src));
fs.writeFileSync("verify-ps-down.png", dec(out.down));
fs.writeFileSync("verify-ps-right.png", dec(out.right));
console.log("artifacts: verify-ps-src.png / verify-ps-down.png / verify-ps-right.png");
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
