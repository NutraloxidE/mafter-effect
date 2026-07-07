// 動画レイヤーの export 経路検証（video_test.mp4 + 2D/3D レイヤを手動構築）。
// foreignObject は <video> を描けないため inlineVideoFrames で静止画化し preview と parity を取る。
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `http://localhost:${PORT}/`;
const VIDEO_PATH = resolve("for-debug-data/video_test.mp4");
const FRAMES = [0, 15, 30]; // 2D / 3D 切替前後

console.log("verify-video-export: starting…");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(800);

const videoBytes = readFileSync(VIDEO_PATH);

const setup = await page.evaluate(async ({ bytes, name }) => {
  const storeMod = await import("/src/editor/store.ts");
  const S = () => storeMod.useEditorStore.getState();
  for (let i = 0; i < 80 && !(S().project && S().currentCompId); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  await S().newProject();
  const buf = new Uint8Array(bytes);
  const file = new File([buf], name, { type: "video/mp4" });
  const assetId = await S().importVideoAsset(file);
  if (!assetId) throw new Error("importVideoAsset failed");

  // 2D レイヤ
  const layer2d = S().addVideoLayer(assetId, "video-2d");
  if (!layer2d) throw new Error("addVideoLayer 2d failed");

  // 3D レイヤ（回転付き）
  const layer3d = S().addVideoLayer(assetId, "video-3d");
  if (!layer3d) throw new Error("addVideoLayer 3d failed");
  const sp = (v) => ({ value: v, keyframes: [] });
  const v3 = (x, y, z = 0) => ({ x, y, z });
  const comp = () => S().project.compositions.find((c) => c.id === S().currentCompId);
  const obj3d = comp().objects.find((o) => o.id === layer3d);
  S().updateObject(layer3d, {
    threeD: true,
    inPoint: 20,
    transform: {
      ...obj3d.transform,
      position: sp(v3(200, 100, 0)),
      rotation: sp(v3(40, 25, 0)),
    },
  }, "setup");

  const camId = S().addCamera();
  if (!camId) throw new Error("addCamera failed");

  const compMeta = comp();
  await new Promise((r) => setTimeout(r, 1000));
  return { compId: compMeta?.id, w: compMeta?.width ?? 1920, h: compMeta?.height ?? 1080 };
}, { bytes: [...videoBytes], name: "video_test.mp4" });

const { compId, w: W, h: H } = setup;
if (!compId) throw new Error("setup failed");
console.log("setup ok", { compId, W, H });

const exportPayload = await page.evaluate(async ({ compId, W, H, frames }) => {
  const storeMod = await import("/src/editor/store.ts");
  const S = () => storeMod.useEditorStore.getState();
  const project = S().project;
  const comp = project.compositions.find((c) => c.id === compId);

  const { DomRenderer } = await import("/src/runtime/DomRenderer.ts");
  const { resolve } = await import("/src/runtime/resolve.ts");
  const { compositeExportFrame } = await import("/src/runtime/exportComposite.ts");
  const { ExpressionEngine } = await import("/src/runtime/expressionEngine.ts");
  const { ModuleLoader } = await import("/src/runtime/moduleLoader.ts");
  const { compositionDir } = await import("/src/core/paths.ts");
  const { HtmlCompPlayer } = await import("/src/runtime/htmlComp.ts");
  const { FontOutlineCache } = await import("/src/runtime/fontOutlineCache.ts");
  const { ImageAssetCache } = await import("/src/runtime/imageAssetCache.ts");

  const htmlComps = project.compositions.filter((c) => c.kind === "html");
  const timelineComps = project.compositions.filter((c) => c.kind === "timeline" && c.id !== compId);
  const bg = "#000000";

  const fsInst = S().getFs();
  const engine = new ExpressionEngine(new ModuleLoader(fsInst));
  const htmlPlayer = new HtmlCompPlayer(new ModuleLoader(fsInst));
  const fontCache = new FontOutlineCache();
  const imageCache = new ImageAssetCache();
  await Promise.all([fontCache.loadFromProject(project, fsInst), imageCache.loadFromProject(project, fsInst)]);
  await engine.prepare(comp);
  const evaluator = engine.makeEvaluator(comp);
  await Promise.all(timelineComps.map((c) => engine.prepare(c)));
  const compEvaluators = new Map(timelineComps.map((c) => [c.id, engine.makeEvaluator(c)]));
  await htmlPlayer.prepare(htmlComps, (id) => `${compositionDir(id)}/script.js`);

  const container = document.createElement("div");
  container.style.cssText = `position:fixed;left:-${W + 40}px;top:0;width:${W}px;height:${H}px;overflow:hidden;`;
  document.body.appendChild(container);
  const r = new DomRenderer();
  r.setHtmlPlayer(htmlPlayer);
  r.setFontCache(fontCache);
  r.setImageCache(imageCache);
  r.setTextQuality("precise");
  r.setPreviewRenderOptions({ exportCompositeMode: true, exportVideoStep: true });
  r.mount(container, comp);
  r.setHtmlComps(new Map(htmlComps.map((c) => [c.id, c])));
  r.setTimelineComps(new Map(timelineComps.map((c) => [c.id, c])));
  r.setCompEvaluators(compEvaluators);

  function contentStats(data) {
    let nonBlack = 0;
    let playerUiLike = 0;
    let lumSum = 0;
    const px = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const rv = data[i]; const gv = data[i + 1]; const bv = data[i + 2];
      const lum = 0.299 * rv + 0.587 * gv + 0.114 * bv;
      lumSum += lum;
      if (lum > 8) nonBlack++;
      if (rv > 180 && gv > 180 && bv > 180 && Math.abs(rv - gv) < 20 && Math.abs(gv - bv) < 20) playerUiLike++;
    }
    return { nonBlackRatio: nonBlack / px, playerUiRatio: playerUiLike / px, meanLum: lumSum / px };
  }

  const out = {};
  const timings = [];
  const rawByFrame = {};
  for (const frame of frames) {
    const t0 = performance.now();
    r.renderFrame(resolve(comp, frame, { expressions: evaluator }), frame);
    await r.flushRasterEffects();
    await r.flushVideoFrames();
    await new Promise((res) => setTimeout(res, 0));
    const canvas = await compositeExportFrame(r, W, H, W, H, bg);
    const data = canvas.getContext("2d").getImageData(0, 0, W, H).data;
    timings.push({ frame, ms: Math.round(performance.now() - t0) });
    rawByFrame[frame] = data;
    out[frame] = contentStats(data);
  }

  function frameDiff(a, b) {
    let d = 0; const n = a.length / 4;
    for (let i = 0; i < a.length; i += 64) {
      if (Math.abs(a[i] - b[i]) > 12 || Math.abs(a[i + 1] - b[i + 1]) > 12 || Math.abs(a[i + 2] - b[i + 2]) > 12) d++;
    }
    return d / (n / 16);
  }

  const motionDiff = frameDiff(rawByFrame[frames[0]], rawByFrame[frames[1]]);

  r.dispose();
  container.remove();
  return { out, timings, motionDiff };
}, { compId, W, H, frames: FRAMES });

const exportResult = exportPayload.out;
const timings = exportPayload.timings;
const motionDiff = exportPayload.motionDiff;

let pass = true;
for (const frame of FRAMES) {
  const exp = exportResult[frame];
  console.log(`frame ${frame}: nonBlack=${(exp.nonBlackRatio * 100).toFixed(1)}% playerUi=${(exp.playerUiRatio * 100).toFixed(2)}% meanLum=${exp.meanLum.toFixed(1)}`);

  if (exp.playerUiRatio > 0.05) {
    console.error(`FAIL frame ${frame}: export looks like default video player UI`);
    pass = false;
  }
  if (exp.nonBlackRatio < 0.02) {
    console.error(`FAIL frame ${frame}: export is nearly blank`);
    pass = false;
  }
}

if (motionDiff < 0.002) {
  console.error(`FAIL: frame 0 vs 15 pixel diff too low (${(motionDiff * 100).toFixed(2)}%) — video may be stuck`);
  pass = false;
} else {
  console.log(`frame 0↔15 motion diff OK: ${(motionDiff * 100).toFixed(2)}%`);
}

for (const t of timings) {
  console.log(`export timing frame ${t.frame}: ${t.ms}ms`);
}
const avgMs = timings.reduce((a, t) => a + t.ms, 0) / timings.length;
console.log(`export avg per frame: ${avgMs.toFixed(0)}ms (30fps budget ~33ms for realtime feel)`);
if (avgMs > 200) {
  console.error(`WARN: export per-frame avg ${avgMs.toFixed(0)}ms is high — may feel sluggish`);
}

if (errors.length > 0) {
  console.error("console errors:", errors);
  pass = false;
}

await browser.close();
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
