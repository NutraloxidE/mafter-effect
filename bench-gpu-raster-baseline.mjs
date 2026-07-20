// GPU Raster Pipeline — Phase 0 ベースライン計測（挙動変更なし・source 非改変）。
//
// 目的: doc/cloudplan/gpu-raster-pipeline-design.md の Phase 0 成果物。
//   重い composite（raster effect + blend + track matte + adjustment + nested precomp）を持つ
//   synthetic project を store API で構築し、preview scrub を実 Chrome で駆動して、
//   現行 CPU 経路のフレーム時間と pixel-API 呼び出し内訳（capture/getImageData/putImageData/
//   toDataURL/createImageBitmap/readPixels）を計測する。GPU 化後の比較用ベースラインとして
//   bench-gpu-raster-baseline.json に保存する。
//
// 計測は page-only の monkey-patch（getImageData 等）で行い、runtime source を一切変更しない。
// これにより「preview 中に readPixels/getImageData がどれだけ走るか（plan §0-2 / §7.1）」を
// 定量化できる。
//
// 使い方: `npm run dev` を起動した状態で `node bench-gpu-raster-baseline.mjs`
//   （VERIFY_PORT でポート変更可・既定 5173 / https）。

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5173";
const APP_URL = `https://localhost:${PORT}/`;
const OUT_JSON = join(dirname(fileURLToPath(import.meta.url)), "bench-gpu-raster-baseline.json");

// scrub するフレーム数（cold）。comp duration 内。
const N_FRAMES = 48;

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(),
});
const page = await browser.newPage({
  viewport: { width: 1400, height: 900 },
  ignoreHTTPSErrors: true,
});
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.goto(APP_URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

async function ev(fn, ...args) {
  return page.evaluate(fn, ...args);
}

// ─── 1. instrumentation を注入（page-only・source 非改変） ────────────────────
await ev(() => {
  const stats = {
    getImageData: { n: 0, ms: 0 },
    putImageData: { n: 0, ms: 0 },
    drawImage: { n: 0, ms: 0 },
    toDataURL: { n: 0, ms: 0 },
    createImageBitmap: { n: 0, ms: 0 },
    readPixels: { n: 0, ms: 0 }, // preview 中は 0 であるべき（plan §7.1）
    imageDecode: { n: 0, ms: 0 }, // foreignObject SVG の <img> decode（capture の主コスト）
    lastActivity: 0,
  };
  window.__benchStats = stats;
  const mark = () => { stats.lastActivity = performance.now(); };

  const wrap = (obj, name, key) => {
    const orig = obj[name];
    if (typeof orig !== "function") return;
    obj[name] = function (...args) {
      const t = performance.now();
      const r = orig.apply(this, args);
      stats[key].ms += performance.now() - t;
      stats[key].n += 1;
      mark();
      return r;
    };
  };

  wrap(CanvasRenderingContext2D.prototype, "getImageData", "getImageData");
  wrap(CanvasRenderingContext2D.prototype, "putImageData", "putImageData");
  wrap(CanvasRenderingContext2D.prototype, "drawImage", "drawImage");
  wrap(HTMLCanvasElement.prototype, "toDataURL", "toDataURL");
  if (typeof WebGLRenderingContext !== "undefined") wrap(WebGLRenderingContext.prototype, "readPixels", "readPixels");
  if (typeof WebGL2RenderingContext !== "undefined") wrap(WebGL2RenderingContext.prototype, "readPixels", "readPixels");

  // createImageBitmap は Promise 返し（export 経路で使用）。preview では通常出ない。
  const origCIB = window.createImageBitmap;
  if (typeof origCIB === "function") {
    window.createImageBitmap = function (...args) {
      const t = performance.now();
      const p = origCIB.apply(this, args);
      return p.then((r) => { stats.createImageBitmap.ms += performance.now() - t; stats.createImageBitmap.n += 1; mark(); return r; });
    };
  }

  // foreignObject capture の <img src=data:image/svg...> decode を近似計測。
  // Image の src setter を hook し、data:image/svg で始まる load を計測する。
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  if (desc && desc.set) {
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: function (v) {
        if (typeof v === "string" && v.startsWith("data:image/svg")) {
          const t = performance.now();
          const onDone = () => { stats.imageDecode.ms += performance.now() - t; stats.imageDecode.n += 1; mark(); cleanup(); };
          const cleanup = () => { this.removeEventListener("load", onDone); this.removeEventListener("error", onDone); };
          this.addEventListener("load", onDone);
          this.addEventListener("error", onDone);
        }
        return desc.set.call(this, v);
      },
    });
  }
});

// ─── 2. 複雑 composite の synthetic project を構築 ───────────────────────────
const built = await ev(() => {
  const s = window.__mafterEditorStore.getState();
  const RASTER_W = 640, RASTER_H = 360;
  const MAIN_W = 1280, MAIN_H = 720;
  const DUR = 60;

  const solid = (name, color, size, z) => {
    const id = s.addSolid(name);
    s.updateObject(id, {
      zOrder: z,
      components: [{ type: "solid", props: {
        color: { value: color, keyframes: [] },
        size: { value: size, keyframes: [] },
      } }],
    });
    return id;
  };

  // --- Inner precomp: raster effect + blend + adjustment（→ nested 再帰 composite を誘発） ---
  const innerId = s.addTimelineComp("FX-Inner", { width: RASTER_W, height: RASTER_H, fps: 30, duration: DUR });
  s.setCurrentComp(innerId);
  solid("InnerBase", { r: 0.1, g: 0.2, b: 0.5, a: 1 }, { x: RASTER_W, y: RASTER_H, z: 0 }, 0);
  const innerMosaic = solid("InnerMosaic", { r: 0.9, g: 0.3, b: 0.1, a: 1 }, { x: 400, y: 240, z: 0 }, 1);
  s.addEffect(innerMosaic, "mosaic");         // raster effect（runRasterPipeline）
  s.setBlendMode(innerMosaic, "screen");       // CSS blend → export composite 分岐
  const innerText = s.addText("InnerWave");
  s.updateObject(innerText, { zOrder: 2 });
  s.addEffect(innerText, "wave");              // full displacement（capture 経路）
  const innerAdj = s.addRasterAdjustmentLayer("InnerAdj");
  s.updateObject(innerAdj, { zOrder: 3 });
  s.addEffect(innerAdj, "mosaic");             // adjustment raster（compositeContainer 再帰で焼く）

  // --- Main comp: blend + track matte + adjustment(raster) + nested precomp ---
  const mainId = s.addTimelineComp("Bench-Main", { width: MAIN_W, height: MAIN_H, fps: 30, duration: DUR });
  s.setCurrentComp(mainId);
  solid("BG", { r: 0.05, g: 0.05, b: 0.08, a: 1 }, { x: MAIN_W, y: MAIN_H, z: 0 }, 0);

  // blend レイヤー数枚
  const b1 = solid("Mul", { r: 0.8, g: 0.6, b: 0.2, a: 1 }, { x: 800, y: 500, z: 0 }, 1);
  s.setBlendMode(b1, "multiply");
  const b2 = solid("Ovl", { r: 0.2, g: 0.7, b: 0.9, a: 1 }, { x: 700, y: 450, z: 0 }, 2);
  s.setBlendMode(b2, "overlay");
  const b3 = solid("Scr", { r: 0.9, g: 0.2, b: 0.5, a: 1 }, { x: 600, y: 400, z: 0 }, 3);
  s.setBlendMode(b3, "screen");

  // raster effect レイヤー（自己 raster）
  const rlayer = solid("MosaicLayer", { r: 0.3, g: 0.9, b: 0.4, a: 1 }, { x: 500, y: 500, z: 0 }, 4);
  s.addEffect(rlayer, "mosaic");

  // track matte ペア（fill + matte）
  const matteSrc = solid("MatteSrc", { r: 1, g: 1, b: 1, a: 1 }, { x: 400, y: 400, z: 0 }, 6);
  const fill = solid("MatteFill", { r: 0.9, g: 0.8, b: 0.1, a: 1 }, { x: 400, y: 400, z: 0 }, 5);
  s.setTrackMatteMode(fill, "alpha");

  // adjustment(raster) with mosaic → runAdjustmentRasterPipeline / applyAdjustmentToMaster
  const adj = s.addRasterAdjustmentLayer("MainAdj");
  s.updateObject(adj, { zOrder: 7 });
  s.addEffect(adj, "mosaic");

  // nested precomp instance（compositeContainer 再帰・nested raster）
  const nest = s.addCompLayer(innerId, "FX-Inner-Instance");
  if (nest) s.updateObject(nest, { zOrder: 8 });

  s.setCurrentComp(mainId);
  s.setFrame(0);
  const fresh = window.__mafterEditorStore.getState();
  const proj = fresh.project;
  return {
    mainId, innerId,
    mainSize: [MAIN_W, MAIN_H], rasterSize: [RASTER_W, RASTER_H],
    layerCount: proj?.compositions.find((c) => c.id === mainId)?.objects.length ?? -1,
    innerLayerCount: proj?.compositions.find((c) => c.id === innerId)?.objects.length ?? -1,
  };
});

console.log("built project:", JSON.stringify(built));

// ─── 3. scrub 駆動 + settle 検出でフレーム時間を計測 ─────────────────────────
// setFrame → pixel-API 活動が idle になるまで（settle）を 1 フレームの処理時間とする。
async function scrubMeasure(frames, label) {
  const perFrame = [];
  const before = await ev(() => JSON.parse(JSON.stringify(window.__benchStats)));
  for (const f of frames) {
    const t = await ev(async (frame) => {
      const s = window.__mafterEditorStore.getState();
      const stats = window.__benchStats;
      const t0 = performance.now();
      stats.lastActivity = t0;
      s.setFrame(frame);
      // settle: 直近 pixel-API 活動から 100ms idle、最大 2000ms 待つ。
      const IDLE = 100, MAX = 2000;
      const deadline = t0 + MAX;
      // まず 1 tick 待って React 反映を促す
      await new Promise((r) => requestAnimationFrame(() => r()));
      for (;;) {
        const now = performance.now();
        if (now - stats.lastActivity >= IDLE) break;
        if (now >= deadline) break;
        await new Promise((r) => setTimeout(r, 16));
      }
      return performance.now() - t0;
    }, f);
    perFrame.push(t);
  }
  const after = await ev(() => JSON.parse(JSON.stringify(window.__benchStats)));
  const delta = {};
  for (const k of Object.keys(after)) {
    if (k === "lastActivity") continue;
    delta[k] = { n: after[k].n - before[k].n, ms: +(after[k].ms - before[k].ms).toFixed(1) };
  }
  const sorted = [...perFrame].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const summary = {
    label,
    frames: frames.length,
    avgFrameMs: +(perFrame.reduce((a, b) => a + b, 0) / perFrame.length).toFixed(1),
    p50FrameMs: +p(0.5).toFixed(1),
    p95FrameMs: +p(0.95).toFixed(1),
    maxFrameMs: +Math.max(...perFrame).toFixed(1),
    apiDelta: delta,
  };
  console.log(label, JSON.stringify(summary, null, 2));
  return summary;
}

const coldFrames = Array.from({ length: N_FRAMES }, (_, i) => i);
const cold = await scrubMeasure(coldFrames, "cold-scrub (distinct frames, cache miss)");
const warm = await scrubMeasure(coldFrames, "warm-scrub (re-scrub, cache hit)");

// ─── 4. 結果を保存 ──────────────────────────────────────────────────────────
const result = {
  when: new Date().toISOString(),
  note: "Phase 0 baseline — current CPU raster/composite pipeline (foreignObject capture + Canvas2D). GPU 化後の比較基準。",
  fixture: built,
  cold,
  warm,
  pageErrors: pageErrors.slice(0, 5),
  interpretation: {
    readPixelsInPreview: cold.apiDelta.readPixels.n,
    getImageDataInPreview: cold.apiDelta.getImageData.n,
    putImageDataInPreview: cold.apiDelta.putImageData.n,
    toDataURLInPreview: cold.apiDelta.toDataURL.n,
    imageDecodeInPreview: cold.apiDelta.imageDecode,
  },
};
writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
console.log("\nwrote", OUT_JSON);
console.log("pageErrors:", pageErrors.length);

await browser.close();
