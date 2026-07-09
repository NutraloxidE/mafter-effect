// Phase 4 (videoDecoder-compiled-leaf): verify that PreviewPanel/DomRenderer
// switches packed-alpha preview playback from the native <video> clock to the
// explicit WebCodecs PackedFrameDecoder path. Scrub/export are intentionally not
// exercised here; they keep the existing <video>-seek path.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5175";
const URL = `http://localhost:${PORT}/`;
const SAMPLE_MS = Number(process.env.VERIFY_SAMPLE_MS ?? 800);

const fixtures = [
  {
    label: "mp4-h264",
    route: "/__packed_decoder_fixture_mp4",
    path: path.resolve("test/fixtures/packedDemuxFixture-mp4.mp4"),
    meta: JSON.parse(fs.readFileSync(path.resolve("test/fixtures/packedDemuxFixture-mp4.meta.json"), "utf-8")),
    mime: "video/mp4",
    ext: "mp4",
  },
  {
    label: "webm-vp9",
    route: "/__packed_decoder_fixture_webm",
    path: path.resolve("test/fixtures/packedDemuxFixture-webm.webm"),
    meta: JSON.parse(fs.readFileSync(path.resolve("test/fixtures/packedDemuxFixture-webm.meta.json"), "utf-8")),
    mime: "video/webm",
    ext: "webm",
  },
];

const browser = await chromium.launch({ headless: false, channel: "chrome" }).catch(() =>
  chromium.launch({ headless: false }),
);
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.setDefaultTimeout(60_000);

const pageErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text());
});
page.on("pageerror", (e) => pageErrors.push(String(e)));

for (const fixture of fixtures) {
  await page.route(`**${fixture.route}`, (route) => route.fulfill({ path: fixture.path, contentType: fixture.mime }));
}

async function resetAppState() {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.deleteDatabase("mafter-effect-fs");
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
        req.onblocked = () => resolve(false);
      }),
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(() => window.__mafterEditorStore?.getState().getFs, { timeout: 20_000 });
}

async function setupFixture(fixture) {
  return await page.evaluate(
    async ({ route, label, ext, mime, meta }) => {
      const { demuxPackedVideo } = await import("/src/runtime/packedDemux.ts");
      const { newObjectId, newBinId } = await import("/src/core/ids.ts");
      const { DIR_ASSETS } = await import("/src/core/paths.ts");

      const bytes = new Uint8Array(await (await fetch(route)).arrayBuffer());
      const stream = await demuxPackedVideo(bytes, mime);
      const st = window.__mafterEditorStore.getState();
      const fsRef = st.getFs();
      const before = st.project;
      const comp = before.compositions.find((c) => c.kind === "timeline");
      if (!comp) throw new Error("no timeline comp in default project");

      const assetId = newObjectId();
      const binId = newBinId();
      const assetPath = `${DIR_ASSETS}/${assetId}.${ext}`;
      await fsRef.write(assetPath, bytes);

      const asset = {
        id: assetId,
        path: assetPath,
        binId,
        kind: "video",
        meta: {
          width: stream.codedWidth,
          height: meta.layout.contentHeight,
          duration: stream.frameCount / meta.fps,
          mime,
          hasAlpha: true,
          alphaMode: "packed",
          packedLayout: "topBottom",
          contentHeight: meta.layout.contentHeight,
          gutterPx: meta.layout.gutterPx,
        },
      };
      const after = {
        ...before,
        assets: [...before.assets, asset],
        bins: [...(before.bins ?? []), { id: binId, name: "Verify Packed Decoder", parentId: null }],
      };
      st.applyCommand({ label: `verify: add ${label} packed decoder asset`, before, after });
      st.setCurrentComp(comp.id);
      const objId = st.addVideoLayer(assetId, `packed-decoder-${label}`);
      if (!objId) throw new Error("addVideoLayer failed");
      st.setFrame(0);
      return { compId: comp.id, objId, assetId, codedWidth: stream.codedWidth, frameCount: stream.frameCount };
    },
    fixture,
  );
}

async function samplePlayback(objId) {
  return await page.evaluate(
    async ({ objId, sampleMs }) => {
      const samples = [];
      const t0 = performance.now();
      const hostSel = `[data-object-id="${objId}"]`;
      window.__mafterEditorStore.getState().setPlaying(true);
      return await new Promise((resolve) => {
        function tick() {
          const host = document.querySelector(hostSel);
          const video = host?.querySelector("video") ?? null;
          const canvas = host?.querySelector("canvas.mafter-packed-alpha-canvas") ?? null;
          const st = window.__mafterEditorStore.getState();
          samples.push({
            t: performance.now() - t0,
            frame: st.currentFrame,
            isPlaying: st.isPlaying,
            hasVideo: !!video,
            hasCanvas: !!canvas,
            decoderActive: video?.dataset.mafterPackedDecoder === "1",
            srcAttr: video?.getAttribute("src") ?? null,
            currentTime: video?.currentTime ?? null,
            targetSec: video?.dataset.mafterTargetSec ? Number(video.dataset.mafterTargetSec) : null,
            paused: video?.paused ?? null,
            readyState: video?.readyState ?? null,
          });
          if (performance.now() - t0 < sampleMs) {
            requestAnimationFrame(tick);
          } else {
            window.__mafterEditorStore.getState().setPlaying(false);
            resolve(samples);
          }
        }
        requestAnimationFrame(tick);
      });
    },
    { objId, sampleMs: SAMPLE_MS },
  );
}

async function canvasStats(objId) {
  return await page.evaluate((objId) => {
    const canvas = document.querySelector(`[data-object-id="${objId}"] canvas.mafter-packed-alpha-canvas`);
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width <= 0 || canvas.height <= 0) {
      return { exists: !!canvas, width: 0, height: 0, sampled: 0, nonTransparent: 0 };
    }
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { exists: true, width: canvas.width, height: canvas.height, sampled: 0, nonTransparent: 0 };
    ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
    const stride = Math.max(1, Math.floor((copy.width * copy.height) / 4096));
    let sampled = 0;
    let nonTransparent = 0;
    for (let px = 0; px < copy.width * copy.height; px += stride) {
      sampled += 1;
      if (data[px * 4 + 3] > 0) nonTransparent += 1;
    }
    return { exists: true, width: canvas.width, height: canvas.height, sampled, nonTransparent };
  }, objId);
}

async function decoderState(objId) {
  return await page.evaluate(async (objId) => {
    const { getPackedFrameDecoder, isPackedDecoderSupported } = await import("/src/runtime/packedFrameDecoder.ts");
    const host = document.querySelector(`[data-object-id="${objId}"]`);
    const video = host?.querySelector("video") ?? null;
    const canvas = host?.querySelector("canvas.mafter-packed-alpha-canvas") ?? null;
    const decoder = canvas instanceof HTMLCanvasElement ? getPackedFrameDecoder(canvas) : undefined;
    return {
      supported: isPackedDecoderSupported(),
      videoDataset: video ? { ...video.dataset } : null,
      videoSrc: video?.getAttribute("src") ?? null,
      canvasDataset: canvas instanceof HTMLCanvasElement ? { ...canvas.dataset } : null,
      hasDecoder: !!decoder,
      decoderBroken: decoder?.broken ?? null,
    };
  }, objId);
}

function analyze(label, samples, stats, decoderDebug) {
  const active = samples.filter((s) => s.decoderActive);
  const activeFrames = [...new Set(active.map((s) => s.frame))].sort((a, b) => a - b);
  const maxFrame = samples.reduce((m, s) => Math.max(m, s.frame ?? 0), 0);
  const srcCleared = active.some((s) => s.srcAttr === null || s.srcAttr === "");
  const nativePaused = active.every((s) => s.paused === true || s.srcAttr === null || s.srcAttr === "");
  const failures = [];
  if (samples.length < 10) failures.push("too few playback samples");
  if (maxFrame < 8) failures.push(`timeline did not advance enough (max frame ${maxFrame})`);
  if (active.length < 3) failures.push(`decoder path did not become active often enough (${active.length} samples)`);
  if (activeFrames.length < 2) failures.push(`decoder path did not remain active across frames (${activeFrames.join(",")})`);
  if (!srcCleared) failures.push("native video src was never cleared while decoder path was active");
  if (!nativePaused) failures.push("native video was not paused/cleared while decoder path was active");
  if (!stats.exists || stats.width <= 0 || stats.height <= 0) failures.push("packed alpha canvas was not present/sized");
  if (stats.nonTransparent <= 0) failures.push("packed alpha canvas appeared blank");
  const summary = {
    label,
    sampleCount: samples.length,
    maxFrame,
    activeSampleCount: active.length,
    activeFrames,
    srcCleared,
    nativePaused,
    canvas: stats,
    failures,
  };
  if (failures.length > 0) summary.decoderDebug = decoderDebug;
  return summary;
}

const summaries = [];
for (const fixture of fixtures) {
  console.log(`\n=== ${fixture.label} preview decoder integration ===`);
  await resetAppState();
  const setup = await setupFixture(fixture);
  console.log("setup:", setup);

  const hostSel = `[data-object-id="${setup.objId}"]`;
  await page.waitForSelector(`${hostSel} video`, { timeout: 20_000 });
  await page.waitForSelector(`${hostSel} canvas.mafter-packed-alpha-canvas`, { timeout: 20_000 });
  await page.waitForTimeout(300);

  const samples = await samplePlayback(setup.objId);
  await page.waitForTimeout(100);
  const stats = await canvasStats(setup.objId);
  const debug = await decoderState(setup.objId);
  const summary = analyze(fixture.label, samples, stats, debug);
  summaries.push(summary);
  console.log(JSON.stringify(summary, null, 2));
}

console.log("\npage errors:", pageErrors.length ? pageErrors : "(none)");

const failures = [
  ...summaries.flatMap((s) => s.failures.map((f) => `${s.label}: ${f}`)),
  ...pageErrors.map((e) => `page error: ${e}`),
];

await browser.close();

if (failures.length > 0) {
  console.error("\nFAIL:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}

console.log("\nPASS: PreviewPanel packed alpha playback uses WebCodecs decoder frames for mp4/H.264 and webm/VP9, with native video clock detached and nonblank canvas output.");
