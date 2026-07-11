/**
 * Real-Chrome, real-audio-capture measurement of the bundle loop-seam CLICK itself
 * (not just "is audio playing"). Exports an HTML bundle whose video layer's composition
 * loop range cuts the source mid-file (comp range shorter than source duration), so the
 * loop wrap is a genuine, non-tapered discontinuity — matching report.md's Comp 10 case
 * (source cut asymmetry: last-sample-before-cut non-zero, first-sample-of-restart ~zero).
 *
 * Detection method: tap every AudioNode->destination connection with a ScriptProcessorNode
 * that continuously scans real decoded samples for the max abs sample-to-sample delta per
 * ~23ms block. For a pure sine source, only the loop seam produces a large delta; everywhere
 * else the signal is smooth. This measures the actual "click" (waveform discontinuity), not
 * a proxy. Run this BEFORE a fix (expect periodic large spikes at the loop period) and AFTER
 * (expect spikes suppressed to background level) — compare the two JSON outputs.
 *
 * Usage:
 *   VERIFY_PORT=5173 node doc/issue/static-noise-problem/verify-loop-seam-click.mjs [--label before|after]
 */
import { chromium } from "playwright";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const PORT = process.env.VERIFY_PORT ?? "5173";
const APP_URL = `https://localhost:${PORT}/`;
const BUNDLE_PORT = Number(process.env.BUNDLE_PORT ?? "8972");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, ".verify-loop-seam-click-out");

const argv = process.argv.slice(2);
const labelIdx = argv.indexOf("--label");
const LABEL = labelIdx >= 0 ? argv[labelIdx + 1] : "run";
const RESULT_PATH = path.join(__dirname, `.loop-seam-click-${LABEL}.json`);

// 5s source, 137.3Hz sine. Loop range is [0,90] frames @ 30fps = 3.0s, i.e. shorter than the
// 5s source -> the wrap seeks video from source-time 3.0s back to source-time 0s, a genuine
// mid-file cut (verified offline: raw PCM jump ~0.076 at this exact boundary).
const VIDEO_PATH = process.env.VIDEO_PATH ?? path.join(
  process.env.TEMP ?? "/tmp",
  "claude/c--Workspace-mafter-effect/0e448ef5-614c-4c7a-9dcc-d763b69341da/scratchpad/loopseam_h264_aac.mp4",
);
const LOOP_RANGE = [0, 90]; // frames @ fps 30 -> 3.0s loop period
const FPS = 30;
const CAPTURE_MS = Number(process.env.CAPTURE_MS ?? "12000"); // several loop periods, generous under CPU throttling

const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".webm": "video/webm", ".mp4": "video/mp4" };

function startRangeServer(rootDir, port) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname.replace(/^\//, ""));
    if (rel === "") rel = "index.html";
    const fp = path.join(rootDir, rel);
    if (!fp.startsWith(rootDir) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404).end("nf");
      return;
    }
    const size = fs.statSync(fp).size;
    const type = MIME[path.extname(fp).toLowerCase()] ?? "application/octet-stream";
    const range = req.headers.range;
    if (range && size > 0) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? Number(m[1]) : 0;
      let end = m && m[2] ? Number(m[2]) : size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) end = size - 1;
      res.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      fs.createReadStream(fp, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": size });
      fs.createReadStream(fp).pipe(res);
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (!fs.existsSync(VIDEO_PATH)) {
  throw new Error(`Fixture not found: ${VIDEO_PATH}. Generate with ffmpeg first (see fix-plan-v2-minimal.md).`);
}

const browser = await chromium.launch({ args: ["--autoplay-policy=document-user-activation-required"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(APP_URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(500);

const videoBytes = fs.readFileSync(VIDEO_PATH);

console.log(`[${LABEL}] Exporting HTML bundle (loop range ${LOOP_RANGE[0]}-${LOOP_RANGE[1]} @ ${FPS}fps = mid-file cut)...`);
const zipB64 = await page.evaluate(async ({ bytes, name, range, fps }) => {
  const store = (await import("/src/editor/store.ts")).useEditorStore;
  const S = () => store.getState();
  for (let i = 0; i < 80 && !(S().project && S().currentCompId); i++) await new Promise((r) => setTimeout(r, 250));
  await S().newProject();
  const file = new File([new Uint8Array(bytes)], name, { type: "video/mp4" });
  const assetId = await S().importVideoAsset(file);
  if (!assetId) throw new Error("importVideoAsset failed");
  if (!S().addVideoLayer(assetId, "v")) throw new Error("addVideoLayer failed");
  await new Promise((r) => setTimeout(r, 400));
  await S().saveToFs();

  const { IndexedDbFs } = await import("/src/fs/IndexedDbFs.ts");
  const { exportBundle } = await import("/src/runtime/bundleExporter.ts");
  const fsDb = new IndexedDbFs("mafter-effect-fs");
  const cfg = { range, fps, scale: 0.5, format: "html-bundle", alpha: false, textRenderMode: "draft", loop: true };
  const result = await exportBundle(S().project, S().currentCompId, fsDb, cfg, () => {}, undefined);
  const ab = await result.blob.arrayBuffer();
  const u8 = new Uint8Array(ab);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}, { bytes: [...videoBytes], name: "loopseam.mp4", range: LOOP_RANGE, fps: FPS });

const zip = await JSZip.loadAsync(Uint8Array.from(atob(zipB64), (c) => c.charCodeAt(0)));
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [nm, entry] of Object.entries(zip.files)) {
  if (entry.dir) continue;
  const data = await entry.async("nodebuffer");
  const out = path.join(OUT_DIR, nm);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
}

const bp = await ctx.newPage();
bp.on("console", (m) => { if (m.type() === "error") errors.push(`bundle: ${m.text()}`); });

// Tap real decoded audio. Two sources exist depending on which code is under test:
//  (a) the player builds its own Web Audio graph (WP3+ controller) -> every connection into
//      AudioDestinationNode is tapped directly (matches verify-loop-audio-realchrome.mjs).
//  (b) the baseline player uses plain <video> + video.volume, no AudioContext at all -> the
//      harness must create its OWN AudioContext and route each <video> element through a
//      MediaElementAudioSourceNode to observe the real decoded samples (this does not change
//      what is audible: without also connecting to destination, creating the source node would
//      silence native playback per the postmortem's lesson, so we explicitly restore the path).
// A MutationObserver picks up videos created after boot (pooling/double-buffer swaps).
await bp.addInitScript(() => {
  window.__clickBlocks = [];
  window.__spNodes = [];
  const tappedElements = new WeakSet();

  // Nodes created BY this harness (script processor + zero-gain sink) must never be
  // re-tapped by the global connect() patch below, or the zero-signal sink's own
  // connect(destination) call recursively spawns a second, always-silent tap whose
  // all-zero blocks dilute the real median toward 0 (self-inflicted measurement bug).
  const harnessInternalNodes = new WeakSet();
  const manuallyTappedSources = new WeakSet();

  function attachScriptProcessorTap(actx, sourceNode, opts) {
    manuallyTappedSources.add(sourceNode);
    const sp = actx.createScriptProcessor(1024, 1, 1);
    harnessInternalNodes.add(sp);
    let lastSample = null;
    let sawNonSilentSample = false;
    sp.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      let maxDelta = 0;
      let allZero = true;
      let prev = lastSample;
      for (let i = 0; i < input.length; i++) {
        const v = input[i];
        if (v !== 0) allZero = false;
        if (prev !== null) {
          const d = Math.abs(v - prev);
          if (d > maxDelta) maxDelta = d;
        }
        prev = v;
      }
      lastSample = prev;
      // Skip leading silence (element muted / not yet decoding) so it can't masquerade as a
      // "quiet background" sample in the median; only start recording once real signal begins.
      if (allZero && !sawNonSilentSample) return;
      sawNonSilentSample = true;
      // videoCurrentTime lets us verify a spike actually lands at the loop wrap (source time
      // resets from ~loopDurationSec back to ~0), not some unrelated startup/mute transient.
      const videoCurrentTime = opts?.videoEl ? opts.videoEl.currentTime : null;
      window.__clickBlocks.push({ t: actx.currentTime, maxDelta, videoCurrentTime });
    };
    sourceNode.connect(sp);
    if (opts?.alsoConnectDestination) {
      const sink = actx.createGain();
      sink.gain.value = 0;
      harnessInternalNodes.add(sink);
      sp.connect(sink);
      sink.connect(actx.destination);
      sourceNode.connect(actx.destination); // restore audible path we would otherwise cut
    }
    window.__spNodes.push(sp);
  }

  // Case (a): player-owned AudioContext graph. Tap every connect() into its destination,
  // skipping this harness's own internal nodes and sources it has already tapped manually.
  const OrigConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = OrigConnect.call(this, dest, ...rest);
    try {
      if (
        dest instanceof AudioDestinationNode &&
        !harnessInternalNodes.has(this) &&
        !manuallyTappedSources.has(this)
      ) {
        attachScriptProcessorTap(dest.context, this, {
          alsoConnectDestination: false,
          videoEl: document.querySelector("video"), // best-effort correlation for a single-video comp
        });
      }
    } catch { /* best-effort tap */ }
    return r;
  };

  // Case (b): baseline <video>/<audio> element with no player-owned graph. Wire our own
  // measurement AudioContext directly on the element the first time we see it. This context
  // starts suspended under the blocked-autoplay policy, so resume it on the same user gesture
  // that unlocks the player (the test script clicks once; this listener piggybacks on that).
  let measureCtx = null;
  window.addEventListener("pointerdown", () => { if (measureCtx) void measureCtx.resume(); }, { capture: true });
  function tapMediaElement(el) {
    if (tappedElements.has(el)) return;
    tappedElements.add(el);
    try {
      if (!measureCtx) measureCtx = new AudioContext();
      const source = measureCtx.createMediaElementSource(el);
      attachScriptProcessorTap(measureCtx, source, { alsoConnectDestination: true, videoEl: el });
      void measureCtx.resume();
    } catch { /* element may already be routed through a player-owned graph (case a) */ }
  }

  function scanForMedia(root) {
    if (!(root instanceof Element) && !(root instanceof Document)) return;
    const els = root.querySelectorAll ? root.querySelectorAll("video,audio") : [];
    for (const el of els) tapMediaElement(el);
  }

  // Some players (v2-plus audio separation) create <audio> elements with
  // document.createElement("audio") and never append them to the DOM, so
  // querySelectorAll / MutationObserver can't see them. Hook play() so ANY media element
  // that actually plays gets tapped, attached or not. This is the authoritative signal that
  // real audio is flowing from that element.
  const OrigPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    try { tapMediaElement(this); } catch { /* best-effort */ }
    return OrigPlay.apply(this, a);
  };

  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) scanForMedia(node);
    }
  });
  document.addEventListener("DOMContentLoaded", () => {
    scanForMedia(document);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
});

const bundleServer = await startRangeServer(OUT_DIR, BUNDLE_PORT);
await bp.goto(`http://127.0.0.1:${BUNDLE_PORT}/index.html`, { waitUntil: "networkidle" });
await bp.waitForTimeout(800);

// Throttle the main thread (real CPU throttling via CDP, not a code mock) so DomRenderer's
// adaptiveRenderBudget genuinely skips frames — the actual failure precondition report.md
// describes ("adaptive frame skip drops the last declick volume write before the seek").
// Video decode is hardware/off-main-thread and keeps advancing; only JS-driven render/volume
// writes slow down, which is exactly the asymmetry the bug depends on.
const CPU_THROTTLE = Number(process.env.CPU_THROTTLE ?? "6");
if (CPU_THROTTLE > 1) {
  const cdp = await ctx.newCDPSession(bp);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  console.log(`[${LABEL}] CPU throttling active: ${CPU_THROTTLE}x slowdown (forces real adaptive render-gate skip).`);
}

// Unlock autoplay with a single click (not spacebar), matching real user behavior.
await bp.mouse.click(700, 450);
console.log(`[${LABEL}] Capturing ${CAPTURE_MS}ms of real decoded audio across ~${(CAPTURE_MS / 1000 / 3).toFixed(1)} loop periods...`);
await bp.waitForTimeout(CAPTURE_MS);

const blocks = await bp.evaluate(() => window.__clickBlocks);
await browser.close();
bundleServer.close();

if (blocks.length === 0) {
  console.error(`[${LABEL}] FAIL: no audio blocks captured (graph not built / no destination connection tapped).`);
  if (errors.length) console.log("Console errors:", errors.slice(0, 8));
  process.exit(1);
}

const LOOP_PERIOD_SEC = (LOOP_RANGE[1] - LOOP_RANGE[0]) / FPS;

// Find actual wrap events directly from video.currentTime (it decreases by more than half a
// loop period between consecutive blocks only at a real loop seek). This sidesteps percentile
// thresholds entirely — under CPU throttling, unrelated mid-clip drift-resync seeks (a real
// but separate artifact: videoElementSync's playing-state resync corrects decode drift, which
// itself produces clicks) inflate any background-noise-based threshold, masking the signal we
// actually want. Only blocks landing at a confirmed currentTime wrap count as the loop-seam click.
const withVct = blocks.filter((b) => b.videoCurrentTime !== null && b.videoCurrentTime !== undefined);
const wrapEvents = [];
for (let i = 1; i < withVct.length; i++) {
  if (withVct[i].videoCurrentTime < withVct[i - 1].videoCurrentTime - LOOP_PERIOD_SEC / 2) {
    // Report the delta at the wrap block itself (i) and the block immediately after (i+1),
    // since the seek discontinuity can land in either depending on ScriptProcessor buffer
    // alignment relative to the exact sample where the source jumps.
    wrapEvents.push({
      t: +withVct[i].t.toFixed(3),
      fromVideoCurrentTime: +withVct[i - 1].videoCurrentTime.toFixed(3),
      toVideoCurrentTime: +withVct[i].videoCurrentTime.toFixed(3),
      wrapBlockDelta: +withVct[i].maxDelta.toFixed(6),
      nextBlockDelta: withVct[i + 1] ? +withVct[i + 1].maxDelta.toFixed(6) : null,
    });
  }
}
const wrapPeakDeltas = wrapEvents.map((w) => Math.max(w.wrapBlockDelta, w.nextBlockDelta ?? 0));
const wrapPeak = wrapPeakDeltas.length ? Math.max(...wrapPeakDeltas) : null;
const wrapMean = wrapPeakDeltas.length ? wrapPeakDeltas.reduce((a, b) => a + b, 0) / wrapPeakDeltas.length : null;

// Steady-state background: median delta across blocks NOT adjacent to any wrap (for context
// only — a smooth continuous sine tone's own sample-to-sample derivative floor).
const wrapBlockIndices = new Set();
for (let i = 1; i < withVct.length; i++) {
  if (withVct[i].videoCurrentTime < withVct[i - 1].videoCurrentTime - LOOP_PERIOD_SEC / 2) {
    wrapBlockIndices.add(i - 1); wrapBlockIndices.add(i); wrapBlockIndices.add(i + 1);
  }
}
const backgroundDeltas = withVct.filter((_, i) => !wrapBlockIndices.has(i)).map((b) => b.maxDelta).sort((a, b) => a - b);
const backgroundMedian = backgroundDeltas[Math.floor(backgroundDeltas.length / 2)] ?? 0;

const result = {
  label: LABEL,
  loopPeriodSec: LOOP_PERIOD_SEC,
  blockCount: blocks.length,
  backgroundMedianDelta: +backgroundMedian.toFixed(6),
  wrapEventCount: wrapEvents.length,
  wrapPeakDelta: wrapPeak === null ? null : +wrapPeak.toFixed(6),
  wrapMeanPeakDelta: wrapMean === null ? null : +wrapMean.toFixed(6),
  wrapEvents,
};

if (process.env.DUMP_RAW) {
  fs.writeFileSync(
    path.join(__dirname, `.loop-seam-click-${LABEL}-raw.json`),
    JSON.stringify(blocks.map((b) => ({ t: +b.t.toFixed(3), videoCurrentTime: b.videoCurrentTime === null ? null : +b.videoCurrentTime.toFixed(3), maxDelta: +b.maxDelta.toFixed(6) })), null, 2),
  );
}
fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
console.log(`\nSaved: ${RESULT_PATH}`);
if (errors.length) console.log("Console errors:", errors.slice(0, 8));

if (wrapEvents.length === 0) {
  console.error(`[${LABEL}] FAIL: no loop-wrap event observed in the capture window (video.currentTime never reset) — increase CAPTURE_MS or check the fixture/range.`);
  process.exit(1);
}
console.log(`\n[${LABEL}] ${wrapEvents.length} loop-wrap event(s) observed. Peak click delta at the seam: ${result.wrapPeakDelta} (mean ${result.wrapMeanPeakDelta}), vs steady-state background ${result.backgroundMedianDelta}.`);
