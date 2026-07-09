// doc/issue/preview-loop-wrap — Comp33（背景 video + packed alpha Person の混在ケース）で
// loop 再生の折り返しを 10 回以上跨ぎ、wrap 1 回ごとに次を記録して分類する（S3 の判別因子確定用）:
//   - freeze 長（内部 hold ログ = doc/issue/fucked-up-preview/report.md で freezedetect と二重一致確認済みの手法）
//   - shouldPreferCacheOverlay の実値 / isWorkAreaBuildComplete
//   - 各 primary video の buffered が loopStart ソース時刻(=0s)を含んでいたか / readyState / seek 発行
//   - wrap 瞬間のゲート状態（video.paused = pauseVideo 相当）
//   - loopStart のソース時刻（このフィクスチャでは常に 0s = 両クリップとも trimStart 0 のためキーフレーム距離は不変）
//
// CACHE_MODE=1 で実行すると、再生前に Caching 設定を有効化してワークエリアを bake してから
// 同じ計測をやり直す（H5 candidate 1 の因果テスト = bake 完了時は常時スムーズになるかを確認）。
//
// 実 Chrome（channel:"chrome"）headed・https://localhost（secure context 必須）。

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_MODE = process.env.CACHE_MODE === "1";
const LABEL = CACHE_MODE ? "cache" : "live";
const OUT = path.join(HERE, "out", LABEL);
const FRAMES_DIR = path.join(OUT, "frames");
fs.mkdirSync(FRAMES_DIR, { recursive: true });
for (const f of fs.readdirSync(FRAMES_DIR)) fs.rmSync(path.join(FRAMES_DIR, f));

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = process.env.CAP_URL ?? `https://localhost:${PORT}/`;
const ZIP = path.resolve(HERE, "..", "..", "..", "verify-comp33-mini-project.zip");
const FPS = 30;
const COMP_DURATION = 150; // frames = 5s @30fps
const START_FRAME = 0;
const DURATION_MS = Number(process.env.CAP_MS ?? 63000); // ~12 wraps of 5s

const COMP33 = "01KWZKBBD4CMNVGYKW5BXBZF38";
const BG_LAYER = "01KWZKBC8RCCGNM2MWJZM4G93J";
const PERSON_LAYER = "01KWZMGQFNV98G93STQGTTD32F";

if (!fs.existsSync(ZIP)) { console.error("missing", ZIP); process.exit(1); }
console.log(`[${LABEL}] zip bytes:`, fs.statSync(ZIP).size, "| duration(ms):", DURATION_MS, "| url:", URL);

const browser = await chromium
  .launch({ headless: false, channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] })
  .catch(() => chromium.launch({ headless: false, args: ["--autoplay-policy=no-user-gesture-required"] }));
browser.on("disconnected", () => console.error("!!! browser disconnected !!!"));

const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
const page = await context.newPage();
page.setDefaultTimeout(120_000);
const pageErrors = [];
page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.route("**/__verify_project.zip", (route) => route.fulfill({ path: ZIP, contentType: "application/zip" }));

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.evaluate(() => { localStorage.removeItem("mafter-work-area-v1"); localStorage.removeItem("mafter-preview-viewer-v1"); localStorage.removeItem("mafter-preview-cache-v1"); });
await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => window.__mafterEditorStore?.getState().getFs, { timeout: 20000 });

console.log("importing project ...");
await page.evaluate(async () => {
  const resp = await fetch("/__verify_project.zip");
  const buf = new Uint8Array(await resp.arrayBuffer());
  const { importZip } = await import("/src/fs/zip.ts");
  const st = window.__mafterEditorStore.getState();
  await importZip(st.getFs(), buf);
  await st.loadFromFs();
});
await page.evaluate((c) => window.__mafterEditorStore.getState().setCurrentComp(c), COMP33);
await page.waitForTimeout(500);

// ワークエリア = comp 全体（loopStart=0）。localStorage は既に消去済みなので既定値のはずだが明示する。
await page.evaluate((dur) => window.__mafterEditorStore.getState().setWorkArea(0, dur), COMP_DURATION);
await page.evaluate((f) => window.__mafterEditorStore.getState().setFrame(f), START_FRAME);

await page.waitForFunction((p) => document.querySelector(`[data-object-id="${p}"] canvas.mafter-packed-alpha-canvas`) !== null, PERSON_LAYER, { timeout: 20000 })
  .catch(() => console.warn("WARN packed canvas not found"));
await page.waitForFunction((b) => document.querySelector(`[data-object-id="${b}"] video`) !== null, BG_LAYER, { timeout: 20000 })
  .catch(() => console.warn("WARN bg video not found"));

// ループ ON（UI トグル、viewerSettings は component-local state なので store 経由不可）
await page.click('button[title="ループ"]');
await page.waitForTimeout(100);

if (CACHE_MODE) {
  console.log("CACHE_MODE: enabling Caching + building work area ...");
  await page.click('label:has-text("Caching") input[type="checkbox"]');
  await page.waitForTimeout(300);
  const build = await page.evaluate(async () => {
    const { previewCacheService } = await import("/src/editor/previewCacheService.ts");
    previewCacheService.getController()?.startBackgroundBuildIfNeeded();
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const ctrl = previewCacheService.getController();
      if (ctrl?.isWorkAreaBuildComplete()) return { ok: true };
      await new Promise((r) => setTimeout(r, 300));
    }
    return { ok: false };
  });
  console.log("build result:", JSON.stringify(build));
  if (!build.ok) { console.error("FATAL: work area bake did not complete in time"); await browser.close(); process.exit(1); }
}

// --- 診断計装を注入 ---
await page.evaluate(async ({ bgLayer, personLayer, fps }) => {
  const { previewCacheService } = await import("/src/editor/previewCacheService.ts");
  const o = document.createElement("div");
  o.id = "__capOverlay";
  o.style.cssText = "position:fixed;left:8px;top:8px;z-index:999999;font:13px/1.3 monospace;background:rgba(0,0,0,.72);color:#0f0;padding:6px 8px;white-space:pre;pointer-events:none;border:1px solid #0f0";
  document.body.appendChild(o);
  window.__capLog = [];
  window.__seekEvents = [];
  const t0 = performance.now();
  const bgSel = `[data-object-id="${bgLayer}"] video`;
  const personSel = `[data-object-id="${personLayer}"] video`;

  function attachSeekLogging(sel, label) {
    let el = null;
    const tryAttach = () => {
      const v = document.querySelector(sel);
      if (v && v !== el) {
        el = v;
        v.addEventListener("seeking", () => window.__seekEvents.push({ t: performance.now() - t0, wallMs: Date.now(), layer: label, type: "seeking", currentTime: v.currentTime }));
        v.addEventListener("seeked", () => window.__seekEvents.push({ t: performance.now() - t0, wallMs: Date.now(), layer: label, type: "seeked", currentTime: v.currentTime }));
      }
    };
    tryAttach();
    return tryAttach;
  }
  const bgAttach = attachSeekLogging(bgSel, "bg");
  const personAttach = attachSeekLogging(personSel, "person");

  function bufferedRanges(v) {
    if (!v) return null;
    const b = v.buffered;
    const out = [];
    for (let i = 0; i < b.length; i++) out.push([+b.start(i).toFixed(3), +b.end(i).toFixed(3)]);
    return out;
  }
  function bufferedContains(ranges, sec) {
    if (!ranges) return null;
    return ranges.some(([s, e]) => sec >= s - 0.01 && sec <= e + 0.01);
  }

  let prevFrame = null, prevChangeT = 0;
  function tick() {
    bgAttach(); personAttach();
    const st = window.__mafterEditorStore.getState();
    const bg = document.querySelector(bgSel);
    const pv = document.querySelector(personSel);
    const t = performance.now() - t0;
    const wallMs = Date.now();
    const cf = st.currentFrame;
    const playing = st.isPlaying;
    const bgBuf = bufferedRanges(bg);
    const pvBuf = bufferedRanges(pv);
    const ctrl = previewCacheService.getController();
    const cacheOverlayActive = ctrl ? ctrl.shouldPreferCacheOverlay(playing) : false;
    const buildComplete = ctrl ? ctrl.isWorkAreaBuildComplete() : false;
    if (cf !== prevFrame) { prevFrame = cf; prevChangeT = t; }
    const heldMs = t - prevChangeT;
    window.__capLog.push({
      t, wallMs, cf, playing,
      bg: bg ? { ct: +bg.currentTime.toFixed(3), buffered: bgBuf, containsLoopStart: bufferedContains(bgBuf, 0), readyState: bg.readyState, paused: bg.paused, seeking: bg.seeking } : null,
      person: pv ? { ct: +pv.currentTime.toFixed(3), buffered: pvBuf, containsLoopStart: bufferedContains(pvBuf, 0), readyState: pv.readyState, paused: pv.paused, seeking: pv.seeking } : null,
      cacheOverlayActive, buildComplete,
    });
    o.textContent =
      `t=${(t / 1000).toFixed(2)}s  playing=${playing ? 1 : 0}  cache=${cacheOverlayActive ? 1 : 0}\n` +
      `timeline F=${cf}${playing && heldMs > 60 ? `  HOLD ${heldMs.toFixed(0)}ms` : ""}\n` +
      `bg    ct=${bg ? bg.currentTime.toFixed(2) : "-"} paused=${bg?.paused ? 1 : 0} rs=${bg?.readyState ?? "-"}\n` +
      `person ct=${pv ? pv.currentTime.toFixed(2) : "-"} paused=${pv?.paused ? 1 : 0} rs=${pv?.readyState ?? "-"}`;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}, { bgLayer: BG_LAYER, personLayer: PERSON_LAYER, fps: FPS });

// --- CDP screencast（全体フリーズ率の独立裏取り用） ---
const cdp = await context.newCDPSession(page);
const frames = [];
let seq = 0;
cdp.on("Page.screencastFrame", async (ev) => {
  const seqN = seq++;
  const tsMs = (ev.metadata.timestamp ?? 0) * 1000;
  const file = path.join(FRAMES_DIR, `f${String(seqN).padStart(5, "0")}.jpg`);
  fs.writeFileSync(file, Buffer.from(ev.data, "base64"));
  frames.push({ seq: seqN, tsMs, file, wallAtCapture: Date.now() });
  try { await cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }); } catch { /* closed */ }
});

console.log(`[${LABEL}] starting screencast + playback (loop ON) ...`);
await page.evaluate((f) => window.__mafterEditorStore.getState().setFrame(f), START_FRAME);
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
await page.evaluate(() => window.__mafterEditorStore.getState().setPlaying(true));
await page.waitForTimeout(DURATION_MS);
await page.evaluate(() => window.__mafterEditorStore.getState().setPlaying(false));
await cdp.send("Page.stopScreencast").catch(() => {});
await page.waitForTimeout(200);

const capLog = await page.evaluate(() => window.__capLog ?? []);
const seekEvents = await page.evaluate(() => window.__seekEvents ?? []);
console.log(`captured ${frames.length} screencast frames, ${capLog.length} rAF samples, ${seekEvents.length} seek events`);

fs.writeFileSync(path.join(OUT, "raf-log.json"), JSON.stringify(capLog));
fs.writeFileSync(path.join(OUT, "seek-events.json"), JSON.stringify(seekEvents));

// --- wrap 検出（cf の後退 = ループ折り返し） ---
const playing = capLog.filter((s) => s.playing);
const wraps = [];
for (let i = 1; i < playing.length; i++) {
  if (playing[i].cf < playing[i - 1].cf - 1) {
    wraps.push({ idx: i, t: playing[i].t, wallMs: playing[i].wallMs, fromFrame: playing[i - 1].cf, toFrame: playing[i].cf });
  }
}
console.log(`detected ${wraps.length} wraps`);

// --- hold（freeze proxy、report.md で freezedetect と二重一致確認済みの手法） ---
function holdsFromLog(log) {
  const frameMs = 1000 / FPS;
  const holds = [];
  let start = null, last = null, lastT = 0;
  for (const s of log) {
    if (last === null || s.cf !== last) {
      if (start !== null && lastT - start > frameMs * 1.5) holds.push({ frame: last, startMs: +start.toFixed(0), endMs: +lastT.toFixed(0), durMs: +(lastT - start).toFixed(0) });
      last = s.cf; start = s.t;
    }
    lastT = s.t;
  }
  if (start !== null && lastT - start > frameMs * 1.5) holds.push({ frame: last, startMs: +start.toFixed(0), endMs: +lastT.toFixed(0), durMs: +(lastT - start).toFixed(0) });
  return holds;
}
const holds = holdsFromLog(playing);

// --- per-wrap 分類 ---
function nearestSample(log, t) {
  let best = null, bestDist = Infinity;
  for (const s of log) {
    const d = Math.abs(s.t - t);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}
function seekEventsNear(events, layer, t0, t1) {
  return events.filter((e) => e.layer === layer && e.t >= t0 && e.t <= t1);
}
const perWrap = wraps.map((w) => {
  const winStart = w.t - 300;
  const winEnd = w.t + 1500;
  const overlappingHolds = holds.filter((h) => h.endMs >= winStart && h.startMs <= winEnd);
  const freezeMs = overlappingHolds.reduce((sum, h) => sum + h.durMs, 0);
  const sampleBefore = nearestSample(playing, w.t - 30); // wrap 直前のバッファ状態
  const bgSeeks = seekEventsNear(seekEvents, "bg", winStart, winEnd);
  const personSeeks = seekEventsNear(seekEvents, "person", winStart, winEnd);
  return {
    wrapIdx: w.idx,
    tSec: +(w.t / 1000).toFixed(2),
    fromFrame: w.fromFrame,
    toFrame: w.toFrame,
    freezeMs,
    holds: overlappingHolds,
    cacheOverlayActive: sampleBefore?.cacheOverlayActive ?? null,
    buildComplete: sampleBefore?.buildComplete ?? null,
    bg: sampleBefore?.bg ? { containsLoopStart: sampleBefore.bg.containsLoopStart, readyState: sampleBefore.bg.readyState, paused: sampleBefore.bg.paused, buffered: sampleBefore.bg.buffered } : null,
    person: sampleBefore?.person ? { containsLoopStart: sampleBefore.person.containsLoopStart, readyState: sampleBefore.person.readyState, paused: sampleBefore.person.paused, buffered: sampleBefore.person.buffered } : null,
    bgSeekCount: bgSeeks.length,
    personSeekCount: personSeeks.length,
    bgSeekDurationMs: bgSeeks.length >= 2 ? +(bgSeeks[bgSeeks.length - 1].t - bgSeeks[0].t).toFixed(0) : null,
    personSeekDurationMs: personSeeks.length >= 2 ? +(personSeeks[personSeeks.length - 1].t - personSeeks[0].t).toFixed(0) : null,
  };
});

// --- desync (subject vs bg, displayed frames) ---
const desyncVals = playing
  .map((s) => (s.bg && s.person ? (s.person.ct - s.bg.ct) * FPS : null))
  .filter((d) => d != null && Number.isFinite(d));
const abs = desyncVals.map(Math.abs).sort((a, b) => a - b);
const median = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);
const desyncStats = desyncVals.length
  ? {
      samples: desyncVals.length,
      medianAbsFrames: median(abs) != null ? +median(abs).toFixed(2) : null,
      p95AbsFrames: abs.length ? +abs[Math.floor(abs.length * 0.95)].toFixed(2) : null,
      maxAbsFrames: +Math.max(...abs).toFixed(2),
      meanSignedFrames: +(desyncVals.reduce((a, b) => a + b, 0) / desyncVals.length).toFixed(2),
    }
  : null;

const wrapFreezeMsList = perWrap.map((w) => w.freezeMs).sort((a, b) => a - b);
const wrapFreezeStats = wrapFreezeMsList.length
  ? { median: median(wrapFreezeMsList), max: Math.max(...wrapFreezeMsList), min: Math.min(...wrapFreezeMsList), values: wrapFreezeMsList }
  : null;

console.log("\n=== per-wrap classification ===");
for (const w of perWrap) {
  console.log(
    `wrap@${w.tSec}s ${w.fromFrame}->${w.toFrame} freezeMs=${w.freezeMs} cache=${w.cacheOverlayActive} ` +
    `bg[buf0=${w.bg?.containsLoopStart} paused=${w.bg?.paused} rs=${w.bg?.readyState} seeks=${w.bgSeekCount}] ` +
    `person[buf0=${w.person?.containsLoopStart} paused=${w.person?.paused} rs=${w.person?.readyState} seeks=${w.personSeekCount}]`,
  );
}
console.log("\nwrapFreezeStats:", JSON.stringify(wrapFreezeStats));
console.log("desyncStats:", JSON.stringify(desyncStats));

// --- concat file + ffmpeg mux for independent freeze% sanity check ---
let overallFreezePct = null;
if (frames.length > 1) {
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const dur = (i < frames.length - 1 ? frames[i + 1].tsMs - frames[i].tsMs : 16.7) / 1000;
    lines.push(`file '${path.basename(frames[i].file)}'`);
    lines.push(`duration ${Math.max(0.005, dur).toFixed(4)}`);
  }
  lines.push(`file '${path.basename(frames[frames.length - 1].file)}'`);
  fs.writeFileSync(path.join(FRAMES_DIR, "concat.txt"), lines.join("\n"));
  const mp4Path = path.join(OUT, "capture.mp4");
  try {
    execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", path.join(FRAMES_DIR, "concat.txt"), "-vsync", "vfr", "-pix_fmt", "yuv420p", mp4Path], { stdio: ["ignore", "ignore", "pipe"] });
    const fd = execFileSync("ffmpeg", ["-i", mp4Path, "-vf", "freezedetect=n=0.002:d=0.15", "-map", "0:v:0", "-f", "null", "-"], { stdio: ["ignore", "pipe", "pipe"] }).toString();
    const stderr = fd || "";
    const starts = [...stderr.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => +m[1]);
    const durs = [...stderr.matchAll(/freeze_duration:\s*([\d.]+)/g)].map((m) => +m[1]);
    const totalFreeze = durs.reduce((a, b) => a + b, 0);
    const totalSpan = (frames[frames.length - 1].tsMs - frames[0].tsMs) / 1000;
    overallFreezePct = totalSpan > 0 ? +((totalFreeze / totalSpan) * 100).toFixed(1) : null;
    console.log(`\nffmpeg freezedetect: ${starts.length} windows, total ${totalFreeze.toFixed(2)}s / ${totalSpan.toFixed(2)}s = ${overallFreezePct}%`);
  } catch (e) {
    console.warn("ffmpeg mux/freezedetect failed:", e.message?.slice(0, 300));
  }
}

const metrics = {
  label: LABEL,
  cacheMode: CACHE_MODE,
  url: URL,
  durationMs: DURATION_MS,
  fps: FPS,
  startFrame: START_FRAME,
  wraps: wraps.length,
  perWrap,
  wrapFreezeStats,
  desyncStats,
  overallFreezePct,
  holdsCount: holds.length,
  pageErrors: pageErrors.slice(0, 10),
};
fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(metrics, null, 2));
console.log(`\nwrote ${path.join(OUT, "metrics.json")}`);
if (pageErrors.length) console.log("\npage errors:", pageErrors.slice(0, 6));
await browser.close();
