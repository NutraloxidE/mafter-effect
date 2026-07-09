// Spike (本番コード無変更): Fast* distortion を raster なし（nested-filter / world-host CSS filter）
// で適用したときの ink centroid ドリフトを、本番 raster 経路（rasterizeFilteredImage）と比較する。
//   - nested : 外 div=transform / 内 div=content + filter:url(#fx)  → filter を local 無変換空間に閉じ込め
//   - world  : transform と filter:url(#fx) を同一 div に  → 旧 CSS-filter-直適用の再現
//   - raster : rasterizeFilteredImage(image, filter) = 本番 self-capture raster の filter 適用核
// nested/world は実機コンポジタ出力を Playwright screenshot で、raster は in-browser canvas で計測。
// 判定: map系(fastWave/fastRipple) の drift が全 amount ≤2px なら raster なし化 viable。
import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `http://localhost:${PORT}/`;
const AMOUNTS = [0, 50, 100, 155];
const EFFECTS = ["fastWave", "fastRipple", "fastTurbulentDisplace"];
// live(nested) は identity transform で raster と apples-to-apples に比較する。
// （前 run で nested==world と確認済み: CSS filter は常に local 空間適用で transform nest は無影響）
const VW = 1320, VH = 1000;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

// ── evaluate #1: build nested/world DOM grid + measure raster control numerically ──
const setup = await page.evaluate(async ({ AMOUNTS, EFFECTS }) => {
  const esvg = await import("/src/runtime/effectSvg.ts");
  const rcap = await import("/src/runtime/rasterCapture.ts");

  const W = 200, H = 200;            // filter 適用領域（local userSpace）— displacement の余白を確保
  const BOX = 70;                    // 白ボックス（centroid 計測対象）
  const BOFF = (W - BOX) / 2;        // box offset within filter area
  const CELL_W = 300, CELL_H = 300;  // セル枠（overflow hidden で隣を汚さない）
  const GX = 8, GY = 8;              // grid 原点
  const PAD_IN = { x: (CELL_W - W) / 2, y: (CELL_H - H) / 2 };
  const WORLD_TF = "none";           // identity: live CSS filter を local 空間で raster と直接比較

  // effect → {primitives, scale} を返す
  function buildFx(effect, amount) {
    if (effect === "fastWave") {
      const { uri, scale } = esvg.waveDisplaceMapSvg(amount, 40, "horizontal", 0, W, H, esvg.WAVE_FAST_QUALITY);
      return { primitives: esvg.displaceWithMap(uri, scale, W, H, false), scale };
    }
    if (effect === "fastRipple") {
      const { uri, scale } = esvg.rippleDisplaceMapSvg(70, amount, 5, 0.5, 0.5, W, H);
      return { primitives: esvg.displaceWithMap(uri, scale, W, H, false), scale };
    }
    // fastTurbulentDisplace: amount = scale 直結
    const prim = esvg.fastTurbulentDisplace({
      amount, size: 60, complexity: 2, evolution: 0, offsetX: 0, offsetY: 0, randomSeed: 0, w: W, h: H, antiAlias: false,
    });
    return { primitives: prim, scale: amount };
  }

  // ── raster 対照: 白ボックス画像に filter を適用（本番 applyCssSvgFilterToBuffer と同核）──
  const boxCanvas = document.createElement("canvas");
  boxCanvas.width = W; boxCanvas.height = H;
  const bctx = boxCanvas.getContext("2d");
  bctx.fillStyle = "#fff";
  bctx.fillRect(BOFF, BOFF, BOX, BOX);
  const boxUrl = boxCanvas.toDataURL("image/png");

  function centroidOf(data, w, h, x0, y0, x1, y1) {
    let ink = 0, sx = 0, sy = 0, minX = w, maxX = 0;
    const rightEdges = [];
    for (let y = y0; y < y1; y++) {
      let rx = -1;
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (data[i + 3] > 8 && lum > 24) {
          ink++; sx += x; sy += y;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          rx = x;
        }
      }
      if (rx >= 0) rightEdges.push(rx);
    }
    let edgeStd = 0;
    if (rightEdges.length > 1) {
      const m = rightEdges.reduce((a, b) => a + b, 0) / rightEdges.length;
      edgeStd = Math.sqrt(rightEdges.reduce((a, b) => a + (b - m) ** 2, 0) / rightEdges.length);
    }
    return { ink, cx: ink ? sx / ink : 0, cy: ink ? sy / ink : 0, edgeStd, bw: ink ? maxX - minX + 1 : 0 };
  }

  const raster = {};
  for (const effect of EFFECTS) {
    raster[effect] = [];
    for (const amount of AMOUNTS) {
      const { primitives, scale } = buildFx(effect, amount);
      const markup = esvg.svgDisplaceFilterMarkup("rf", primitives, W, H, Math.abs(scale), false);
      const canvas = await rcap.rasterizeFilteredImage(boxUrl, W, H, markup, "url(#rf)");
      const d = canvas.getContext("2d").getImageData(0, 0, W, H).data;
      raster[effect].push(centroidOf(d, W, H, 0, 0, W, H));
    }
  }

  // ── nested / world DOM grid を画面に構築（screenshot で計測）──
  const root = document.createElement("div");
  root.style.cssText = `position:fixed;left:0;top:0;width:100vw;height:100vh;background:#000;z-index:2147483600;`;
  document.body.appendChild(root);
  const svgDefs = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svgDefs.setAttribute("width", "0"); svgDefs.setAttribute("height", "0");
  svgDefs.style.cssText = "position:absolute";
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svgDefs.appendChild(defs);
  root.appendChild(svgDefs);

  const PATHS = ["nested"];
  const cells = [];
  let row = 0;
  for (const effect of EFFECTS) {
    for (const path of PATHS) {
      for (let col = 0; col < AMOUNTS.length; col++) {
        const amount = AMOUNTS[col];
        const slotX = GX + col * CELL_W;
        const slotY = GY + row * CELL_H;
        const fid = `f_${effect}_${path}_${amount}`.replace(/[^a-zA-Z0-9_]/g, "");
        const { primitives, scale } = buildFx(effect, amount);
        // compFixed=true: filter region を layer 実寸(W×H)にクランプ → pad 帯の未定義 map による
        // 定数変位ドラッグを消し、raster(出力 W×H クリップ)と幾何整合させる。
        defs.innerHTML += esvg.svgDisplaceFilterMarkup(fid, primitives, W, H, Math.abs(scale), true);

        const slot = document.createElement("div");
        slot.style.cssText = `position:absolute;left:${slotX}px;top:${slotY}px;width:${CELL_W}px;height:${CELL_H}px;overflow:hidden;`;

        const box = `<div style="position:absolute;left:${BOFF}px;top:${BOFF}px;width:${BOX}px;height:${BOX}px;background:#fff;"></div>`;
        if (path === "nested") {
          // outer transform / inner filter(local)
          slot.innerHTML =
            `<div style="position:absolute;left:${PAD_IN.x}px;top:${PAD_IN.y}px;width:${W}px;height:${H}px;transform:${WORLD_TF};transform-origin:center;">` +
              `<div style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;filter:url(#${fid});">${box}</div>` +
            `</div>`;
        } else {
          // transform + filter on same element
          slot.innerHTML =
            `<div style="position:absolute;left:${PAD_IN.x}px;top:${PAD_IN.y}px;width:${W}px;height:${H}px;transform:${WORLD_TF};transform-origin:center;filter:url(#${fid});">${box}</div>`;
        }
        root.appendChild(slot);
        cells.push({ effect, path, amount, col, row, slotX, slotY, cw: CELL_W, ch: CELL_H });
      }
      row++;
    }
  }

  return { cells, raster, W, H, BOX, CELL_W, CELL_H, GX, GY, rows: row };
}, { AMOUNTS, EFFECTS });

await page.waitForTimeout(500);

// ── 実機 screenshot（コンポジタ出力・CSS filter 忠実）──
const shotBuf = await page.screenshot({ clip: { x: 0, y: 0, width: VW, height: VH } });
const shotB64 = shotBuf.toString("base64");
const fs = await import("node:fs");
fs.writeFileSync("verify-fast-drift-spike.png", shotBuf);

// ── evaluate #2: screenshot を decode して nested/world cell の centroid 計測 ──
const measured = await page.evaluate(async ({ shotB64, cells }) => {
  const img = new Image();
  img.src = "data:image/png;base64," + shotB64;
  await new Promise((r, j) => { img.onload = r; img.onerror = j; });
  const cv = document.createElement("canvas");
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const cx2 = cv.getContext("2d");
  cx2.drawImage(img, 0, 0);
  const W = cv.width, H = cv.height;
  const data = cx2.getImageData(0, 0, W, H).data;

  function centroid(x0, y0, x1, y1) {
    let ink = 0, sx = 0, sy = 0, minX = W, maxX = 0;
    const rightEdges = [];
    for (let y = y0; y < y1; y++) {
      let rx = -1;
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum > 40) { ink++; sx += x; sy += y; if (x < minX) minX = x; if (x > maxX) maxX = x; rx = x; }
      }
      if (rx >= 0) rightEdges.push(rx);
    }
    let edgeStd = 0;
    if (rightEdges.length > 1) {
      const m = rightEdges.reduce((a, b) => a + b, 0) / rightEdges.length;
      edgeStd = Math.sqrt(rightEdges.reduce((a, b) => a + (b - m) ** 2, 0) / rightEdges.length);
    }
    return { ink, cx: ink ? sx / ink : 0, cy: ink ? sy / ink : 0, edgeStd, bw: ink ? maxX - minX + 1 : 0 };
  }

  return cells.map((c) => {
    const m = centroid(c.slotX, c.slotY, c.slotX + c.cw, c.slotY + c.ch);
    // slot 相対 centroid に正規化（各セルは別 slot 位置にあるため絶対座標のままだと隣セル分ずれる）
    return {
      effect: c.effect, path: c.path, amount: c.amount,
      m: { ...m, cx: m.cx - c.slotX, cy: m.cy - c.slotY },
    };
  });
}, { shotB64, cells: setup.cells });

// ── 集計: drift = |centroid - amount0 baseline| (同 effect/path 行) ──
const r2 = (n) => Math.round(n * 100) / 100;
function driftTable(label, getCell) {
  console.log(`\n=== ${label} : ink centroid drift vs amount=0 baseline (px) ===`);
  console.log("effect".padEnd(22) + AMOUNTS.map((a) => `a${a}`.padStart(9)).join("") + "   (edgeStd@max)");
  for (const effect of EFFECTS) {
    const base = getCell(effect, 0);
    const cells0 = AMOUNTS.map((a) => getCell(effect, a));
    const drifts = cells0.map((c) => (c && base && c.ink > 30 && base.ink > 30)
      ? r2(Math.hypot(c.cx - base.cx, c.cy - base.cy)) : NaN);
    const lastEdge = cells0[cells0.length - 1];
    console.log(
      effect.padEnd(22) +
      drifts.map((d) => (Number.isNaN(d) ? "  n/a" : String(d)).padStart(9)).join("") +
      `   ${lastEdge ? r2(lastEdge.edgeStd) : "?"}`,
    );
  }
}

const byKey = {};
for (const r of measured) byKey[`${r.effect}|${r.path}|${r.amount}`] = r.m;
driftTable("RASTER (本番核 rasterizeFilteredImage)", (e, a) => setup.raster[e][AMOUNTS.indexOf(a)]);
driftTable("LIVE CSS filter (raster なし・identity transform)", (e, a) => byKey[`${e}|nested|${a}`]);

console.log("\n=== sanity: distortion 実効性（edgeStd, amount=0 → max）===");
for (const effect of EFFECTS) {
  const rE0 = setup.raster[effect][0].edgeStd, rEm = setup.raster[effect].at(-1).edgeStd;
  console.log(`${effect.padEnd(22)} raster edgeStd ${r2(rE0)} → ${r2(rEm)}`);
}
console.log("\nartifact: verify-fast-drift-spike.png");
console.log("errors:", errors.length ? errors.slice(0, 8) : "none");

await browser.close();
