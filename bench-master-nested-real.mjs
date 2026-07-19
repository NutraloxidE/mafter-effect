// master-nested-composite-performance-plan — local-real browser benchmark.
//
// Run with a trimmed copy of the real project that keeps project.json/fonts/images while omitting
// very large media files:
//   MASTER_NESTED_ZIP=C:\path\to\master-nested-local-real.zip node bench-master-nested-real.mjs
//
// The benchmark drives the actual PreviewPanel renderer with Caching OFF and compares the Phase 2/3
// cache flags independently. The fixture stays local and is never committed.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5173";
const APP_URL = `${process.env.VERIFY_HTTPS === "0" ? "http" : "https"}://127.0.0.1:${PORT}/`;
const ZIP_PATH = process.env.MASTER_NESTED_ZIP;
if (!ZIP_PATH || !fs.existsSync(ZIP_PATH)) {
  console.error("MASTER_NESTED_ZIP must point to an existing local-real fixture zip");
  process.exit(2);
}

const allVariants = [
  { name: "legacy", prepared: false, gpu: false, nested: false },
  { name: "nested", prepared: false, gpu: false, nested: true },
  { name: "prepared", prepared: true, gpu: false, nested: false },
  { name: "prepared+gpu", prepared: true, gpu: true, nested: false },
  { name: "all", prepared: true, gpu: true, nested: true },
];
const requestedVariants = new Set((process.env.BENCH_VARIANTS ?? "").split(",").filter(Boolean));
const variants = requestedVariants.size
  ? allVariants.filter((variant) => requestedVariants.has(variant.name))
  : allVariants;
const OUTPUT_DIR = process.env.BENCH_OUTPUT_DIR;
if (OUTPUT_DIR) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const hotFrames = Array.from({ length: 34 }, (_, i) => 376 + i);
const representativeFrame = 400;

const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

const results = [];
for (const variant of variants) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.route("**/__master_nested_fixture.zip", (route) => route.fulfill({ path: ZIP_PATH }));
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  const setup = await page.evaluate(async ({ prepared, gpu, nested }) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("mafter-effect-fs");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("IndexedDB reset blocked"));
    });
    localStorage.setItem(
      "mafter-preview-cache-v1",
      JSON.stringify({ enabled: false, maxRamMB: 256, enableDiskCache: false }),
    );
    globalThis.__mafterPreparedGeomCache = prepared;
    globalThis.__mafterGpuMeshCache = gpu;
    globalThis.__mafterNestedFrameReuse = nested;
    const storeApi = window.__mafterEditorStore;
    if (!storeApi) throw new Error("window.__mafterEditorStore unavailable");
    const { importZip } = await import("/src/fs/zip.ts");
    const response = await fetch("/__master_nested_fixture.zip");
    if (!response.ok) throw new Error(`fixture fetch failed: ${response.status}`);
    await importZip(storeApi.getState().getFs(), await response.arrayBuffer());
    await storeApi.getState().loadFromFs();

    const project = storeApi.getState().project;
    const master = project?.compositions.find((comp) => comp.kind === "timeline" && comp.name === "Master");
    if (!project || !master) throw new Error("Master composition not found");
    storeApi.getState().setCurrentComp(master.id);
    return { masterId: master.id, width: master.width, height: master.height };
  }, variant);

  await page.waitForSelector('[data-testid="preview-canvas-root"] > div', { timeout: 30_000 });
  await page.waitForTimeout(1_500); // asset fonts settle; missing large media is intentional in local-real fixture

  const measurements = await page.evaluate(async ({ frames }) => {
    const storeApi = window.__mafterEditorStore;
    const mesh = await import("/src/runtime/geom3d/geom3dMeshCache.ts");
    const gl = await import("/src/runtime/geom3d/geom3dGl.ts");
    const dom = await import("/src/runtime/DomRenderer.ts");
    const renderOne = async (frame) => {
      const t0 = performance.now();
      storeApi.getState().setFrame(frame);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return performance.now() - t0;
    };

    for (const frame of frames) await renderOne(frame); // warm DOM, geometry, shaders and buffers
    mesh.resetGeom3DPreparedBuildCount();
    gl.resetGeom3DGlBufferUploadCount();
    dom.resetDomRendererNestedFullRenderCount();
    const elapsed = [];
    for (const frame of frames) elapsed.push(await renderOne(frame));
    return {
      elapsed,
      flags: {
        prepared: globalThis.__mafterPreparedGeomCache === true,
        gpu: globalThis.__mafterGpuMeshCache === true,
        nested: globalThis.__mafterNestedFrameReuse === true,
      },
      preparedBuilds: mesh.geom3DPreparedBuildCount(),
      gpuUploads: gl.geom3DGlBufferUploadCount(),
      preparedEntries: mesh.geom3DPreparedCacheSize(),
      nestedFullRenders: dom.domRendererNestedFullRenderCount(),
      nestedStats: (() => {
        const stats = globalThis.__mafterNestedFrameReuseStats ?? {};
        const median = (values = []) => {
          const sorted = [...values].sort((a, b) => a - b);
          return sorted[Math.floor(sorted.length / 2)] ?? 0;
        };
        return {
          fullRenders: stats.fullRenders ?? 0,
          reuses: stats.reuses ?? 0,
          fullP50Ms: median(stats.fullDurationMs),
          reuseP50Ms: median(stats.reuseDurationMs),
          effectDomWrites: stats.effectDomWrites ?? 0,
          styleDomWrites: stats.styleDomWrites ?? 0,
        };
      })(),
    };
  }, { frames: hotFrames });

  await page.evaluate((frame) => window.__mafterEditorStore.getState().setFrame(frame), representativeFrame);
  await page.waitForTimeout(250);
  const stage = page.locator('[data-testid="preview-canvas-root"]').locator("..");
  const previewPng = await stage.screenshot();
  if (OUTPUT_DIR) fs.writeFileSync(`${OUTPUT_DIR}/master-nested-${variant.name}.png`, previewPng);
  const previewHash = createHash("sha256").update(previewPng).digest("hex");
  const visualState = await page.evaluate(() => ({
    geomCanvases: document.querySelectorAll("canvas.mafter-geom3d-canvas").length,
    nestedObjects: document.querySelectorAll('[data-testid="preview-canvas-root"] [data-object-id]').length,
    previewChildren: document.querySelector('[data-testid="preview-canvas-root"]')?.childElementCount ?? 0,
    videos: [...document.querySelectorAll('[data-testid="preview-canvas-root"] video')].map((video) => ({
      hasSource: Boolean(video.currentSrc),
      readyState: video.readyState,
      paused: video.paused,
    })),
    images: [...document.querySelectorAll('[data-testid="preview-canvas-root"] img')].map((image) => ({
      hasSource: Boolean(image.currentSrc),
      complete: image.complete,
    })),
  }));

  const exportHash = await page.evaluate(async (frame) => {
    const store = window.__mafterEditorStore.getState();
    const project = store.project;
    const master = project.compositions.find((comp) => comp.kind === "timeline" && comp.name === "Master");
    const { createCompFrameCaptureContext, captureCompFramePng } = await import(
      "/src/runtime/compFrameCapture.ts"
    );
    const context = await createCompFrameCaptureContext(project, master.id, store.getFs(), {
      textQuality: "precise",
      proxyScale: 1,
      proxyMaxDim: Math.max(master.width, master.height),
    });
    try {
      const png = await captureCompFramePng(context, master, frame);
      const digest = await crypto.subtle.digest("SHA-256", png);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    } finally {
      context.dispose();
    }
  }, representativeFrame);

  results.push({
    variant: variant.name,
    fixture: setup,
    frameCount: measurements.elapsed.length,
    p50Ms: Number(percentile(measurements.elapsed, 0.5).toFixed(2)),
    p95Ms: Number(percentile(measurements.elapsed, 0.95).toFixed(2)),
    maxMs: Number(Math.max(...measurements.elapsed).toFixed(2)),
    distinctP50Ms: Number(percentile(measurements.elapsed.filter((_, index) => index % 2 === 0), 0.5).toFixed(2)),
    duplicateP50Ms: Number(percentile(measurements.elapsed.filter((_, index) => index % 2 === 1), 0.5).toFixed(2)),
    preparedBuilds: measurements.preparedBuilds,
    preparedEntries: measurements.preparedEntries,
    gpuUploads: measurements.gpuUploads,
    nestedFullRenders: measurements.nestedFullRenders,
    nestedStats: measurements.nestedStats,
    flags: measurements.flags,
    visualState,
    previewHash,
    exportHash,
    pageErrors: pageErrors.filter((error) => !/favicon|media|decode/i.test(error)),
  });
  await context.close();
}

await browser.close();
const baseline = results[0];
for (const result of results) {
  result.p50Improvement = Number(((baseline.p50Ms - result.p50Ms) / baseline.p50Ms).toFixed(3));
  result.p95Improvement = Number(((baseline.p95Ms - result.p95Ms) / baseline.p95Ms).toFixed(3));
}
console.log(JSON.stringify(results, null, 2));

const previewParity = results.every((result) => result.previewHash === baseline.previewHash);
const exportParity = results.every((result) => result.exportHash === baseline.exportHash);
const noErrors = results.every((result) => result.pageErrors.length === 0);
console.log(`${previewParity ? "PASS" : "FAIL"} preview screenshot byte parity`);
console.log(`${exportParity ? "PASS" : "FAIL"} export PNG byte parity`);
console.log(`${noErrors ? "PASS" : "FAIL"} no unexpected page errors`);
process.exit(previewParity && exportParity && noErrors ? 0 : 1);
