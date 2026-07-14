// 目視用: 実物っぽいソース(左に構造・アンチエイリアス縁)に pixelStretch(right) を掛け、
// linePos の位置に赤い 1px ガイド線を重ねた PNG を出力する。seam がガイドと一致するか目視する。
import { chromium } from "playwright";
const PORT = process.env.VERIFY_PORT ?? "5177";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 700, height: 400 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const out = await page.evaluate(async () => {
  const esvg = await import("/src/runtime/effectSvg.ts");
  const rcap = await import("/src/runtime/rasterCapture.ts");
  const W = 480, H = 240;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  c.clearRect(0, 0, W, H);
  // 回転した正方形（ダイヤ）— アンチエイリアス縁を持つ実物風ソース
  c.save();
  c.translate(W * 0.42, H * 0.5);
  c.rotate(Math.PI / 4);
  c.fillStyle = "#5a9bd8";
  c.fillRect(-70, -70, 140, 140);
  c.restore();

  const linePos = 0.45, length = 260, density = 1, direction = "right";
  const line = Math.round(linePos * W);
  const primitives = esvg.pixelStretchPrimitives({ w: W, h: H, direction, linePos, length, density });
  const markup = esvg.svgDisplaceFilterMarkup("p", primitives, W, H, length * 2, true);
  const canvas = await rcap.rasterizeFilteredImage(cv.toDataURL("image/png"), W, H, markup, "url(#p)");
  // ガイド線を重ねる
  const rc = canvas.getContext("2d");
  rc.fillStyle = "rgba(255,0,0,0.9)";
  rc.fillRect(line, 0, 1, H);
  return { png: canvas.toDataURL("image/png"), line, W };
});

const fs = await import("node:fs");
fs.writeFileSync("annotated-right.png", Buffer.from(out.png.split(",")[1], "base64"));
console.log("wrote annotated-right.png  (red guide at line=", out.line, "/ W=", out.W, ")");
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
