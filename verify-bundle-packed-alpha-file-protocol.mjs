/**
 * §16.2b / §11.7 — Investigation script: does opening the exported HTML bundle via `file://`
 * (double-click index.html, no local server) freeze packed-alpha video playback, versus the same
 * bundle served over `http://`? This is the A/B leg the fix-plan flagged as unverified: the CPU
 * alpha-composite fallback's `getImageData`/`putImageData` can throw a SecurityError when the
 * source `<video>` was drawn from a tainted (file://-origin, non-blob) source — before the
 * previewPlaybackLoop/BundleAudioClock/previewAudioClock try/finally fix, an uncaught throw there
 * would kill the shared rAF tick permanently. This script reproduces both legs with an instrumented
 * headed Chromium and reports pageerrors, video.currentTime progression, and composite-canvas
 * pixel-hash progression so we can tell "hard hang" from "plays but never composites" from "fine".
 *
 * 用法: npm run dev (MAFTER_DEV_HTTP1=1 推奨) → node verify-bundle-packed-alpha-file-protocol.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const PORT = process.env.VERIFY_PORT ?? "5173";
const APP_URL = `http://localhost:${PORT}/`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, ".verify-bundle-packed-alpha-file-protocol-out");

const browser = await chromium.launch({ headless: false, channel: "chrome" }).catch(() =>
  chromium.launch({ headless: false }),
);

// ---- Phase 1: build a synthetic packed-alpha asset + export as an HTML bundle (same fixture
// pattern as verify-packed-alpha-e2e.mjs, so this is directly comparable to that known-passing case).
const setupPage = await browser.newPage({ viewport: { width: 1000, height: 800 } });
const setupErrors = [];
setupPage.on("console", (m) => { if (m.type() === "error") setupErrors.push(m.text()); });
setupPage.on("pageerror", (e) => setupErrors.push(String(e)));

await setupPage.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await setupPage.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await setupPage.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await setupPage.waitForFunction(() => window.__mafterEditorStore?.getState().getFs, { timeout: 20000 });

console.log("building synthetic packed-alpha asset + exporting html-bundle...");
const zipB64 = await setupPage.evaluate(async () => {
  const { encodeRgbaFramesToPackedVideo } = await import("/src/editor/subjectExtract/encodeAlphaWebm.ts");
  const { newObjectId, newBinId } = await import("/src/core/ids.ts");
  const { DIR_ASSETS } = await import("/src/core/paths.ts");

  const W = 96, H = 96, FPS = 12, FRAMES = 60; // a few seconds so a hang is unambiguous, not just slow
  const frames = [];
  for (let i = 0; i < FRAMES; i++) {
    const rgba = new Uint8ClampedArray(W * H * 4);
    const cx = 12 + (i / FRAMES) * (W - 24);
    const cy = H * 0.3;
    const r = 14;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = (y * W + x) * 4;
        const d = Math.hypot(x - cx, y - cy);
        if (d < r) {
          rgba[idx] = 220; rgba[idx + 1] = 40; rgba[idx + 2] = 40; rgba[idx + 3] = 255;
        } else {
          rgba[idx] = 0; rgba[idx + 1] = 0; rgba[idx + 2] = 0; rgba[idx + 3] = 0;
        }
      }
    }
    frames.push({ width: W, height: H, rgba });
  }
  const encoded = await encodeRgbaFramesToPackedVideo(frames, FPS, null);

  const st = window.__mafterEditorStore.getState();
  const fsRef = st.getFs();
  const assetId = newObjectId();
  const ext = encoded.container === "mp4" ? "mp4" : "webm";
  const assetPath = `${DIR_ASSETS}/${assetId}.${ext}`;
  await fsRef.write(assetPath, encoded.bytes);

  const before = st.project;
  const binId = newBinId();
  const asset = {
    id: assetId,
    path: assetPath,
    binId,
    kind: "video",
    meta: {
      width: W,
      height: encoded.layout.contentHeight,
      duration: FRAMES / FPS,
      mime: encoded.container === "mp4" ? "video/mp4" : "video/webm",
      hasAlpha: true,
      alphaMode: "packed",
      packedLayout: "topBottom",
      contentHeight: encoded.layout.contentHeight,
      gutterPx: encoded.layout.gutterPx,
    },
  };
  const bin = { id: binId, name: "Verify Packed FileProto", parentId: null };
  const comp = before.compositions.find((c) => c.kind === "timeline");
  const after = { ...before, assets: [...before.assets, asset], bins: [...(before.bins ?? []), bin] };
  st.applyCommand({ label: "verify: add packed asset", before, after });
  st.setCurrentComp(comp.id);
  const objId = st.addVideoLayer(assetId, "packed-test");
  if (!objId) throw new Error("addVideoLayer failed");

  await new Promise((r) => setTimeout(r, 300));

  // st.project was captured before applyCommand/addVideoLayer mutated the store — re-fetch fresh
  // state before exporting, or the exported bundle silently contains none of the new asset/layer.
  const freshProject = window.__mafterEditorStore.getState().project;

  const { exportBundle } = await import("/src/runtime/bundleExporter.ts");
  const cfg = {
    range: [0, FRAMES],
    fps: FPS,
    scale: 1,
    format: "html-bundle",
    alpha: false,
    textRenderMode: "draft",
    loop: true,
  };
  const result = await exportBundle(freshProject, comp.id, fsRef, cfg, () => {}, undefined);
  const ab = await result.blob.arrayBuffer();
  const u8 = new Uint8Array(ab);
  let bin_ = "";
  for (let i = 0; i < u8.length; i++) bin_ += String.fromCharCode(u8[i]);
  return btoa(bin_);
});

const zip = await JSZip.loadAsync(Uint8Array.from(atob(zipB64), (c) => c.charCodeAt(0)));
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, entry] of Object.entries(zip.files)) {
  if (entry.dir) continue;
  const data = await entry.async("nodebuffer");
  const outPath = path.join(OUT_DIR, name);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, data);
}
console.log("bundle written to", OUT_DIR, "files:", Object.keys(zip.files).join(", "));
if (setupErrors.length) console.log("setup page errors (informational):", setupErrors);
await setupPage.close();

// ---- Phase 2: instrumented playback probe, run once per leg (http-served vs file://-opened).
async function probeLeg(label, gotoFn) {
  console.log(`\n=== Leg: ${label} ===`);
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await gotoFn(page);
  await page.waitForTimeout(1500);

  const samples = [];
  for (let i = 0; i < 8; i++) {
    const s = await page.evaluate(() => {
      const v = document.querySelector("video");
      const canvas = document.querySelector("canvas.mafter-packed-alpha-canvas");
      let canvasHash = null;
      if (canvas) {
        try {
          const ctx = canvas.getContext("2d");
          const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let h = 0;
          for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0;
          canvasHash = h;
        } catch (e) {
          canvasHash = `ERR:${e.message}`;
        }
      }
      return {
        videoFound: !!v,
        paused: v?.paused ?? null,
        readyState: v?.readyState ?? null,
        currentTime: v ? +v.currentTime.toFixed(3) : null,
        canvasFound: !!canvas,
        canvasHash,
        canvasVisible: canvas ? canvas.style.display !== "none" : null,
        webglAvailable: canvas ? canvas.getContext("webgl") !== null : null,
      };
    });
    samples.push(s);
    await page.waitForTimeout(400);
  }

  console.log("samples:", JSON.stringify(samples, null, 0));
  console.log("pageerrors:", pageErrors);
  console.log("console errors:", consoleErrors.slice(0, 10));

  const firstT = samples[0]?.currentTime;
  const lastT = samples[samples.length - 1]?.currentTime;
  // Primary ground-truth signal (per debug-visual-render-bug: measure the real thing, not an
  // internal counter): does the <video> itself keep progressing over ~3s of real playback?
  const videoAdvanced = firstT != null && lastT != null && lastT > firstT + 0.1;
  // canvasHash is best-effort/informational only: our own probe reads the canvas via a 2D
  // context, but the app may have already bound it to WebGL (or left it 2D-locked after a CPU
  // fallback draw) — a canvas can only ever expose one context type, so our probe can throw the
  // *same* tainted-canvas SecurityError the app's own compositor hits under file://, or return
  // null if the app grabbed the other context type first. Neither is evidence of an app bug.
  const hashes = samples.map((s) => s.canvasHash).filter((h) => h !== null && !String(h).startsWith("ERR:"));
  const canvasHashReadable = hashes.length > 0;
  const uniqueHashes = new Set(hashes.map((h) => String(h)));
  const canvasChanged = uniqueHashes.size > 1;
  // A hard freeze (the bug we're checking for) manifests as an *uncaught* pageerror that kills
  // the tick — i.e. the loop stops rescheduling and videoAdvanced goes false. A SecurityError that
  // shows up only as a caught console.error (our fix's own `console.error("drawPackedAlphaComposite:
  // composite failed", err)` log line) is the fix working as intended, not a failure.
  const compositeErrorWasCaught = consoleErrors.some((e) => e.startsWith("drawPackedAlphaComposite:") || e.startsWith("drawSplitAlphaComposite:"));
  const sawUncaughtSecurityError = pageErrors.some((e) => /SecurityError|tainted/i.test(e)) && !compositeErrorWasCaught;

  await page.close();
  return {
    label,
    videoAdvanced,
    canvasChanged,
    canvasHashReadable,
    compositeErrorWasCaught,
    sawUncaughtSecurityError,
    pageErrorCount: pageErrors.length,
    samples,
  };
}

const legHttp = await probeLeg("http:// (Playwright route-served)", async (page) => {
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    let rel = decodeURIComponent(u.pathname.replace(/^\//, ""));
    if (rel === "") rel = "index.html";
    const fp = path.join(OUT_DIR, rel);
    if (!fs.existsSync(fp)) { await route.fulfill({ status: 404, body: "nf" }); return; }
    const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".mp4": "video/mp4", ".webm": "video/webm" };
    await route.fulfill({ status: 200, contentType: types[path.extname(fp).toLowerCase()] ?? "application/octet-stream", body: fs.readFileSync(fp) });
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle" });
});

const legFile = await probeLeg("file:// (direct, no local server, default Chromium security)", async (page) => {
  const indexPath = path.join(OUT_DIR, "index.html");
  await page.goto(`file://${indexPath.replace(/\\/g, "/")}`, { waitUntil: "networkidle" });
});

console.log("\n=== Summary ===");
for (const leg of [legHttp, legFile]) {
  console.log(
    `${leg.label}: videoAdvanced=${leg.videoAdvanced} sawUncaughtSecurityError=${leg.sawUncaughtSecurityError} ` +
    `compositeErrorWasCaught=${leg.compositeErrorWasCaught} canvasHashReadable=${leg.canvasHashReadable} ` +
    `pageErrorCount=${leg.pageErrorCount}`,
  );
}

// The regression this script guards against: playback (video.currentTime) must keep advancing —
// a hard hang means it stops dead. Whether the alpha composites correctly under file:// is a
// separate, accepted-degraded concern (canvas can go blank under file:// canvas-tainting; a
// local-server recommendation covers that — see doc/mafter-effect-spec.md §11.7).
const httpOk = legHttp.videoAdvanced && !legHttp.sawUncaughtSecurityError;
const fileOk = legFile.videoAdvanced && !legFile.sawUncaughtSecurityError;

if (httpOk && fileOk) {
  console.log("\n=> PASS: playback keeps advancing in both legs (no permanent hang). Any file://-only SecurityError was caught (see compositeErrorWasCaught), not fatal.");
} else if (httpOk && !fileOk) {
  console.log("\n=> FAIL: file:// leg hung or hit an uncaught SecurityError — the fix did not hold for this leg.");
} else if (!httpOk && !fileOk) {
  console.log("\n=> FAIL: BOTH legs hung/errored — this is not a file://-specific issue, investigate further.");
} else {
  console.log("\n=> Unexpected: file:// healthy but http:// is not — re-check the harness.");
}

await browser.close();
process.exit(httpOk && fileOk ? 0 : 1);
