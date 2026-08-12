// Swarm measurement harness (WP LOOP 1). Runs a fixed A/B sequence — A = local-only, B = swarm —
// in one real Chrome, and refuses to report a speedup for any run that cannot prove it was
// distributed correctly. Elapsed time is the last thing this prints, not the first.
//
//   SWARM_SEQUENCE=ABBA        run order. A = local-only, B = swarm.
//   SWARM_MODE=WARM|COLD       COLD reloads the host page (and the project) before every run.
//   SWARM_FRAMES=24            export length.
//   SWARM_EXTERNAL_WORKER=1    wait for a worker on another machine instead of opening one here.
//   SWARM_WARMUP_TOLERANCE=0.05  consecutive warmup runs must agree within this to start measuring.
//   SWARM_WARMUP_MAX=5         give up (and declare the bench non-stationary) after this many.
import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import path from "node:path";

const APP = process.env.SWARM_APP_URL ?? "https://mafter-effect.pages.dev/";
const ZIP = path.resolve(process.env.SWARM_ZIP ?? "verify-comp33-mini-project.zip");
const FRAMES = Number(process.env.SWARM_FRAMES ?? 24);
const EXPORT_TIMEOUT_MS = Number(process.env.SWARM_EXPORT_TIMEOUT_MS ?? 600000);
const SEQUENCE = (process.env.SWARM_SEQUENCE ?? "ABBA").toUpperCase().split("").filter((c) => c === "A" || c === "B");
const MODE = (process.env.SWARM_MODE ?? "WARM").toUpperCase() === "COLD" ? "COLD" : "WARM";
const WARMUP_TOLERANCE = Number(process.env.SWARM_WARMUP_TOLERANCE ?? 0.05);
const WARMUP_MAX = Number(process.env.SWARM_WARMUP_MAX ?? 5);

const FRAMES_RE = /Frames (?:used )?from workers: [^\n]*/;
const PHASE_RE = /(Frame \d+\/\d+|Rendering frame \d+\/\d+|Packaging[^\n]*|Worker output rejected[^\n]*|Sending footage[^\n]*)/;
const text = (page) => page.evaluate(() => document.body.innerText);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * The bundle filename carries the build's content hash, so it identifies the code that actually
 * ran. Comparing runs built from different code is the mistake this exists to make visible.
 */
const buildTag = (page) => page.evaluate(() =>
  [...document.querySelectorAll("script[src]")].map((s) => s.src.split("/").pop()).join(","));

const swarmState = (page) => page.evaluate(() => {
  const snapshot = window.__mafterSwarmStore?.getSnapshot?.();
  return {
    metrics: snapshot?.metrics ?? null,
    // Reset by exportComposition, so this is the frame count for the run that just finished.
    hostRenderedFrames: globalThis.__mafterHostRenderCost?.frames ?? null,
    hostMsPerFrame: globalThis.__mafterHostRenderCost?.frames
      ? globalThis.__mafterHostRenderCost.ms / globalThis.__mafterHostRenderCost.frames
      : null,
    availableCompute: snapshot?.availableCompute ?? null,
    workers: (snapshot?.workers ?? []).map((w) => ({
      state: w.state,
      runtimeVersion: w.capabilities?.runtimeVersion ?? null,
      score: w.performance?.benchmarkScore ?? null,
      measured: w.performance?.measured ?? false,
      renderMsPerFrame: w.performance?.recentRenderMs ?? null,
    })),
  };
});

async function runExport(page, mode, label) {
  // Read at export time, so a single page can alternate between local-only and swarm runs.
  await page.evaluate((swarm) => window.localStorage.setItem("mafter.swarm.export", swarm ? "1" : "0"), mode === "B");
  const before = await swarmState(page);

  await page.evaluate((frames) => {
    [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Export"))?.click();
    window.__zipBase64 = null;
    const originalCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (blob && blob.type === "application/zip") {
        blob.arrayBuffer().then((buffer) => {
          let binary = "";
          const bytes = new Uint8Array(buffer);
          for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
          window.__zipBase64 = btoa(binary);
        });
      }
      return originalCreate(blob);
    };
    window.__frames = frames;
  }, FRAMES);
  await page.waitForTimeout(1200);

  await page.evaluate(() => {
    const dialog = [...document.querySelectorAll("div")].find((d) => d.innerText.startsWith("Export — "));
    const set = (el, value) => {
      Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const selects = dialog.querySelectorAll("select");
    set(selects[0], [...selects[0].options].find((o) => o.text.includes("PNG")).value);
    set(selects[1], [...selects[1].options].find((o) => o.text.includes("0.5")).value);
    const inputs = dialog.querySelectorAll("input");
    set(inputs[0], "0");
    set(inputs[1], String(window.__frames));
  });
  await page.waitForTimeout(400);

  const startedAt = Date.now();
  await page.evaluate(() => {
    const dialog = [...document.querySelectorAll("div")].find((d) => d.innerText.startsWith("Export — "));
    [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "Export").click();
  });

  const deadline = Date.now() + EXPORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => window.__zipBase64 !== null)) break;
    await page.waitForTimeout(10000);
    const body = await text(page);
    console.log(`  ...${label}: ${PHASE_RE.exec(body)?.[0] ?? "-"} | ${FRAMES_RE.exec(body)?.[0] ?? "-"}`);
  }
  const seconds = (Date.now() - startedAt) / 1000;
  const base64 = await page.evaluate(() => window.__zipBase64);
  const zipPath = `swarm-export-${label}.zip`;
  if (base64) await writeFile(zipPath, Buffer.from(base64, "base64"));

  const after = await swarmState(page);
  const delta = (key) => (after.metrics?.[key] ?? 0) - (before.metrics?.[key] ?? 0);

  await page.evaluate(() => {
    const dialog = [...document.querySelectorAll("div")].find((d) => d.innerText.startsWith("Export — "));
    [...(dialog?.querySelectorAll("button") ?? [])].find((b) => ["Close", "✕"].includes(b.textContent.trim()))?.click();
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);

  return {
    label,
    mode,
    seconds: Number(seconds.toFixed(1)),
    completed: Boolean(base64),
    zipPath: base64 ? zipPath : null,
    zipBytes: base64 ? Buffer.from(base64, "base64").length : null,
    buildTag: await buildTag(page),
    workers: after.workers,
    hostRenderedFrames: after.hostRenderedFrames,
    hostMsPerFrame: after.hostMsPerFrame === null ? null : Math.round(after.hostMsPerFrame),
    availableCompute: after.availableCompute,
    // The number a worker exists to move. Adopted frames the host also drew are worth nothing.
    localFramesAvoided: after.hostRenderedFrames === null ? null : FRAMES - after.hostRenderedFrames,
    adoptedRemoteFrames: delta("adoptedRemoteFrames"),
    remoteFramesReceived: delta("remoteFrames"),
    localFallbackJobs: delta("localFallbackJobs"),
    ineligibleJobs: delta("ineligibleJobs"),
    staleResultsDiscarded: delta("staleResultsDiscarded"),
    panel: FRAMES_RE.exec(await text(page))?.[0] ?? "-",
  };
}

/**
 * Frame-by-frame size comparison against the local-only baseline. A frame whose footage never
 * decoded is an order of magnitude smaller than the same frame rendered here, so this catches "the
 * export finished and every number looked fine" without decoding any pixels.
 */
async function compareAgainstBaseline(baselinePath, runPath) {
  try {
    const [baseline, run] = await Promise.all([
      JSZip.loadAsync(await readFile(baselinePath)),
      JSZip.loadAsync(await readFile(runPath)),
    ]);
    const suspect = [];
    let compared = 0;
    for (const name of Object.keys(run.files).sort()) {
      if (!name.endsWith(".png") || !baseline.files[name]) continue;
      compared += 1;
      const [a, b] = await Promise.all([
        run.files[name].async("uint8array"),
        baseline.files[name].async("uint8array"),
      ]);
      if (Math.abs(a.length - b.length) / Math.max(a.length, b.length) > 0.5) suspect.push(name);
    }
    return { compared, suspectFrames: suspect.length, first: suspect.slice(0, 6) };
  } catch (error) {
    return { compared: 0, suspectFrames: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A swarm run counts as a performance measurement only if it demonstrably distributed work and got
 * the right pixels back. Every other run is data about correctness, never about speed.
 */
function validate(run, correctness, expectedBuildTag) {
  const reasons = [];
  if (!run.completed) reasons.push("export did not finish");
  if (run.buildTag !== expectedBuildTag) reasons.push(`build tag drifted (${run.buildTag})`);
  // Negative control for the counter itself: with no worker in play the host must draw every
  // frame exactly once. Any other number means localFramesAvoided is measuring nothing.
  if (run.mode === "A" && run.hostRenderedFrames !== FRAMES) {
    reasons.push(`host frame counter reads ${run.hostRenderedFrames}, expected ${FRAMES}`);
  }
  if (run.mode === "B") {
    if (run.adoptedRemoteFrames <= 0) reasons.push("no remote frame reached the output");
    if (run.localFramesAvoided <= 0) reasons.push(`worker saved no local work (host drew ${run.hostRenderedFrames}/${FRAMES})`);
    if (run.localFallbackJobs > 0) reasons.push(`${run.localFallbackJobs} local fallbacks`);
    if (run.ineligibleJobs > 0) reasons.push(`${run.ineligibleJobs} jobs missing dependencies`);
    if (run.staleResultsDiscarded > 0) reasons.push(`${run.staleResultsDiscarded} stale results`);
    if (correctness?.suspectFrames !== 0) reasons.push(`pixel parity: ${correctness?.error ?? `${correctness?.suspectFrames} suspect frames`}`);
    const mismatched = run.workers.filter((w) => w.runtimeVersion && w.runtimeVersion !== "mafter-render-runtime-v1");
    if (mismatched.length) reasons.push("worker runtime version differs from host");
  }
  return reasons;
}

function report(runs) {
  for (const run of runs) {
    console.log(`
SWARM RUN — ${run.label} (${run.mode === "A" ? "local-only" : "swarm"}, ${MODE})

Correctness
  pixel parity:      ${run.mode === "A" ? "baseline" : run.correctness?.error ?? (run.correctness?.suspectFrames === 0 ? "PASS" : "FAIL")}
  suspect frames:    ${run.correctness?.suspectFrames ?? "-"} / ${run.correctness?.compared ?? "-"}
  stale results:     ${run.staleResultsDiscarded}

Work
  total frames:      ${FRAMES}
  host rendered:     ${run.hostRenderedFrames}
  local avoided:     ${run.localFramesAvoided}
  remote received:   ${run.remoteFramesReceived}
  remote adopted:    ${run.adoptedRemoteFrames}
  local fallback:    ${run.localFallbackJobs}
  missing deps:      ${run.ineligibleJobs}

Capacity
  host ms/frame:     ${run.hostMsPerFrame ?? "-"}
  worker ms/frame:   ${run.workers.map((w) => w.renderMsPerFrame === null ? "-" : Math.round(w.renderMsPerFrame)).join(", ")}
  reported:          ${run.availableCompute?.toFixed?.(2) ?? "-"}x local (${run.workers.some((w) => w.measured) ? "measured on this comp" : "ESTIMATED from empty comp"})

Total
  elapsed:           ${run.seconds}s
  build:             ${run.buildTag}

VALID PERFORMANCE RUN: ${run.invalidReasons.length === 0 ? "YES" : `NO — ${run.invalidReasons.join("; ")}`}`);
  }

  const valid = (mode) => runs.filter((r) => r.mode === mode && r.invalidReasons.length === 0).map((r) => r.seconds);
  const localMedian = median(valid("A"));
  const swarmMedian = median(valid("B"));
  const avoided = runs.filter((r) => r.mode === "B" && r.invalidReasons.length === 0).map((r) => r.localFramesAvoided);
  console.log(`
SEQUENCE ${SEQUENCE.join("")} / ${MODE}
  warmup:            ${warmup.trace.join("s, ")}s ${warmup.converged ? "(converged)" : "(NOT STATIONARY)"}
  local-only median: ${localMedian ?? "-"}s  (n=${valid("A").length})
  swarm median:      ${swarmMedian ?? "-"}s  (n=${valid("B").length})
  local frames avoided (median): ${median(avoided) ?? "-"} of ${FRAMES}`);
  if (!warmup.converged) console.log("  PERFORMANCE RESULT INVALID — bench never reached a steady state");
  else if (localMedian && swarmMedian) console.log(`  effective speedup: ${(localMedian / swarmMedian).toFixed(2)}x`);
  else console.log("  PERFORMANCE RESULT INVALID — no valid run on both sides");
}

// A persistent profile keeps the host device identity stable, which is what lets it reattach to
// the same join code after a restart instead of stranding connected workers.
const PROFILE = process.env.SWARM_PROFILE ?? path.join(process.env.TEMP ?? ".", "mafter-swarm-host-profile");
const HOST_CODE = (process.env.SWARM_HOST_CODE ?? "").trim().toUpperCase();
const hostCtx = await chromium.launchPersistentContext(PROFILE, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1180, height: 820 },
  ignoreHTTPSErrors: true,
  args: ["--ignore-certificate-errors"],
});
const browser = hostCtx.browser() ?? { newContext: () => hostCtx.browser().newContext(), close: () => hostCtx.close() };
await hostCtx.addInitScript((init) => {
  window.localStorage.setItem("mafter.swarm.export", "1");
  if (init.code) window.localStorage.setItem("mafter.swarm.hostCode", init.code);
  else window.localStorage.removeItem("mafter.swarm.hostCode");
  if (init.tolerance) globalThis.__mafterSwarmTolerance = init.tolerance;
}, { code: HOST_CODE, tolerance: Number(process.env.SWARM_TOLERANCE ?? 0) });
const host = hostCtx.pages()[0] ?? await hostCtx.newPage();
host.on("console", (m) => { const t = m.text(); if (t.includes("swarm") || m.type() === "error" || m.type() === "warning") console.log(`HOSTLOG[${m.type()}]:`, t.slice(0, 300)); });

/** Loads the app and the project. Called again per run in COLD mode to drop every warm cache. */
async function loadProject() {
  // A persistent profile caches the previous deploy, which silently measures old code; a query
  // string busts it without adding headers that would force a CORS preflight on every API call.
  await host.goto(`${APP}${APP.includes("?") ? "&" : "?"}cb=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await host.waitForTimeout(4000);
  await host.setInputFiles('input[type=file][accept=".zip"]', ZIP);
  await host.waitForTimeout(15000);
  console.log("loaded:", JSON.stringify(await host.evaluate(() => {
    const state = window.__mafterEditorStore?.getState?.();
    const comp = state?.project?.compositions?.find((c) => c.id === state.currentCompId);
    return { comp: comp?.name, objects: comp?.objects?.length, visibility: document.visibilityState };
  })));
}
await loadProject();
const EXPECTED_BUILD = await buildTag(host);
console.log("build:", EXPECTED_BUILD);

// Opening the panel and minting a session can take a moment; retry rather than crash on undefined.
async function joinUrlFromPanel() {
  let joinUrl;
  for (let attempt = 0; attempt < 20 && !joinUrl; attempt += 1) {
    if (!(await text(host)).includes("Render Workers")) {
      await host.locator("button", { hasText: "Workers" }).first().click({ timeout: 20000 }).catch(() => {});
    }
    await host.waitForTimeout(3000);
    joinUrl = await host.evaluate(() => (/https?:\/\/\S+\/w\/[A-Z0-9]+/.exec(document.body.innerText) ?? [])[0]);
  }
  if (!joinUrl) {
    const body = await text(host);
    const panel = body.indexOf("Render Workers");
    throw new Error(`host never produced a join URL. panel=${panel < 0 ? "not open" : JSON.stringify(body.slice(panel, panel + 300))}`);
  }
  return joinUrl;
}
const joinUrl = await joinUrlFromPanel();
console.log("join:", joinUrl);
if (!process.env.SWARM_EXTERNAL_WORKER) {
  const worker = await (await browser.newContext({ viewport: { width: 640, height: 560 }, ignoreHTTPSErrors: true })).newPage();
  worker.on("console", (m) => console.log("worker console:", m.type(), m.text().slice(0, 300)));
  await worker.goto(joinUrl, { waitUntil: "domcontentloaded" });
  await worker.waitForTimeout(6000);
} else {
  console.log("waiting for an external worker to join…");
}

// Approve joins for as long as the host lives: a worker that arrives mid-export, or reconnects
// after one, must not sit at "waiting for host approval" with nobody listening.
let stopWatching = false;
const approvalWatcher = (async () => {
  while (!stopWatching) {
    try {
      const panelOpen = (await text(host)).includes("Render Workers");
      if (!panelOpen) await host.locator("button", { hasText: "Workers" }).first().click({ timeout: 5000 }).catch(() => {});
      const approved = await host.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Allow");
        button?.click();
        return Boolean(button);
      });
      if (approved) console.log("approved a join request");
    } catch { /* the page may be busy exporting; try again next tick */ }
    await host.waitForTimeout(3000);
  }
})();

/** READY is emitted only after the worker has acknowledged every required asset hash. */
async function waitForWorkerReady() {
  const deadline = Date.now() + Number(process.env.SWARM_JOIN_WAIT_MS ?? 120000);
  let ready = false;
  while (Date.now() < deadline) {
    const { workers } = await swarmState(host);
    if (workers.some((w) => w.state === "ready")) {
      ready = true;
      break;
    }
    await host.waitForTimeout(3000);
  }
  await host.waitForTimeout(8000);
  if (!ready) throw new Error("worker READY not observed after asset synchronization deadline");
  console.log("panel:", /Connected[\s\S]{0,140}/.exec(await text(host))?.[0]?.replace(/\n/g, " ") ?? "READY observed");
}
await waitForWorkerReady();

/**
 * The first export of a session is slower than every one after it — 40.4s against 30.9s for the
 * same code, which is a 30% bias sitting on whichever run happens to go first. Burn local-only
 * runs until two consecutive ones agree, so the measured sequence starts on a stationary bench.
 * Not converging is a result: it means this environment cannot support an A/B at all.
 */
async function convergeWarmup() {
  const trace = [];
  for (let attempt = 0; attempt < WARMUP_MAX; attempt += 1) {
    const run = await runExport(host, "A", `warmup-${attempt + 1}`);
    trace.push(run.seconds);
    const [previous, current] = trace.slice(-2);
    if (trace.length >= 2 && Math.abs(current - previous) / Math.min(current, previous) <= WARMUP_TOLERANCE) {
      console.log(`warmup converged after ${trace.length}: ${trace.join("s, ")}s`);
      return { trace, converged: true };
    }
  }
  console.log(`warmup NEVER CONVERGED: ${trace.join("s, ")}s`);
  return { trace, converged: false };
}
const warmup = await convergeWarmup();

const runs = [];
let baselinePath = process.env.SWARM_BASELINE_ZIP ?? null;
for (const [index, mode] of SEQUENCE.entries()) {
  if (MODE === "COLD" && index > 0) {
    await loadProject();
    await waitForWorkerReady();
  }
  const run = await runExport(host, mode, `${index + 1}-${mode === "A" ? "local-only" : "swarm"}`);
  if (mode === "A" && !baselinePath && run.zipPath) baselinePath = run.zipPath;
  run.correctness = mode === "B" && baselinePath && run.zipPath
    ? await compareAgainstBaseline(baselinePath, run.zipPath)
    : { compared: 0, suspectFrames: mode === "A" ? 0 : null, error: mode === "B" ? "no baseline" : undefined };
  run.invalidReasons = validate(run, run.correctness, EXPECTED_BUILD);
  runs.push(run);
  console.log(`run ${run.label}: ${run.seconds}s, adopted ${run.adoptedRemoteFrames}, valid=${run.invalidReasons.length === 0}`);
}

report(runs);
console.log("RAW", JSON.stringify(runs));

if (process.env.SWARM_KEEP_OPEN) {
  console.log("host stays open; workers keep their session. Ctrl-C to stop.");
  await new Promise(() => {});
}
stopWatching = true;
await approvalWatcher;
await hostCtx.close();
