// feTile 追加後の liquidChrome INV-2 検証（信頼できる実 DomRenderer 経路・D-2 spike と同方式）。
// 手組み container + captureElementToCanvas は foreignObject シリアライズが黒落ちする既知のハーネス
// 制約があるため使わない。実登録済み "liquidChrome" を最小 in-memory comp で DomRenderer に流し、
// (a) on-screen mount の実ブラウザ合成（page.screenshot）と (b) offscreen DomRenderer +
// captureElementToCanvas（export 経路）を同一フレームで取得して画素比較する。
import { chromium } from "playwright";
import fs from "node:fs";

const PORT = process.env.VERIFY_PORT ?? "5175";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 500, height: 400 }, ignoreHTTPSErrors: true });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`https://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

async function runAt(evolution) {
  const setup = await page.evaluate(async ({ evolution }) => {
    const { DomRenderer } = await import("/src/runtime/DomRenderer.ts");
    const { resolve } = await import("/src/runtime/resolve.ts");
    const { registerBuiltinEffects } = await import("/src/runtime/builtinEffects.ts");
    registerBuiltinEffects();
    const { captureElementToCanvas } = await import("/src/runtime/rasterCapture.ts");

    const W = 300, H = 200;
    const sp = (v) => ({ value: v, keyframes: [] });
    const comp = {
      id: "c", kind: "timeline", name: "c", width: W, height: H, fps: 30, duration: 30,
      backgroundColor: { r: 0, g: 0, b: 0, a: 1 },
      objects: [{
        id: "o", name: "o", parent: null, zOrder: 0, enabled: true, inPoint: 0, outPoint: 30,
        transform: { anchor: sp({ x: 0, y: 0, z: 0 }), position: sp({ x: 0, y: 0, z: 0 }), rotation: sp({ x: 0, y: 0, z: 0 }), scale: sp({ x: 1, y: 1, z: 1 }) },
        opacity: sp(1), isNull: false,
        components: [{ type: "solid", props: { color: sp({ r: 0.5, g: 0.5, b: 0.5, a: 1 }), size: sp({ x: W, y: H, z: 0 }) } }],
        effects: [{ id: "fx", type: "liquidChrome", enabled: true, props: { amount: sp(40), size: sp(100), evolution: sp(evolution), highlight: sp(1), depth: sp(6), seed: sp(7), quality: sp(1) } }],
      }],
    };

    // (a) on-screen mount → 実ブラウザ合成
    const shown = document.createElement("div");
    shown.style.cssText = `position:fixed;left:20px;top:20px;width:${W}px;height:${H}px;overflow:hidden;background:#000;`;
    document.body.appendChild(shown);
    const r1 = new DomRenderer();
    r1.mount(shown, comp);
    r1.resize(W, H);
    r1.renderFrame(resolve(comp, 0), 0);
    await r1.flushRasterEffects();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // (b) offscreen mount → export capture
    const off = document.createElement("div");
    off.style.cssText = `position:fixed;left:-${W + 60}px;top:0;width:${W}px;height:${H}px;overflow:hidden;`;
    document.body.appendChild(off);
    const r2 = new DomRenderer();
    r2.mount(off, comp);
    r2.resize(W, H);
    r2.renderFrame(resolve(comp, 0), 0);
    await r2.flushRasterEffects();
    await new Promise((r) => setTimeout(r, 0));
    const exportCanvas = await captureElementToCanvas(r2.getRoot(), W, H, "#000000");
    const ed = exportCanvas.getContext("2d").getImageData(0, 0, W, H).data;
    let exportNonBg = 0;
    for (let i = 0; i < ed.length; i += 4) if (ed[i] > 5 || ed[i + 1] > 5 || ed[i + 2] > 5) exportNonBg++;

    window.__r1 = r1; window.__r2 = r2; window.__shown = shown; window.__off = off;
    return { W, H, exportPng: exportCanvas.toDataURL("image/png"), exportNonBgFrac: exportNonBg / (ed.length / 4) };
  }, { evolution });

  const previewShot = await page.screenshot({ clip: { x: 20, y: 20, width: setup.W, height: setup.H } });

  const diff = await page.evaluate(async ({ exportPng, previewB64 }) => {
    async function dec(u) { const i = new Image(); i.src = u; await new Promise((r) => (i.onload = r)); const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; c.getContext("2d").drawImage(i, 0, 0); return c.getContext("2d").getImageData(0, 0, c.width, c.height).data; }
    const a = await dec(`data:image/png;base64,${previewB64}`);
    const b = await dec(exportPng);
    let maxDiff = 0, sum = 0, n = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i += 4) for (let c = 0; c < 3; c++) { const d = Math.abs(a[i + c] - b[i + c]); maxDiff = Math.max(maxDiff, d); sum += d; n++; }
    return { maxDiff, meanDiff: sum / n };
  }, { exportPng: setup.exportPng, previewB64: previewShot.toString("base64") });

  await page.evaluate(() => { window.__r1.dispose(); window.__r2.dispose(); window.__shown.remove(); window.__off.remove(); });
  fs.writeFileSync(`verify-lc-parity-evo${evolution}-export.png`, Buffer.from(setup.exportPng.split(",")[1], "base64"));
  fs.writeFileSync(`verify-lc-parity-evo${evolution}-preview.png`, previewShot);
  return { evolution, ...diff, exportNonBgFrac: setup.exportNonBgFrac };
}

const results = [];
for (const e of [0, 90, 270]) results.push(await runAt(e));
for (const r of results) console.log(`evo=${r.evolution}: maxDiff=${r.maxDiff} meanDiff=${r.meanDiff.toFixed(2)} exportNonBg=${(r.exportNonBgFrac * 100).toFixed(1)}%`);
console.log("errors:", errors.length ? errors.slice(0, 6) : "none");
// screenshot(実合成) vs foreignObject capture は AA/サンプリング差で完全一致はしないが、
// export が黒落ちせず (exportNonBg 高) preview と概ね一致 (mean 小) すれば INV-2 経路一致とみなす。
const worstMean = Math.max(...results.map((r) => r.meanDiff));
const minNonBg = Math.min(...results.map((r) => r.exportNonBgFrac));
const ok = worstMean <= 12 && minNonBg > 0.9;
console.log(ok ? "PASS (INV-2 経路一致・export 非黒)" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
