// pixelStretch (Directional Line Stretch) の実機検証（本番コード無変更）。
// 検証内容: ソースライン上の色が帯全域へ塗り延ばされるか、を Chrome の実 feDisplacementMap で確認する。
//   content = 暗背景 + ソース列(line)に細いシアン縦バー。right/length で右へストレッチ。
//   期待: 帯 [line, line+length] がシアンで満たされ、line 左側は暗いまま（不変）。
// 単体テストは「変位マップの値」を固定するが、本 verify は Chrome が実際にその見た目を出すことを確認する。
import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `https://localhost:${PORT}/`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 700, height: 400 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const out = await page.evaluate(async () => {
  const esvg = await import("/src/runtime/effectSvg.ts");
  const rcap = await import("/src/runtime/rasterCapture.ts");

  const W = 300, H = 120;
  const linePos = 0.3, length = 120, direction = "right";
  const line = Math.round(linePos * W); // 90
  const BAR = 6; // シアン縦バー幅

  // content: 暗背景 + line 中心のシアン縦バー
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  c.fillStyle = "#101018"; c.fillRect(0, 0, W, H);
  c.fillStyle = "#00ffff"; c.fillRect(line - BAR / 2, 0, BAR, H);
  const contentUrl = cv.toDataURL("image/png");

  // pixelStretch filter を組む
  const { uri, scale } = esvg.pixelStretchDisplaceMapPng({ w: W, h: H, direction, linePos, length });
  const primitives = esvg.displaceWithMap(uri, scale, W, H, false);
  const markup = esvg.svgDisplaceFilterMarkup("ps", primitives, W, H, length, true);
  const canvas = await rcap.rasterizeFilteredImage(contentUrl, W, H, markup, "url(#ps)");
  const d = canvas.getContext("2d").getImageData(0, 0, W, H).data;

  // 行中央でサンプルし、各列がシアンか判定
  const isCyan = (x, y) => {
    const i = (y * W + x) * 4;
    return d[i] < 120 && d[i + 1] > 140 && d[i + 2] > 140; // low R, high G, high B
  };
  const y = Math.floor(H / 2);
  let bandCyan = 0, bandTotal = 0, leftCyan = 0, leftTotal = 0;
  for (let x = line + BAR; x < Math.min(line + length, W); x++) { bandTotal++; if (isCyan(x, y)) bandCyan++; }
  for (let x = 0; x < line - BAR; x++) { leftTotal++; if (isCyan(x, y)) leftCyan++; }

  return {
    W, H, line, length,
    bandFillRatio: bandTotal ? bandCyan / bandTotal : 0, // 期待: ~1（帯がシアンで満たされる）
    leftCyanRatio: leftTotal ? leftCyan / leftTotal : 0, // 期待: ~0（左側は不変・暗い）
    png: canvas.toDataURL("image/png"),
  };
});

const fs = await import("node:fs");
fs.writeFileSync("verify-pixel-stretch.png", Buffer.from(out.png.split(",")[1], "base64"));

const pass = out.bandFillRatio > 0.9 && out.leftCyanRatio < 0.05;
console.log(`line=${out.line} length=${out.length}`);
console.log(`band fill (cyan) ratio = ${out.bandFillRatio.toFixed(3)}  (expect >0.9 : 帯がソース色で塗り延ばされる)`);
console.log(`left  cyan     ratio = ${out.leftCyanRatio.toFixed(3)}  (expect <0.05 : ライン手前は不変)`);
console.log(`\n${pass ? "PASS" : "FAIL"}  — pixelStretch directional line stretch`);
console.log("artifact: verify-pixel-stretch.png");
console.log("errors:", errors.length ? errors.slice(0, 6) : "none");
await browser.close();
process.exit(pass ? 0 : 1);
