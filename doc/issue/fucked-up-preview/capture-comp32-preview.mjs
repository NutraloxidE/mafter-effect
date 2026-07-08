// doc/issue/fucked-up-preview — packed alpha preview の「もたつき / ズレ」実ピクセル計測。
//
// なぜ新規に作るか: 既存 verify-packed-mixed-sync.mjs は mafterTargetSec / mafterPackedComposedSec /
// bg <video>.currentTime という「内部カウンタ」を polling して frame 差を測る。しかし (A) ロールバックは
// 「subject の内部 target を背景 currentTime に一致させる」処理そのものなので、その差はコードが定義上
// ゼロに保つ値であり、実際に画面へ present されたピクセルの揃いは見ていない（測定妥当性の欠陥）。
//
// このスクリプトは:
//   1) CDP Page.startScreencast で「実際に描画されたピクセル」を高FPSで録画（timestamp付き）
//   2) 並行して rAF で内部クロック（currentFrame / bg.currentTime / packed composed frame）を全速サンプル
//   3) 画面隅に診断オーバーレイ（3クロック＋HOLD表示）を焼き込み、録画映像だけでズレが目視できるようにする
//   4) ffmpeg freezedetect で「実ピクセルの視覚フリーズ（＝もたつき）」を客観抽出
//
// 対象: verify-comp32-mini-project.zip の Comp32（背景 video + Person split→packed 化＝混在ケース）。
// 実 Chrome（channel:"chrome"）headed・https://localhost（secure context 必須＝VideoDecoder 経路）。

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// CAP_LABEL でベースライン比較用のサブフォルダに分離（既定は out/、現状キャプチャ用）。
const OUT = path.join(HERE, "out", process.env.CAP_LABEL ?? "");
const FRAMES_DIR = path.join(OUT, "frames");
fs.mkdirSync(FRAMES_DIR, { recursive: true });
for (const f of fs.readdirSync(FRAMES_DIR)) fs.rmSync(path.join(FRAMES_DIR, f)); // clean

const PORT = process.env.VERIFY_PORT ?? "5173";
// CAP_URL で http/https・ポートを切替（古いコミットは basic-ssl 無しで http になる）。
const URL = process.env.CAP_URL ?? `https://localhost:${PORT}/`;
const ZIP = path.resolve("verify-comp32-mini-project.zip");
const DURATION_MS = Number(process.env.CAP_MS ?? 8000);
const FPS = 30;

const COMP32 = "01KWSRT0CQGZKJ0FNKEAD41F7M";
const BG_LAYER = "01KWSRTF8GZVCBCTQ372RW9MBN";
const PERSON_LAYER = "01KWSS67VPCYTP5XKWPN1BP0EP";
const START_FRAME = 20;

if (!fs.existsSync(ZIP)) { console.error("missing", ZIP); process.exit(1); }
console.log("zip bytes:", fs.statSync(ZIP).size, "| duration(ms):", DURATION_MS, "| url:", URL);

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
await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => window.__mafterEditorStore?.getState().getFs, { timeout: 20000 });

console.log("importing project + converting Person split->packed ...");
await page.evaluate(async () => {
  const resp = await fetch("/__verify_project.zip");
  const buf = new Uint8Array(await resp.arrayBuffer());
  const { importZip } = await import("/src/fs/zip.ts");
  const st = window.__mafterEditorStore.getState();
  await importZip(st.getFs(), buf);
  await st.loadFromFs();
});
await page.evaluate((c) => window.__mafterEditorStore.getState().setCurrentComp(c), COMP32);
await page.waitForTimeout(500);

const convert = await page.evaluate(async ({ compId, personLayer }) => {
  const { convertSplitAssetToPacked, isConvertError } = await import("/src/editor/subjectExtract/convertSplitToPacked.ts");
  const st = window.__mafterEditorStore.getState();
  const comp = st.project.compositions.find((c) => c.id === compId);
  const obj = comp.objects.find((o) => o.id === personLayer);
  const assetId = obj.components.find((c) => c.type === "video").props["asset"];
  const result = await convertSplitAssetToPacked(st.project, st.getFs(), assetId, comp.fps);
  if (isConvertError(result)) return { error: result.error };
  const before = st.project;
  const after = {
    ...before,
    assets: [...before.assets, result.asset],
    compositions: before.compositions.map((c) =>
      c.id !== compId || c.kind !== "timeline" ? c : {
        ...c,
        objects: c.objects.map((o) => o.id !== personLayer ? o : {
          ...o,
          components: o.components.map((cmp) => cmp.type === "video" ? { ...cmp, props: { ...cmp.props, asset: result.asset.id } } : cmp),
        }),
      }),
  };
  st.applyCommand({ label: "convert Person split->packed", before, after });
  return { newAssetId: result.asset.id, container: result.asset.path.split(".").pop() };
}, { compId: COMP32, personLayer: PERSON_LAYER });
console.log("convert:", JSON.stringify(convert));
if (convert.error) { console.error("FATAL convert failed:", convert.error); await browser.close(); process.exit(1); }

await page.waitForTimeout(500);
await page.evaluate((f) => window.__mafterEditorStore.getState().setFrame(f), START_FRAME);

// packed canvas + bg video が座席に出るまで待つ
await page.waitForFunction((p) => document.querySelector(`[data-object-id="${p}"] canvas.mafter-packed-alpha-canvas`) !== null, PERSON_LAYER, { timeout: 20000 })
  .catch(() => console.warn("WARN packed canvas not found"));
await page.waitForFunction((b) => document.querySelector(`[data-object-id="${b}"] video`) !== null, BG_LAYER, { timeout: 20000 })
  .catch(() => console.warn("WARN bg video not found"));

// decoder 経路が実際に有効か（mafterPackedDecoder フラグ）を待つ — 少し再生を回して判定
await page.evaluate(() => window.__mafterEditorStore.getState().setPlaying(true));
await page.waitForTimeout(400);
const decoderActive = await page.evaluate((p) => {
  const v = document.querySelector(`[data-object-id="${p}"] video`);
  return { flag: v?.dataset?.mafterPackedDecoder ?? null, hasSrc: !!v?.getAttribute("src") };
}, PERSON_LAYER);
await page.evaluate(() => window.__mafterEditorStore.getState().setPlaying(false));
console.log("packed decoder path:", JSON.stringify(decoderActive), decoderActive.flag === "1" ? "(VideoDecoder ACTIVE)" : "(NOT decoder-driven — fell back to <video>)");

// --- 診断オーバーレイを注入（録画に焼き込む） ---
await page.evaluate(({ bgLayer, personLayer, fps }) => {
  const o = document.createElement("div");
  o.id = "__capOverlay";
  o.style.cssText = "position:fixed;left:8px;top:8px;z-index:999999;font:14px/1.35 monospace;background:rgba(0,0,0,.72);color:#0f0;padding:6px 8px;white-space:pre;pointer-events:none;border:1px solid #0f0";
  document.body.appendChild(o);
  window.__capLog = [];
  const t0 = performance.now();
  const bgSel = `[data-object-id="${bgLayer}"] video`;
  const personSel = `[data-object-id="${personLayer}"] video`;
  let prevFrame = null, prevChangeT = 0;
  function tick() {
    const st = window.__mafterEditorStore.getState();
    const bg = document.querySelector(bgSel);
    const pv = document.querySelector(personSel);
    const t = performance.now() - t0;
    const cf = st.currentFrame;
    const playing = st.isPlaying;
    const bgCT = bg ? bg.currentTime : null;
    // 現状(sync修正)は mafterPackedComposedSec を出す。古いベースライン(packed=native<video>)には
    // 無いので、その場合は Person <video>.currentTime を実表示 subject フレームの近似に使う。
    const composedRaw = pv?.dataset?.mafterPackedComposedSec;
    const subjSec = composedRaw !== undefined ? Number(composedRaw) : (pv ? pv.currentTime : null);
    // 実際に表示されている frame の比較: 背景=bgCT*fps, subject=subjSec*fps
    const bgFrame = bgCT != null ? bgCT * fps : null;
    const subjFrame = subjSec != null ? subjSec * fps : null;
    const desync = bgFrame != null && subjFrame != null ? subjFrame - bgFrame : null; // +なら subject が先行
    if (cf !== prevFrame) { prevFrame = cf; prevChangeT = t; }
    const heldMs = t - prevChangeT;
    window.__capLog.push({ t, cf, playing, bgCT, subjSec, bgFrame, subjFrame, desync, bgReady: bg?.readyState ?? null, decoder: pv?.dataset?.mafterPackedDecoder === "1" });
    o.textContent =
      `t=${(t / 1000).toFixed(2)}s  playing=${playing ? 1 : 0}\n` +
      `timeline F=${cf}${playing && heldMs > 60 ? `  HOLD ${heldMs.toFixed(0)}ms` : ""}\n` +
      `bg    frame=${bgFrame != null ? bgFrame.toFixed(2) : "-"}\n` +
      `subj  frame=${subjFrame != null ? subjFrame.toFixed(2) : "-"}${pv?.dataset?.mafterPackedDecoder === "1" ? " [dec]" : ""}\n` +
      `desync(subj-bg)=${desync != null ? (desync >= 0 ? "+" : "") + desync.toFixed(2) + "f" : "-"}`;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}, { bgLayer: BG_LAYER, personLayer: PERSON_LAYER, fps: FPS });

// --- CDP screencast 開始 ---
const cdp = await context.newCDPSession(page);
const frames = []; // { seq, tsMs, file }
let seq = 0;
cdp.on("Page.screencastFrame", async (ev) => {
  const seqN = seq++;
  const tsMs = (ev.metadata.timestamp ?? 0) * 1000;
  const file = path.join(FRAMES_DIR, `f${String(seqN).padStart(5, "0")}.jpg`);
  fs.writeFileSync(file, Buffer.from(ev.data, "base64"));
  frames.push({ seq: seqN, tsMs, file });
  try { await cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }); } catch { /* closed */ }
});

console.log("starting screencast + playback ...");
await page.evaluate((f) => window.__mafterEditorStore.getState().setFrame(f), START_FRAME);
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
await page.evaluate(() => window.__mafterEditorStore.getState().setPlaying(true));
await page.waitForTimeout(DURATION_MS);
await page.evaluate(() => window.__mafterEditorStore.getState().setPlaying(false));
await cdp.send("Page.stopScreencast").catch(() => {});
await page.waitForTimeout(200);

const capLog = await page.evaluate(() => window.__capLog ?? []);
console.log(`captured ${frames.length} screencast frames, ${capLog.length} rAF samples`);

// --- 内部クロック解析（rAF 全速サンプル） ---
const playing = capLog.filter((s) => s.playing);
function holdsFromLog(log) {
  const frameMs = 1000 / FPS;
  const holds = [];
  let start = null, last = null, lastT = 0;
  for (const s of log) {
    if (last === null || s.cf !== last) {
      if (start !== null && lastT - start > frameMs * 1.5) holds.push({ frame: last, startMs: +start.toFixed(0), durMs: +(lastT - start).toFixed(0) });
      last = s.cf; start = s.t;
    }
    lastT = s.t;
  }
  if (start !== null && lastT - start > frameMs * 1.5) holds.push({ frame: last, startMs: +start.toFixed(0), durMs: +(lastT - start).toFixed(0) });
  return holds;
}
const holds = holdsFromLog(playing);
const desyncVals = playing.map((s) => s.desync).filter((d) => d != null && Number.isFinite(d));
const abs = desyncVals.map(Math.abs).sort((a, b) => a - b);
const median = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);
const desyncStats = desyncVals.length
  ? {
      samples: desyncVals.length,
      medianAbsFrames: median(abs) != null ? +median(abs).toFixed(2) : null,
      maxAbsFrames: +Math.max(...abs).toFixed(2),
      p95AbsFrames: abs.length ? +abs[Math.floor(abs.length * 0.95)].toFixed(2) : null,
      meanSignedFrames: +(desyncVals.reduce((a, b) => a + b, 0) / desyncVals.length).toFixed(2),
      leadCount: desyncVals.filter((d) => d > 0.5).length,
      lagCount: desyncVals.filter((d) => d < -0.5).length,
    }
  : null;

// --- screencast frame pacing ---
let pacing = null;
if (frames.length > 1) {
  const dts = [];
  for (let i = 1; i < frames.length; i++) dts.push(frames[i].tsMs - frames[i - 1].tsMs);
  dts.sort((a, b) => a - b);
  const total = frames[frames.length - 1].tsMs - frames[0].tsMs;
  pacing = { frames: frames.length, spanMs: +total.toFixed(0), avgFps: +((frames.length - 1) / (total / 1000)).toFixed(1), medianDtMs: +median(dts).toFixed(1), maxDtMs: +Math.max(...dts).toFixed(1) };
}

console.log("\n=== INTERNAL CLOCK (rAF full-rate) ===");
console.log("timeline holds (>1.5 frame stuck while playing):", holds.length, JSON.stringify(holds.slice(0, 12)));
console.log("desync (subj-bg, displayed frames):", JSON.stringify(desyncStats));
console.log("screencast pacing:", JSON.stringify(pacing));

const metrics = { url: URL, durationMs: DURATION_MS, fps: FPS, startFrame: START_FRAME, convert, decoderActive, holds, desyncStats, pacing, pageErrors: pageErrors.slice(0, 10) };
fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(metrics, null, 2));
fs.writeFileSync(path.join(OUT, "raf-log.json"), JSON.stringify(capLog));

// --- concat file for ffmpeg (real per-frame durations) ---
if (frames.length > 1) {
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const dur = (i < frames.length - 1 ? frames[i + 1].tsMs - frames[i].tsMs : median([16.7])) / 1000;
    lines.push(`file '${path.basename(frames[i].file)}'`);
    lines.push(`duration ${Math.max(0.005, dur).toFixed(4)}`);
  }
  lines.push(`file '${path.basename(frames[frames.length - 1].file)}'`);
  fs.writeFileSync(path.join(FRAMES_DIR, "concat.txt"), lines.join("\n"));
}

if (pageErrors.length) console.log("\npage errors:", pageErrors.slice(0, 6));
console.log("\nwrote metrics.json / raf-log.json / frames/. Next: ffmpeg mux + freezedetect (see build-and-analyze.sh).");
await browser.close();
