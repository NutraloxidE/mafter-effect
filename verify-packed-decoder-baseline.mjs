// Phase 0（videoDecoder-compiled-leaf plan）— VideoDecoder 明示デコード移行"前"のベースライン計測。
// verify-comp32-packed-instability.mjs（プランv2 Phase4）と同一の Comp32 相当ミニプロジェクト・
// 同一シナリオA/B・同一手法（headed実Chrome・3trials）を使い、現行の <video> ネイティブ再生
// （currentTime ポーリング + holdTimeline 制御ループ）の packed レイヤー preview 挙動を固定する。
// after（Phase 4 実装後）との比較対象。post-mortem に従い、この自動計測だけで
// 「軽くなった/悪化した」の最終判断はしない（ユーザー体感確認が必須）。
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5175";
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

await page.route("**/__verify_project.zip", (route) => route.fulfill({ path: ZIP, contentType: "application/zip" }));

// --- CDP Media domain: decoder 種別（HW/SW）診断 ---
const cdp = await page.context().newCDPSession(page);
await cdp.send("Media.enable");
const mediaLog = [];
const playerIds = new Set();
cdp.on("Media.playerPropertiesChanged", (ev) => {
  mediaLog.push({ ts: Date.now(), playerId: ev.playerId, kind: "properties", data: ev.properties });
  playerIds.add(ev.playerId);
});
cdp.on("Media.playersCreated", (ev) => {
  mediaLog.push({ ts: Date.now(), kind: "created", playerIds: ev.players });
  for (const id of ev.players) playerIds.add(id);
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

console.log("converting Person layer's split alpha asset to packed (same commit logic as PackedAlphaConvertFields.tsx)...");
const convertResult = await page.evaluate(async ({ compId, personLayer }) => {
  const { convertSplitAssetToPacked, isConvertError } = await import(
    "/src/editor/subjectExtract/convertSplitToPacked.ts"
  );
  const st = window.__mafterEditorStore.getState();
  const comp = st.project.compositions.find((c) => c.id === compId);
  const obj = comp.objects.find((o) => o.id === personLayer);
  const videoComp = obj.components.find((c) => c.type === "video");
  const assetId = videoComp.props["asset"];
  const asset = st.project.assets.find((a) => a.id === assetId);

  const result = await convertSplitAssetToPacked(st.project, st.getFs(), assetId, comp.fps);
  if (isConvertError(result)) return { error: result.error };

  const before = st.project;
  const after = {
    ...before,
    assets: [...before.assets, result.asset],
    compositions: before.compositions.map((c) => {
      if (c.id !== compId || c.kind !== "timeline") return c;
      return {
        ...c,
        objects: c.objects.map((o) => {
          if (o.id !== personLayer) return o;
          return {
            ...o,
            components: o.components.map((cmp) =>
              cmp.type === "video" ? { ...cmp, props: { ...cmp.props, asset: result.asset.id } } : cmp,
            ),
          };
        }),
      };
    }),
  };
  st.applyCommand({ label: "Phase0(videoDecoder plan): convert Person split->packed", before, after });
  return {
    originalAssetId: assetId,
    originalContainer: asset.path.split(".").pop(),
    newAssetId: result.asset.id,
    newAssetPath: result.asset.path,
    newContainer: result.asset.path.split(".").pop(),
    meta: result.asset.meta,
  };
}, { compId: COMP32, personLayer: PERSON_LAYER });

console.log("conversion result:", JSON.stringify(convertResult, null, 2));
if (convertResult.error) {
  console.error("FATAL: conversion failed:", convertResult.error);
  await browser.close();
  process.exit(1);
}

await page.waitForTimeout(500);

await page.waitForFunction(
  (personLayer) => document.querySelector(`[data-object-id="${personLayer}"] canvas.mafter-packed-alpha-canvas`) !== null,
  PERSON_LAYER,
  { timeout: 20000 },
).catch(() => console.warn("WARN: packed composite canvas not found within timeout"));

await page.waitForFunction(
  (bgLayer) => document.querySelector(`[data-object-id="${bgLayer}"] video`) !== null,
  BG_LAYER,
  { timeout: 20000 },
).catch(() => console.warn("WARN: background video element not found within timeout"));

// --- サンプリング: currentFrame / isPlaying / bg・person(packed=単一<video>) を rAF で記録 ---
const sampleScript = ({ durationMs, bgLayer, personLayer }) => {
  return new Promise((resolve) => {
    const log = [];
    const bgSel = `[data-object-id="${bgLayer}"] video`;
    const personSel = `[data-object-id="${personLayer}"] video`;
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
        person: sampleVideo(document.querySelector(personSel)),
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

  // タイムライン進行率: 壁時計 SAMPLE_MS で何 frame 進んだか / 理論値。
  const playingSamples = log.filter((s) => s.isPlaying);
  const firstPlayingFrame = playingSamples[0]?.currentFrame ?? null;
  const lastPlayingFrame = playingSamples[playingSamples.length - 1]?.currentFrame ?? null;
  const framesAdvanced = firstPlayingFrame !== null && lastPlayingFrame !== null ? lastPlayingFrame - firstPlayingFrame : null;
  const wallSec = playingSamples.length ? (playingSamples[playingSamples.length - 1].t - playingSamples[0].t) / 1000 : 0;
  const expectedFrames = wallSec * fps;
  const progressionRate = framesAdvanced !== null && expectedFrames > 0 ? +(framesAdvanced / expectedFrames).toFixed(3) : null;

  const firstPlaying = log.find((s) => s.isPlaying);
  const HAVE_CURRENT_DATA = 2;
  const readyAtStart = firstPlaying
    ? {
        bg: firstPlaying.bg ? firstPlaying.bg.readyState >= HAVE_CURRENT_DATA : null,
        person: firstPlaying.person ? firstPlaying.person.readyState >= HAVE_CURRENT_DATA : null,
      }
    : null;

  console.log(`\n=== ${label} ===`);
  console.log("samples:", log.length, "duration(ms):", log.length ? log[log.length - 1].t.toFixed(0) : 0);
  console.log("readyState>=HAVE_CURRENT_DATA at play-start:", readyAtStart);
  console.log("stalls (currentFrame stuck > 1.5 frame while isPlaying):", stalls.length);
  for (const s of stalls.slice(0, 10)) console.log("  stall @frame", s.frame, "start_t=", s.startT.toFixed(0), "dur_ms=", s.durMs);
  console.log("timeline progression rate (actual/expected frames):", progressionRate);
  return { stalls, readyAtStart, sampleCount: log.length, framesAdvanced, wallSec, progressionRate };
}

const TRIALS = Number(process.env.VERIFY_TRIALS ?? 3);

async function runScenarioA(trial) {
  console.log(`\n--- Scenario A trial ${trial}: wait then play ---`);
  await page.evaluate(() => window.__mafterEditorStore.getState().setPlaying(false));
  await page.evaluate((f) => window.__mafterEditorStore.getState().setFrame(f), START_FRAME);
  await page.waitForTimeout(1800);
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
  const readyAllAtStart = results.map((r) => !!(r.readyAtStart?.bg && r.readyAtStart?.person));
  const progressionRates = results.map((r) => r.progressionRate).filter((v) => v !== null);
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  return {
    trials: n,
    stallCount: { values: stallCounts, avg: +avg(stallCounts).toFixed(2) },
    totalStallDurMs: { values: totalStallDurMs, avg: +avg(totalStallDurMs).toFixed(1) },
    stallPercent: { values: totalStallDurMs.map((d) => +((d / SAMPLE_MS) * 100).toFixed(1)), avg: +((avg(totalStallDurMs) / SAMPLE_MS) * 100).toFixed(1) },
    readyAllAtStart: { values: readyAllAtStart, rate: +(readyAllAtStart.filter(Boolean).length / n).toFixed(2) },
    progressionRate: { values: progressionRates, avg: +avg(progressionRates).toFixed(3) },
  };
}

const aggA = aggregate(resultsA);
const aggB = aggregate(resultsB);

console.log("\n=== aggregate summary (", TRIALS, "trials each ) ===");
console.log("Scenario A (wait then play):", JSON.stringify(aggA, null, 2));
console.log("Scenario B (scrub then immediate play):", JSON.stringify(aggB, null, 2));

console.log("\n=== decoder sessions (Media domain playerIds seen) ===");
console.log("distinct playerIds:", playerIds.size);

await page.waitForTimeout(300);
console.log("\n=== CDP Media log (decoder-relevant properties) ===");
const relevantKeys = /decoder|hardware|codec|resolution|framerate|video_track/i;
const decoderSummary = [];
for (const entry of mediaLog) {
  if (entry.kind === "properties") {
    const relevant = entry.data.filter((p) => relevantKeys.test(p.name));
    if (relevant.length) {
      decoderSummary.push({ playerId: entry.playerId, relevant });
      console.log(`player ${entry.playerId}:`, JSON.stringify(relevant));
    }
  }
}
if (mediaLog.length === 0) console.log("(no Media domain events captured)");

if (pageErrors.length) console.log("\npage errors:", pageErrors.slice(0, 10));

fs.writeFileSync(
  "verify-packed-decoder-baseline-result.json",
  JSON.stringify(
    {
      note: "Phase 0 baseline: <video> native playback + currentTime-polling sync loop (pre-VideoDecoder migration). Compare against post-Phase4 measurement with the same fixture/scenarios.",
      convertResult,
      distinctPlayerIds: playerIds.size,
      decoderSummary,
      A: { aggregate: aggA, trials: resultsA },
      B: { aggregate: aggB, trials: resultsB },
      pageErrors,
    },
    null,
    2,
  ),
);
console.log("\nfull log written to verify-packed-decoder-baseline-result.json");

await browser.close();
