// GPU Raster Pipeline — Phase 1 parity ゲート。
//
// compositeExportFrame をリファクタ（Canvas2DCompositor seam 抽出）する前後で、
// 合成出力が byte-identical であることを証明するための golden pixel-hash 比較。
//
// captureCompFramePng（compFrameCapture・RAM preview 経路 = 内部で compositeExportFrame を使用）で
// 決定論 PNG を出し、FNV-1a hash を取る。--save で golden を書き、通常実行で golden と比較する。
//
// 使い方: `npm run dev` 起動後
//   node bench-gpu-raster-parity.mjs --save   # リファクタ前に golden 保存
//   node bench-gpu-raster-parity.mjs          # リファクタ後に比較（差分ゼロで PASS）

import { chromium } from "playwright";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SAVE = process.argv.includes("--save");
const PORT = process.env.VERIFY_PORT ?? "5173";
const APP_URL = `https://localhost:${PORT}/`;
const GOLD = join(dirname(fileURLToPath(import.meta.url)), "bench-gpu-raster-parity.golden.json");
const FRAMES = [0, 7, 15, 23, 40];

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(),
});
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
  const RASTER_W = 640, RASTER_H = 360, MAIN_W = 1280, MAIN_H = 720, DUR = 60;
  const solid = (name, color, size, z) => {
    const id = s.addSolid(name);
    s.updateObject(id, { zOrder: z, components: [{ type: "solid", props: { color: { value: color, keyframes: [] }, size: { value: size, keyframes: [] } } }] });
    return id;
  };
  const innerId = s.addTimelineComp("FX-Inner", { width: RASTER_W, height: RASTER_H, fps: 30, duration: DUR });
  s.setCurrentComp(innerId);
  solid("InnerBase", { r: 0.1, g: 0.2, b: 0.5, a: 1 }, { x: RASTER_W, y: RASTER_H, z: 0 }, 0);
  const innerMosaic = solid("InnerMosaic", { r: 0.9, g: 0.3, b: 0.1, a: 1 }, { x: 400, y: 240, z: 0 }, 1);
  s.addEffect(innerMosaic, "mosaic"); s.setBlendMode(innerMosaic, "screen");
  const innerText = s.addText("InnerWave"); s.updateObject(innerText, { zOrder: 2 }); s.addEffect(innerText, "wave");
  const innerAdj = s.addRasterAdjustmentLayer("InnerAdj"); s.updateObject(innerAdj, { zOrder: 3 }); s.addEffect(innerAdj, "mosaic");
  const mainId = s.addTimelineComp("Bench-Main", { width: MAIN_W, height: MAIN_H, fps: 30, duration: DUR });
  s.setCurrentComp(mainId);
  solid("BG", { r: 0.05, g: 0.05, b: 0.08, a: 1 }, { x: MAIN_W, y: MAIN_H, z: 0 }, 0);
  const b1 = solid("Mul", { r: 0.8, g: 0.6, b: 0.2, a: 1 }, { x: 800, y: 500, z: 0 }, 1); s.setBlendMode(b1, "multiply");
  const b2 = solid("Ovl", { r: 0.2, g: 0.7, b: 0.9, a: 1 }, { x: 700, y: 450, z: 0 }, 2); s.setBlendMode(b2, "overlay");
  const b3 = solid("Scr", { r: 0.9, g: 0.2, b: 0.5, a: 1 }, { x: 600, y: 400, z: 0 }, 3); s.setBlendMode(b3, "screen");
  const rlayer = solid("MosaicLayer", { r: 0.3, g: 0.9, b: 0.4, a: 1 }, { x: 500, y: 500, z: 0 }, 4); s.addEffect(rlayer, "mosaic");
  solid("MatteSrc", { r: 1, g: 1, b: 1, a: 1 }, { x: 400, y: 400, z: 0 }, 6);
  const fill = solid("MatteFill", { r: 0.9, g: 0.8, b: 0.1, a: 1 }, { x: 400, y: 400, z: 0 }, 5); s.setTrackMatteMode(fill, "alpha");
  const adj = s.addRasterAdjustmentLayer("MainAdj"); s.updateObject(adj, { zOrder: 7 }); s.addEffect(adj, "mosaic");
  const nest = s.addCompLayer(innerId, "FX-Inner-Instance"); if (nest) s.updateObject(nest, { zOrder: 8 });
  s.setCurrentComp(mainId); s.setFrame(0);
  return { mainId, innerId };
});
await ev(async () => { await window.__mafterEditorStore.getState().saveToFs(); });

const hashes = await ev(async (opts) => {
  const s = window.__mafterEditorStore.getState();
  const project = s.project;
  const fs = s.getFs();
  const cap = await import("/src/runtime/compFrameCapture.ts");
  const comp = project.compositions.find((c) => c.id === opts.mainId);
  const ctx = await cap.createCompFrameCaptureContext(project, opts.mainId, fs, { textQuality: "precise" });
  const fnv1a = (bytes) => { let h = 0x811c9dc5; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return h.toString(16).padStart(8, "0"); };
  const out = {};
  try {
    for (const f of opts.frames) {
      const png = await cap.captureCompFramePng(ctx, comp, f);
      out[f] = { hash: fnv1a(png), bytes: png.length };
    }
  } finally { ctx.dispose(); }
  return out;
}, { mainId: built.mainId, frames: FRAMES });

console.log("frame hashes:", JSON.stringify(hashes));
console.log("pageErrors:", pageErrors.length);
await browser.close();

if (SAVE) {
  writeFileSync(GOLD, JSON.stringify({ when: new Date().toISOString(), frames: FRAMES, hashes }, null, 2));
  console.log("\nSAVED golden →", GOLD);
} else {
  if (!existsSync(GOLD)) { console.error("no golden file; run with --save first"); process.exit(2); }
  const gold = JSON.parse(readFileSync(GOLD, "utf8")).hashes;
  let fail = 0;
  for (const f of FRAMES) {
    const g = gold[f], n = hashes[f];
    const ok = g && n && g.hash === n.hash && g.bytes === n.bytes;
    console.log(`  frame ${String(f).padStart(3)}: ${ok ? "MATCH" : "DIFF"}  golden=${g?.hash}/${g?.bytes}  now=${n?.hash}/${n?.bytes}`);
    if (!ok) fail++;
  }
  if (fail === 0) console.log("\nPARITY PASS — 全フレーム byte-identical");
  else { console.error(`\nPARITY FAIL — ${fail} フレーム差分`); process.exit(1); }
}
