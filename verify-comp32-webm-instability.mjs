// Comp 32（mafter-project 23）Subject Extract split-alpha 実機検証。
// doc/issue/subject-extract-split-alpha-webm-preview-instability.md の裏取り用:
//  1. holdTimeline の実発火（currentFrame の停滞）
//  2. color/alpha companion のドリフト実測
//  3. warm-up レース（scrub直後即Play vs 待ってからPlay）の再現性
//  4. decode セッション HW/SW（CDP Media domain）
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `http://localhost:${PORT}/`;
const ZIP = path.resolve("verify-comp32-mini-project.zip");

const COMP32 = "01KWSRT0CQGZKJ0FNKEAD41F7M";
const BG_LAYER = "01KWSRTF8GZVCBCTQ372RW9MBN";
const PERSON_LAYER = "01KWSS67VPCYTP5XKWPN1BP0EP";
const START_FRAME = 20;
const SAMPLE_MS = 3000;

const zipStat = fs.statSync(ZIP);
console.log("zip bytes:", zipStat.size);

const HEADLESS = process.env.VERIFY_HEADLESS !== "0";
const browser = HEADLESS
  ? await chromium.launch({ headless: true })
  : await chromium.launch({ headless: false, channel: "chrome" }).catch(() =>
      chromium.launch({ headless: false }),
    );
browser.on("disconnected", () => console.error("!!! browser disconnected unexpectedly !!!"));
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("crash", () => console.error("!!! page crashed !!!"));
page.setDefaultTimeout(300_000);
const pageErrors = [];
page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
page.on("pageerror", (e) => pageErrors.push(String(e)));

// 204MB の zip を JS 配列として evaluate 引数に渡すと V8 heap が溢れるため、
// 仮想 URL に route.fulfill でファイルを直結し、ページ内 fetch() で取得する。
await page.route("**/__verify_project.zip", (route) => route.fulfill({ path: ZIP, contentType: "application/zip" }));

// --- CDP Media domain: HW/SW decode session 診断 ---
const cdp = await page.context().newCDPSession(page);
await cdp.send("Media.enable");
const mediaLog = []; // { ts, playerId, kind, data }
cdp.on("Media.playerPropertiesChanged", (ev) => {
  mediaLog.push({ ts: Date.now(), playerId: ev.playerId, kind: "properties", data: ev.properties });
});
cdp.on("Media.playersCreated", (ev) => {
  mediaLog.push({ ts: Date.now(), kind: "created", playerIds: ev.players });
});
cdp.on("Media.playerEventsAdded", (ev) => {
  mediaLog.push({ ts: Date.now(), playerId: ev.playerId, kind: "events", data: ev.events });
});

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => window.__mafterEditorStore?.getState().getFs, { timeout: 20000 });

console.log("importing project zip...");
await page.evaluate(async () => {
  const resp = await fetch("/__verify_project.zip");
  const buf = new Uint8Array(await resp.arrayBuffer());
  const { importZip } = await import("/src/fs/zip.ts");
  const st = window.__mafterEditorStore.getState();
  await importZip(st.getFs(), buf);
  await st.loadFromFs();
});

await page.evaluate((compId) => {
  window.__mafterEditorStore.getState().setCurrentComp(compId);
}, COMP32);
await page.waitForTimeout(500);

// PreviewPanel をマウントさせるため実際の Preview パネルタブを表示させる想定。
// (このプロジェクトの UI 構成上デフォルトで Preview が表示される前提。video 要素が生えるまで待つ)
await page.waitForFunction(
  (bgLayer) => document.querySelector(`[data-object-id="${bgLayer}"] video`) !== null,
  BG_LAYER,
  { timeout: 20000 },
).catch(() => console.warn("WARN: background video element not found within timeout"));

// --- サンプリングヘルパ: currentFrame / isPlaying / 3本の video 状態を rAF で記録 ---
const sampleScript = ({ durationMs, bgLayer, personLayer }) => {
  return new Promise((resolve) => {
    const log = [];
    const bgSel = `[data-object-id="${bgLayer}"] video`;
    const colorSel = `[data-object-id="${personLayer}"] video:not(.mafter-split-alpha)`;
    const alphaSel = `[data-object-id="${personLayer}"] video.mafter-split-alpha`;
    const t0 = performance.now();
    function sampleVideo(el) {
      if (!el) return null;
      return {
        currentTime: el.currentTime,
        readyState: el.readyState,
        paused: el.paused,
        seeking: el.seeking,
        playbackRate: el.playbackRate,
      };
    }
    function tick() {
      const st = window.__mafterEditorStore.getState();
      log.push({
        t: performance.now() - t0,
        currentFrame: st.currentFrame,
        isPlaying: st.isPlaying,
        bg: sampleVideo(document.querySelector(bgSel)),
        color: sampleVideo(document.querySelector(colorSel)),
        alpha: sampleVideo(document.querySelector(alphaSel)),
      });
      if (performance.now() - t0 < durationMs) {
        requestAnimationFrame(tick);
      } else {
        resolve(log);
      }
    }
    requestAnimationFrame(tick);
  });
};

function analyze(log, label) {
  const fps = 30;
  const frameSec = 1 / fps;
  // --- currentFrame 停滞（hold）検出: isPlaying=true 中に currentFrame が同じ値のまま
  //     連続で expected 1コマ以上の実時間が経過している区間 ---
  const stalls = [];
  let stallStart = null;
  let lastFrame = null;
  let lastFrameChangeT = null;
  for (const s of log) {
    if (!s.isPlaying) { stallStart = null; lastFrame = null; continue; }
    if (lastFrame === null || s.currentFrame !== lastFrame) {
      if (stallStart !== null && lastFrameChangeT !== null) {
        const dur = lastFrameChangeT - stallStart;
        if (dur > frameSec * 1000 * 1.5) stalls.push({ frame: lastFrame, startT: stallStart, durMs: +dur.toFixed(1) });
      }
      lastFrame = s.currentFrame;
      stallStart = s.t;
    }
    lastFrameChangeT = s.t;
  }
  if (stallStart !== null && lastFrameChangeT !== null) {
    const dur = lastFrameChangeT - stallStart;
    if (dur > frameSec * 1000 * 1.5) stalls.push({ frame: lastFrame, startT: stallStart, durMs: +dur.toFixed(1) });
  }

  // --- color/alpha companion ドリフト ---
  const drifts = log
    .filter((s) => s.isPlaying && s.color && s.alpha && !s.color.paused && !s.alpha.paused)
    .map((s) => ({ t: s.t, driftMs: +((s.color.currentTime - s.alpha.currentTime) * 1000).toFixed(1) }));
  const driftAbsMax = drifts.reduce((m, d) => Math.max(m, Math.abs(d.driftMs)), 0);
  const driftAbsAvg = drifts.length ? drifts.reduce((s, d) => s + Math.abs(d.driftMs), 0) / drifts.length : 0;

  // --- 開始直後 readiness（最初の isPlaying=true サンプル時点）---
  const firstPlaying = log.find((s) => s.isPlaying);
  const HAVE_CURRENT_DATA = 2;
  const readyAtStart = firstPlaying
    ? {
        bg: firstPlaying.bg ? firstPlaying.bg.readyState >= HAVE_CURRENT_DATA : null,
        color: firstPlaying.color ? firstPlaying.color.readyState >= HAVE_CURRENT_DATA : null,
        alpha: firstPlaying.alpha ? firstPlaying.alpha.readyState >= HAVE_CURRENT_DATA : null,
      }
    : null;

  console.log(`\n=== ${label} ===`);
  console.log("samples:", log.length, "duration(ms):", log.length ? log[log.length - 1].t.toFixed(0) : 0);
  console.log("readyState>=HAVE_CURRENT_DATA at play-start:", readyAtStart);
  console.log("stalls (currentFrame stuck > 1.5 frame while isPlaying):", stalls.length);
  for (const s of stalls.slice(0, 10)) console.log("  stall @frame", s.frame, "start_t=", s.startT.toFixed(0), "dur_ms=", s.durMs);
  console.log("color/alpha drift(ms): max=", driftAbsMax.toFixed(1), "avg=", driftAbsAvg.toFixed(1));
  return { stalls, driftAbsMax, driftAbsAvg, readyAtStart, sampleCount: log.length };
}

const TRIALS = Number(process.env.VERIFY_TRIALS ?? 3);

async function runScenarioA(trial) {
  console.log(`\n--- Scenario A trial ${trial}: wait then play ---`);
  await page.evaluate(() => window.__mafterEditorStore.getState().setPlaying(false));
  await page.evaluate((f) => window.__mafterEditorStore.getState().setFrame(f), START_FRAME);
  await page.waitForTimeout(1800); // idle warm-up (requestIdleCallback / 200ms fallback) が完了する猶予
  const playP = page.evaluate(() => window.__mafterEditorStore.getState().setPlaying(true));
  const log = await page.evaluate(sampleScript, { durationMs: SAMPLE_MS, bgLayer: BG_LAYER, personLayer: PERSON_LAYER });
  await playP;
  await page.evaluate(() => window.__mafterEditorStore.getState().setPlaying(false));
  return analyze(log, `A trial ${trial}: wait(1800ms) then play`);
}

async function runScenarioB(trial) {
  console.log(`\n--- Scenario B trial ${trial}: scrub then immediate play ---`);
  await page.evaluate(() => window.__mafterEditorStore.getState().setPlaying(false));
  await page.evaluate((f) => window.__mafterEditorStore.getState().setFrame(f), START_FRAME + 1);
  await page.evaluate((f) => window.__mafterEditorStore.getState().setFrame(f), START_FRAME + 2);
  await page.evaluate((f) => window.__mafterEditorStore.getState().setFrame(f), START_FRAME);
  // フレーム変更直後、間を置かず Play とサンプリングを同時発火
  const playP = page.evaluate(() => window.__mafterEditorStore.getState().setPlaying(true));
  const log = await page.evaluate(sampleScript, { durationMs: SAMPLE_MS, bgLayer: BG_LAYER, personLayer: PERSON_LAYER });
  await playP;
  await page.evaluate(() => window.__mafterEditorStore.getState().setPlaying(false));
  return analyze(log, `B trial ${trial}: scrub then immediate play`);
}

const resultsA = [];
const resultsB = [];
for (let i = 1; i <= TRIALS; i++) {
  resultsA.push(await runScenarioA(i));
  await page.waitForTimeout(800);
  resultsB.push(await runScenarioB(i));
  await page.waitForTimeout(800);
}

function aggregate(results) {
  const n = results.length;
  const totalStallDurMs = results.map((r) => r.stalls.reduce((s, x) => s + x.durMs, 0));
  const stallCounts = results.map((r) => r.stalls.length);
  const driftMax = results.map((r) => r.driftAbsMax);
  const driftAvg = results.map((r) => r.driftAbsAvg);
  const readyAllAtStart = results.map((r) => !!(r.readyAtStart?.bg && r.readyAtStart?.color && r.readyAtStart?.alpha));
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  return {
    trials: n,
    stallCount: { values: stallCounts, avg: +avg(stallCounts).toFixed(2) },
    totalStallDurMs: { values: totalStallDurMs, avg: +avg(totalStallDurMs).toFixed(1) },
    driftAbsMaxMs: { values: driftMax, avg: +avg(driftMax).toFixed(1) },
    driftAbsAvgMs: { values: driftAvg, avg: +avg(driftAvg).toFixed(2) },
    readyAllAtStart: { values: readyAllAtStart, rate: +(readyAllAtStart.filter(Boolean).length / n).toFixed(2) },
  };
}

const aggA = aggregate(resultsA);
const aggB = aggregate(resultsB);

console.log("\n=== aggregate summary (", TRIALS, "trials each ) ===");
console.log("Scenario A (wait then play):", JSON.stringify(aggA, null, 2));
console.log("Scenario B (scrub then immediate play):", JSON.stringify(aggB, null, 2));

// --- CDP Media ログ（HW/SW decode の手がかり）---
await page.waitForTimeout(300);
console.log("\n=== CDP Media log (decoder-relevant properties) ===");
const relevantKeys = /decoder|hardware|codec|resolution|framerate|video_track/i;
for (const entry of mediaLog) {
  if (entry.kind === "properties") {
    const relevant = entry.data.filter((p) => relevantKeys.test(p.name));
    if (relevant.length) console.log(`player ${entry.playerId}:`, JSON.stringify(relevant));
  }
}
if (mediaLog.length === 0) console.log("(no Media domain events captured)");

if (pageErrors.length) console.log("\npage errors:", pageErrors.slice(0, 10));

fs.writeFileSync(
  "verify-comp32-webm-instability-result.json",
  JSON.stringify({ A: { aggregate: aggA, trials: resultsA }, B: { aggregate: aggB, trials: resultsB }, mediaLog }, null, 2),
);
console.log("\nfull log written to verify-comp32-webm-instability-result.json");

await browser.close();
