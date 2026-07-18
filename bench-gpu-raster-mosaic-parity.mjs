// GPU Raster Pipeline — Phase 4 mosaic(adjustment) parity ゲート。
//
// WebGl2Compositor の GPU adjustment 経路（mosaic 2-pass downsample/upsample shader）が
// Canvas2DCompositor（`blockAverage` CPU）と許容差内で一致することを検証する。
// fixture: 不透明 BG + カラフルな下地 + text（AA エッジ）+ **mosaic を持つ raster 調整レイヤ**（最前面）。
// 540/16 が割り切れない解像度/blockSize で **部分エッジブロック**の top-origin 一致も検証する。
// captureCompFramePng を flag OFF(CPU)/ON(GPU) で撮り、両 PNG を decode して per-channel abs 差を比較。
//
// 使い方: `npm run dev` 起動後 `node bench-gpu-raster-mosaic-parity.mjs`
// 成功基準: GPU フレームが実走（counter>0）し、max abs 差 <= 2 / mean 差 <= 0.5（≤2/255）。

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";

const PORT = process.env.VERIFY_PORT ?? "5173";
const APP_URL = `https://localhost:${PORT}/`;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "bench-gpu-raster-mosaic-parity.json");
const FRAMES = [0, 6, 14];
const MAX_ABS = 2, MAX_MEAN = 0.5;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(APP_URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);
const ev = (fn, ...a) => page.evaluate(fn, ...a);

const built = await ev(() => {
  const s = window.__mafterEditorStore.getState();
  const W = 960, H = 540, DUR = 60; // 540/16 = 33.75（部分ブロックあり）
  const objOf = (id) => window.__mafterEditorStore.getState().project.compositions
    .flatMap((c) => c.objects ?? []).find((o) => o.id === id);
  const solid = (name, color, size, z, pos) => {
    const id = s.addSolid(name);
    const props = { color: { value: color, keyframes: [] }, size: { value: size, keyframes: [] } };
    const patch = { zOrder: z, components: [{ type: "solid", props }] };
    if (pos) { const cur = objOf(id).transform; patch.transform = { ...cur, position: { value: pos, keyframes: [] } }; }
    s.updateObject(id, patch);
    return id;
  };
  const mainId = s.addTimelineComp("GPU-Mosaic-Parity", { width: W, height: H, fps: 30, duration: DUR });
  s.setCurrentComp(mainId);
  solid("BG", { r: 0.5, g: 0.3, b: 0.15, a: 1 }, { x: W, y: H, z: 0 }, 0);
  solid("A", { r: 0.9, g: 0.25, b: 0.2, a: 1 }, { x: 460, y: 300, z: 0 }, 1, { x: 320, y: 210, z: 0 });
  solid("B", { r: 0.15, g: 0.7, b: 0.9, a: 1 }, { x: 400, y: 260, z: 0 }, 2, { x: 620, y: 340, z: 0 });
  const txt = s.addText("Mosaic"); s.updateObject(txt, { zOrder: 3 });
  // mosaic を持つ raster 調整レイヤ（最前面 = 背面 master 全体をピクセル化）。
  const adj = s.addRasterAdjustmentLayer("MosaicAdj");
  s.updateObject(adj, { zOrder: 100 });
  s.addEffect(adj, "mosaic");
  s.setCurrentComp(mainId); s.setFrame(0);
  return { mainId };
});
await ev(async () => { await window.__mafterEditorStore.getState().saveToFs(); });

async function render(gpu) {
  return ev(async (opts) => {
    globalThis.__mafterGpuCompositor = opts.gpu;
    globalThis.__mafterGpuCompositorFrames = 0;
    const s = window.__mafterEditorStore.getState();
    const cap = await import("/src/runtime/compFrameCapture.ts");
    const comp = s.project.compositions.find((c) => c.id === opts.mainId);
    const ctx = await cap.createCompFrameCaptureContext(s.project, opts.mainId, s.getFs(), { textQuality: "precise" });
    const dec = async (png) => {
      const bmp = await createImageBitmap(new Blob([png], { type: "image/png" }));
      const cv = document.createElement("canvas"); cv.width = bmp.width; cv.height = bmp.height;
      const g = cv.getContext("2d"); g.drawImage(bmp, 0, 0);
      return g.getImageData(0, 0, cv.width, cv.height).data;
    };
    const frames = {};
    try {
      for (const f of opts.frames) {
        const png = await cap.captureCompFramePng(ctx, comp, f);
        frames[f] = Array.from(await dec(png));
      }
    } finally { ctx.dispose(); }
    return { frames, gpuFrames: globalThis.__mafterGpuCompositorFrames };
  }, { gpu, mainId: built.mainId, frames: FRAMES });
}

const cpu = await render(false);
const gpuRes = await render(true);

const report = { when: new Date().toISOString(), frames: FRAMES, gpuFramesExecuted: gpuRes.gpuFrames, perFrame: {}, pageErrors: pageErrors.slice(0, 5) };
let fail = 0;
for (const f of FRAMES) {
  const a = cpu.frames[f], b = gpuRes.frames[f];
  let maxAbs = 0, sum = 0, n = 0, over = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { const d = Math.abs(a[i] - b[i]); if (d > maxAbs) maxAbs = d; if (d > MAX_ABS) over++; sum += d; n++; }
  const mean = +(sum / n).toFixed(4);
  const ok = maxAbs <= MAX_ABS && mean <= MAX_MEAN;
  report.perFrame[f] = { maxAbs, mean, over, ok, samples: n };
  console.log(`frame ${String(f).padStart(2)}: maxAbs=${maxAbs} mean=${mean} over>${MAX_ABS}=${over} ${ok ? "OK" : "FAIL"}`);
  if (!ok) fail++;
}
console.log("GPU frames executed:", gpuRes.gpuFrames, "| pageErrors:", pageErrors.length);
if (pageErrors.length) console.log("pageErrors sample:", pageErrors.slice(0, 3));
writeFileSync(OUT, JSON.stringify(report, null, 2));
await browser.close();

if (gpuRes.gpuFrames === 0) { console.error("\nFAIL — GPU mosaic 経路が一度も走っていない（fallback 固着? eligibility 不成立?）"); process.exit(3); }
if (fail === 0) console.log(`\nGPU MOSAIC PARITY PASS — 全フレーム許容差内（maxAbs<=${MAX_ABS}, mean<=${MAX_MEAN}）, GPU 実走 ${gpuRes.gpuFrames}`);
else { console.error(`\nGPU MOSAIC PARITY FAIL — ${fail} フレーム許容差超過`); process.exit(1); }
