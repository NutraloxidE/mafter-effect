// プレビュー分数スケール下のストレッチ帯スパイクを切り分ける。
// 仮説: stage2(高周波 per-pixel 補正マップ)が分数スケールでバイリニア補間され、
// 隣接する別々の補正値が混ざってスパイクになる。stage2 を落とすとスパイクが消えるはず。
// 計測: 帯内の各列で「帯の想定色」からの逸脱(スパイク)を縦方向に検出し、列ごとの分散/最大逸脱を出す。
import { chromium } from "playwright";
const PORT = process.env.VERIFY_PORT ?? "5175";
const browser = await chromium.launch({ args: ["--force-color-profile=srgb"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const H = 120;

async function buildCase({ length, density, scale, dropStage2, promote }) {
  const prep = await page.evaluate(async ({ length, density, H, dropStage2 }) => {
    const esvg = await import("/src/runtime/effectSvg.ts");
    const W = Math.max(700, Math.round(length * 1.6 + 200));
    // ソース: 鋭い縦エッジ。sample line(linePos*W)より左=黒, 右=白。
    // 水平ストレッチの帯は各列が「サンプル列(src)の色」を取るはず=全列均一。
    // stage2 の mis-landing で隣の列(黒/白)を取ると縦スパイクとして現れる。
    const line = Math.round(0.25 * W);
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const c = cv.getContext("2d"); const id = c.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const v = x < line ? 30 : 220;
      id.data[o] = v; id.data[o + 1] = v; id.data[o + 2] = v; id.data[o + 3] = 255;
    }
    c.putImageData(id, 0, 0);
    let prims = esvg.pixelStretchPrimitives({ w: W, h: H, direction: "right", linePos: 0.25, length, density });
    // stage2 を落として比較(その primitive チェーンを外部から作れないので、内部関数を叩く)
    if (dropStage2) {
      const maps = esvg.pixelStretchDisplaceMaps({ w: W, h: H, direction: "right", linePos: 0.25, length, density });
      // 手動で stage1 のみのチェーンを組む(pixelStretchPrimitives の stage2 分岐を無効化した版)
      const feImg = (uri, res) => `<feImage href="${uri}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none" result="${res}"/>`;
      const bias = maps.stage1.scale * (128 / 255 - 0.5);
      prims = feImg(maps.stage1.uri, "psA")
        + `<feDisplacementMap in="SourceGraphic" in2="psA" scale="${maps.stage1.scale}" xChannelSelector="R" yChannelSelector="G" result="ps1"/>`
        + `<feOffset in="ps1" dx="${bias}" dy="${bias}"/>`;
    }
    return { W, prims, src: cv.toDataURL("image/png"), line };
  }, { length, density, H, dropStage2 });

  const html = `<div id="wrap" style="position:absolute;left:0;top:0;transform:scale(${scale});transform-origin:0 0${promote ? ";will-change:transform" : ""}">
    <svg width="0" height="0" style="position:absolute"><defs>
      <filter id="ps" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="0" y="0" width="${prep.W}" height="${H}">${prep.prims}</filter>
    </defs></svg>
    <img id="t" src="${prep.src}" width="${prep.W}" height="${H}" style="display:block;filter:url(#ps)"/>
  </div>`;
  await page.setContent(`<body style="margin:0;background:#000">${html}</body>`);
  await page.waitForTimeout(200);
  const buf = await page.locator("#wrap").screenshot();
  const dataUrl = "data:image/png;base64," + buf.toString("base64");

  return await page.evaluate(async ({ dataUrl, line, scale }) => {
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = dataUrl; });
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const cc = cv.getContext("2d", { willReadFrequently: true }); cc.imageSmoothingEnabled = false;
    cc.drawImage(img, 0, 0);
    const W = cv.width, Hh = cv.height;
    const px = cc.getImageData(0, 0, W, Hh).data;
    // 帯内(sample line より右)の各列の中央行の明るさを読む。理想=均一。
    // スパイク = 列ごとの急な明るさ変動(隣列との差)。
    const my = Math.floor(Hh / 2);
    const lineDev = Math.round(line * scale);
    const cols = [];
    for (let x = lineDev + 4; x < W - 2; x++) cols.push(px[(my * W + x) * 4]);
    let maxJump = 0, jumps = 0;
    for (let i = 1; i < cols.length; i++) {
      const d = Math.abs(cols[i] - cols[i - 1]);
      if (d > maxJump) maxJump = d;
      if (d > 20) jumps++;
    }
    const mean = cols.reduce((s, v) => s + v, 0) / (cols.length || 1);
    return { imgW: W, bandMean: +mean.toFixed(1), maxJump, spikeJumps: jumps, cols: cols.length };
  }, { dataUrl, line: prep.line, scale });
}

const out = [];
for (const length of [400, 800]) {
  for (const scale of [0.5, 1.5]) {
    const full = await buildCase({ length, density: 1, scale, dropStage2: false, promote: false });
    const promoted = await buildCase({ length, density: 1, scale, dropStage2: false, promote: true });
    out.push({ length, scale, full, promoted });
  }
}
console.log(JSON.stringify(out, null, 2));
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
