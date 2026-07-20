// GPU Raster Pipeline — Phase 0 ベースライン計測（export 経路・挙動変更なし・source 非改変）。
//
// preview 版（bench-gpu-raster-baseline.mjs）の姉妹。primary GPU target である
// exportComposite.compositeExportFrame（per-layer capture + Canvas2D z 順累積 +
// applyAdjustmentToMaster の getImageData/putImageData 往復）の実測を取る。
//
// 駆動: page から Vite dynamic-import で runtime の exportComposition を呼び、
//   PNG 連番（既定）または BENCH_FORMAT=mp4|webm で決定論 export を実行。pixel-API を wrap して
//   capture/getImageData/putImageData/toDataURL/createImageBitmap の内訳を集計する。
//   → bench-gpu-raster-export-baseline.json
//
// 使い方: `npm run dev` 起動後 `node bench-gpu-raster-export-baseline.mjs`
//         `$env:BENCH_FORMAT='mp4'; $env:BENCH_OUT='bench-browser-export-before-mp4.json'; node bench-gpu-raster-export-baseline.mjs`

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5173";
const APP_URL = `https://localhost:${PORT}/`;
const FORMAT = process.env.BENCH_FORMAT ?? "png-seq";
const GPU = process.env.BENCH_GPU === "1";
const GPU_DIRECT = process.env.BENCH_GPU_DIRECT !== "0";
const ALPHA = process.env.BENCH_ALPHA === "1";
const SCALE = Number(process.env.BENCH_SCALE ?? "1");
const STATIC_CACHE = process.env.BENCH_STATIC_CACHE !== "0";
const STATIC_IMAGE = process.env.BENCH_STATIC_IMAGE === "1";
const STATIC_IMAGE_CACHE = process.env.BENCH_STATIC_IMAGE_CACHE !== "0";
const VIDEO = process.env.BENCH_VIDEO === "1";
const DIRECT_VIDEO = process.env.BENCH_DIRECT_VIDEO !== "0";
const OUTPUT_SAMPLE = process.env.BENCH_OUTPUT_SAMPLE === "1";
if (!["png-seq", "mp4", "webm"].includes(FORMAT)) throw new Error(`Unsupported BENCH_FORMAT: ${FORMAT}`);
const OUT_JSON = join(dirname(fileURLToPath(import.meta.url)), process.env.BENCH_OUT ?? "bench-gpu-raster-export-baseline.json");
const N_FRAMES = Number(process.env.BENCH_FRAMES ?? "24");
const VIDEO_BASE64 = VIDEO
  ? readFileSync(join(dirname(fileURLToPath(import.meta.url)), "for-debug-data", "video_motion.mp4")).toString("base64")
  : null;

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

// ─── instrumentation（preview 版と同一） ────────────────────────────────────
await ev(() => {
  const stats = {
    getImageData: { n: 0, ms: 0 }, putImageData: { n: 0, ms: 0 }, drawImage: { n: 0, ms: 0 },
    toDataURL: { n: 0, ms: 0 }, createImageBitmap: { n: 0, ms: 0 }, readPixels: { n: 0, ms: 0 },
    imageDecode: { n: 0, ms: 0 }, lastActivity: 0,
  };
  window.__benchStats = stats;
  const mark = () => { stats.lastActivity = performance.now(); };
  const wrap = (obj, name, key) => {
    const orig = obj[name]; if (typeof orig !== "function") return;
    obj[name] = function (...args) { const t = performance.now(); const r = orig.apply(this, args); stats[key].ms += performance.now() - t; stats[key].n += 1; mark(); return r; };
  };
  wrap(CanvasRenderingContext2D.prototype, "getImageData", "getImageData");
  wrap(CanvasRenderingContext2D.prototype, "putImageData", "putImageData");
  wrap(CanvasRenderingContext2D.prototype, "drawImage", "drawImage");
  wrap(HTMLCanvasElement.prototype, "toDataURL", "toDataURL");
  if (typeof WebGLRenderingContext !== "undefined") wrap(WebGLRenderingContext.prototype, "readPixels", "readPixels");
  if (typeof WebGL2RenderingContext !== "undefined") wrap(WebGL2RenderingContext.prototype, "readPixels", "readPixels");
  const origCIB = window.createImageBitmap;
  if (typeof origCIB === "function") {
    window.createImageBitmap = function (...args) { const t = performance.now(); return origCIB.apply(this, args).then((r) => { stats.createImageBitmap.ms += performance.now() - t; stats.createImageBitmap.n += 1; mark(); return r; }); };
  }
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  if (desc && desc.set) {
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: true, enumerable: desc.enumerable, get: desc.get,
      set: function (v) {
        if (typeof v === "string" && v.startsWith("data:image/svg")) {
          const t = performance.now();
          const onDone = () => { stats.imageDecode.ms += performance.now() - t; stats.imageDecode.n += 1; mark(); this.removeEventListener("load", onDone); this.removeEventListener("error", onDone); };
          this.addEventListener("load", onDone); this.addEventListener("error", onDone);
        }
        return desc.set.call(this, v);
      },
    });
  }
});

// ─── fixture（preview 版と同一 composite） ──────────────────────────────────
const built = await ev(async (opts) => {
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
  let staticImageId = null;
  if (opts.staticImage) {
    const source = document.createElement("canvas"); source.width = 320; source.height = 180;
    const g = source.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 320, 180);
    grad.addColorStop(0, "#ff3366"); grad.addColorStop(1, "#22bbff");
    g.fillStyle = grad; g.fillRect(0, 0, 320, 180);
    g.fillStyle = "rgba(255,255,255,.8)"; g.fillRect(48, 42, 224, 96);
    const blob = await new Promise((resolve, reject) => source.toBlob((b) => b ? resolve(b) : reject(new Error("fixture png failed")), "image/png"));
    const assetId = await s.importImageAsset(new File([blob], "bench-static.png", { type: "image/png" }));
    if (!assetId) throw new Error("fixture image import failed");
    staticImageId = s.addImageLayer(assetId, "StaticImage");
    if (!staticImageId) throw new Error("fixture image layer failed");
    s.updateObject(staticImageId, { zOrder: 8.5 });
  }
  let videoId = null;
  if (opts.videoBase64) {
    const binary = atob(opts.videoBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const assetId = await s.importVideoAsset(new File([bytes], "video_motion.mp4", { type: "video/mp4" }));
    if (!assetId) throw new Error("fixture video import failed");
    videoId = s.addVideoLayer(assetId, "DirectVideo");
    if (!videoId) throw new Error("fixture video layer failed");
    s.updateObject(videoId, { zOrder: 8.75 });
  }
  const rlayer = solid("MosaicLayer", { r: 0.3, g: 0.9, b: 0.4, a: 1 }, { x: 500, y: 500, z: 0 }, 4); s.addEffect(rlayer, "mosaic");
  solid("MatteSrc", { r: 1, g: 1, b: 1, a: 1 }, { x: 400, y: 400, z: 0 }, 6);
  const fill = solid("MatteFill", { r: 0.9, g: 0.8, b: 0.1, a: 1 }, { x: 400, y: 400, z: 0 }, 5); s.setTrackMatteMode(fill, "alpha");
  const adj = s.addRasterAdjustmentLayer("MainAdj"); s.updateObject(adj, { zOrder: 7 }); s.addEffect(adj, "mosaic");
  const nest = s.addCompLayer(innerId, "FX-Inner-Instance"); if (nest) s.updateObject(nest, { zOrder: 8 });
  s.setCurrentComp(mainId); s.setFrame(0);
  return { mainId, innerId, staticImageId, videoId, mainSize: [MAIN_W, MAIN_H] };
}, { staticImage: STATIC_IMAGE, videoBase64: VIDEO_BASE64 });
console.log("built:", JSON.stringify(built));

// FS へフラッシュ（exportComposition は project 引数を直接受けるが、fonts/assets を fs から読む）
await ev(async () => { await window.__mafterEditorStore.getState().saveToFs(); });

// ─── export 経路を driving（PNG 連番・WebCodecs 不要） ───────────────────────
const exp = await ev(async (opts) => {
  const stats = window.__benchStats;
  const s = window.__mafterEditorStore.getState();
  const project = s.project;
  const fs = s.getFs();
  const mod = await import("/src/runtime/exporter.ts");
  globalThis.__mafterGpuCompositor = opts.gpu;
  globalThis.__mafterGpuDirectSurface = opts.gpuDirect;
  globalThis.__mafterStaticLayerCaptureCache = opts.staticCache;
  globalThis.__mafterStaticImageCaptureCache = opts.staticImageCache;
  globalThis.__mafterDirectVideoCapture = opts.directVideo;
  globalThis.__mafterGpuCompositorFrames = 0;
  globalThis.__mafterGpuDirectSurfaceFrames = 0;
  globalThis.__mafterDirectVideoCaptureFrames = 0;

  // 計測を export 区間だけにリセット
  for (const k of Object.keys(stats)) { if (k === "lastActivity") continue; stats[k] = { n: 0, ms: 0 }; }

  const perFrameMs = [];
  let lastT = performance.now();
  const onProgress = (p) => {
    if (p.phase === "render") { const now = performance.now(); perFrameMs.push(now - lastT); lastT = now; }
  };
  const cfg = { range: [0, opts.n], fps: 30, scale: opts.scale, format: opts.format, alpha: opts.alpha, textRenderMode: "precise" };
  const t0 = performance.now();
  let ok = true, err = null, output = null;
  try {
    const res = await mod.exportComposition(project, opts.mainId, fs, cfg, onProgress);
    ok = !!res && !!res.blob;
    if (res?.blob && opts.format !== "png-seq") {
      const url = URL.createObjectURL(res.blob);
      try {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.src = url;
        await new Promise((resolve, reject) => {
          video.onloadedmetadata = resolve;
          video.onerror = () => reject(new Error("encoded video metadata decode failed"));
        });
        let sample = null;
        if (opts.outputSample) {
          video.currentTime = Math.min(video.duration / 2, Math.max(0, video.duration - 0.01));
          await new Promise((resolve, reject) => {
            video.onseeked = resolve;
            video.onerror = () => reject(new Error("encoded video sample seek failed"));
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
          const sampleCanvas = document.createElement("canvas");
          sampleCanvas.width = 64; sampleCanvas.height = 36;
          const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
          sampleCtx.drawImage(video, 0, 0, 64, 36);
          sample = Array.from(sampleCtx.getImageData(0, 0, 64, 36).data);
        }
        output = {
          bytes: res.blob.size,
          type: res.blob.type,
          width: video.videoWidth,
          height: video.videoHeight,
          duration: video.duration,
          ...(sample ? { sample } : {}),
        };
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } catch (e) { ok = false; err = String(e); }
  const totalMs = performance.now() - t0;

  const api = {};
  for (const k of Object.keys(stats)) { if (k === "lastActivity") continue; api[k] = { n: stats[k].n, ms: +stats[k].ms.toFixed(1) }; }
  // 最初のフレームは prepare を含むので分けて集計
  const body = perFrameMs.slice(1);
  const avg = (arr) => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : 0;
  return {
    ok,
    err,
    totalMs: +totalMs.toFixed(1),
    frames: opts.n,
    gpuFrames: globalThis.__mafterGpuCompositorFrames ?? 0,
    gpuDirectSurfaceFrames: globalThis.__mafterGpuDirectSurfaceFrames ?? 0,
    directVideoCaptureFrames: globalThis.__mafterDirectVideoCaptureFrames ?? 0,
    firstFrameMs: +(perFrameMs[0] ?? 0).toFixed(1),
    avgFrameMs: avg(body),
    api,
    output,
  };
}, {
  mainId: built.mainId,
  n: N_FRAMES,
  format: FORMAT,
  gpu: GPU,
  gpuDirect: GPU_DIRECT,
  alpha: ALPHA,
  scale: SCALE,
  staticCache: STATIC_CACHE,
  staticImageCache: STATIC_IMAGE_CACHE,
  directVideo: DIRECT_VIDEO,
  outputSample: OUTPUT_SAMPLE,
});

const printable = exp.output?.sample
  ? { ...exp, output: { ...exp.output, sample: `[${exp.output.sample.length} values]` } }
  : exp;
console.log("export result:", JSON.stringify(printable, null, 2));

const result = {
  when: new Date().toISOString(),
  note: `Export benchmark — ${FORMAT} (compositeExportFrame + optional WebCodecs).`,
  fixture: built, export: exp, pageErrors: pageErrors.slice(0, 5),
};
writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
console.log("\nwrote", OUT_JSON, "| pageErrors:", pageErrors.length);
await browser.close();
