// 動画 export のフレーム決定論・単調性検証（ちらつき = 戻ったり進んだり の検出）。
// 各 export フレームで <video>.currentTime が target に正確に乗り、かつフレーム間で
// 後退しない（monotonic non-decreasing）ことを確認する。play() 進行だと振動する。
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `http://localhost:${PORT}/`;
const VIDEO_PATH = resolve(process.env.VERIFY_VIDEO ?? "for-debug-data/video_motion.mp4");
const N = 24; // 0..N の連続フレームを順に書き出す

console.log("verify-video-export-monotonic: starting…");

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
  const file = new File([new Uint8Array(bytes)], name, { type: "video/mp4" });
  const assetId = await S().importVideoAsset(file);
  if (!assetId) throw new Error("importVideoAsset failed");
  const layer2d = S().addVideoLayer(assetId, "video-2d");
  if (!layer2d) throw new Error("addVideoLayer 2d failed");
  const comp = () => S().project.compositions.find((c) => c.id === S().currentCompId);
  const compMeta = comp();
  await new Promise((r) => setTimeout(r, 1000));
  return { compId: compMeta?.id, w: compMeta?.width ?? 1920, h: compMeta?.height ?? 1080, fps: compMeta?.fps ?? 30 };
}, { bytes: [...videoBytes], name: "video_test.mp4" });

const { compId, w: W, h: H, fps: FPS } = setup;
if (!compId) throw new Error("setup failed");
console.log("setup ok", { compId, W, H, FPS });

const result = await page.evaluate(async ({ compId, W, H, N }) => {
  const storeMod = await import("/src/editor/store.ts");
  const S = () => storeMod.useEditorStore.getState();
  const project = S().project;
  const comp = project.compositions.find((c) => c.id === compId);

  const { DomRenderer } = await import("/src/runtime/DomRenderer.ts");
  const { resolve } = await import("/src/runtime/resolve.ts");
  const { compositeExportFrame } = await import("/src/runtime/exportComposite.ts");
  const { ExpressionEngine } = await import("/src/runtime/expressionEngine.ts");
  const { ModuleLoader } = await import("/src/runtime/moduleLoader.ts");
  const { FontOutlineCache } = await import("/src/runtime/fontOutlineCache.ts");
  const { ImageAssetCache } = await import("/src/runtime/imageAssetCache.ts");

  const fsInst = S().getFs();
  const engine = new ExpressionEngine(new ModuleLoader(fsInst));
  const fontCache = new FontOutlineCache();
  const imageCache = new ImageAssetCache();
  await Promise.all([fontCache.loadFromProject(project, fsInst), imageCache.loadFromProject(project, fsInst)]);
  await engine.prepare(comp);
  const evaluator = engine.makeEvaluator(comp);

  const container = document.createElement("div");
  container.style.cssText = `position:fixed;left:-${W + 40}px;top:0;width:${W}px;height:${H}px;overflow:hidden;`;
  document.body.appendChild(container);
  const r = new DomRenderer();
  r.setFontCache(fontCache);
  r.setImageCache(imageCache);
  r.setTextQuality("precise");
  r.setPreviewRenderOptions({ exportCompositeMode: true, exportVideoStep: true });
  r.mount(container, comp);

  const ATTR = "data-mafter-export-video-target";
  function meanLum(data) {
    let s = 0; const px = data.length / 4;
    for (let i = 0; i < data.length; i += 4) s += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return s / px;
  }
  function diff(a, b) {
    let d = 0; const n = a.length / 4;
    for (let i = 0; i < a.length; i += 64) {
      if (Math.abs(a[i] - b[i]) > 12 || Math.abs(a[i + 1] - b[i + 1]) > 12 || Math.abs(a[i + 2] - b[i + 2]) > 12) d++;
    }
    return d / (n / 16);
  }

  const rows = [];
  let prevData = null;
  for (let frame = 0; frame <= N; frame++) {
    const t0 = performance.now();
    r.renderFrame(resolve(comp, frame, { expressions: evaluator }), frame);
    await r.flushRasterEffects();
    await r.flushVideoFrames();
    await new Promise((res) => setTimeout(res, 0));
    const vid = container.querySelector("video");
    const target = vid ? Number(vid.getAttribute(ATTR)) : NaN;
    const currentTime = vid ? vid.currentTime : NaN;
    const canvas = await compositeExportFrame(r, W, H, W, H, "#000000");
    const data = canvas.getContext("2d").getImageData(0, 0, W, H).data;
    rows.push({
      frame, target, currentTime,
      lum: meanLum(data),
      diffPrev: prevData ? diff(prevData, data) : 0,
      ms: Math.round(performance.now() - t0),
    });
    prevData = data;
  }

  r.dispose();
  container.remove();
  return rows;
}, { compId, W, H, N });

const halfFrame = 0.5 / FPS;
let pass = true;
let prevTime = -Infinity;
let reversals = 0;
let offTarget = 0;
let stuck = 0;

// export は float 境界丸め回避のためフレーム区間中央（target + halfFrame）へ seek する。
console.log("frame | target | currentTime | onTarget | diffPrev%");
for (const row of result) {
  const expected = row.target + halfFrame;
  const onTarget = Math.abs(row.currentTime - expected) <= halfFrame + 1e-6;
  if (!onTarget) offTarget++;
  if (row.currentTime < prevTime - halfFrame) reversals++;
  if (row.frame > 0 && row.diffPrev < 0.0005) stuck++;
  prevTime = row.currentTime;
  console.log(
    `${String(row.frame).padStart(5)} | ${row.target.toFixed(3)} | ${row.currentTime.toFixed(3)} | ${onTarget ? "yes" : "NO "} | ${(row.diffPrev * 100).toFixed(2)}`,
  );
}

const avgMs = result.reduce((a, r) => a + r.ms, 0) / result.length;
console.log(`\noffTarget=${offTarget}/${result.length}  reversals=${reversals}  stuckFrames=${stuck}/${result.length - 1}  avg=${avgMs.toFixed(0)}ms/frame`);

if (reversals > 0) {
  console.error(`FAIL: ${reversals} frame(s) went BACKWARD in source time (flicker / 戻り)`);
  pass = false;
}
if (offTarget > 2) {
  console.error(`FAIL: ${offTarget} frame(s) did not land on target source time (non-deterministic)`);
  pass = false;
}
if (stuck > result.length / 2) {
  console.error(`FAIL: ${stuck} consecutive frames identical — video not advancing (もっさり)`);
  pass = false;
}

if (errors.length > 0) {
  console.error("console errors:", errors);
  pass = false;
}

await browser.close();
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
