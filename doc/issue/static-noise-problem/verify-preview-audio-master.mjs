// after-v3 Phase A 実機検証: editor preview の standalone audio が holdTimeline
// （映像遅れ）でも AudioContext.suspend()/resume() を呼ばなくなったことを確認する。
//
// doc/issue/static-noise-problem/after-v3-implement-report.md §3 Phase A の受け入れ表 A/C 相当:
//  - CPU throttle で video decode/render を人為的に遅らせ、映像遅れ（holdTimeline 相当の条件）を作る。
//  - AudioContext.prototype.suspend/resume を app 起動前に monkey-patch し、再生中の呼び出し回数を記録する。
//  - 修正前（Ticket PA-02 前）は映像遅れ時に必ず suspend が呼ばれる。修正後は 0 回であるべき。
//
// フィクスチャ: 最新の実プロジェクト zip（Comp 10 — 唯一 audio レイヤーを持つ comp。既定で
// disabled なので import 後に enable する。video レイヤーも2本 enable して decode 負荷を上げる）。
import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5173";
const PROTO = process.env.VERIFY_PROTO ?? "https"; // dev サーバは basicSsl で https（vite.config.ts）
const URL = `${PROTO}://localhost:${PORT}/`;
// 既定は Comp 10 だけ抜き出した mini zip（build-mini-comp10-zip.mjs で生成）。全プロジェクト
// （209MB）をブラウザに import すると tab が OOM するため。VERIFY_ZIP で差し替え可。
const ZIP = process.env.VERIFY_ZIP ?? String.raw`C:\Workspace\mafter-effect\verify-comp10-mini-project.zip`;
const COMP10 = "01KVV05RE10X4E9H1AR77JPCH7";
const AUDIO_LAYER = "01KX4ZB7ZATKDMNBN8WB7J4JN1";
const VIDEO2_LAYER = "01KX4ZG0JH74HQDE5HP489GXQC";
const CPU_THROTTLE_RATE = Number(process.env.VERIFY_CPU_THROTTLE ?? 6);
const PLAY_MS = Number(process.env.VERIFY_PLAY_MS ?? 8000);
const HEADLESS = process.env.VERIFY_HEADLESS !== "0";

const browser = HEADLESS
  ? await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] })
  : await chromium
      .launch({ headless: false, channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] })
      .catch(() => chromium.launch({ headless: false, args: ["--autoplay-policy=no-user-gesture-required"] }));
let intentionalClose = false;
browser.on("disconnected", () => { if (!intentionalClose) console.error("!!! browser disconnected unexpectedly !!!"); });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
page.on("crash", () => console.error("!!! page crashed (likely OOM importing the full project) !!!"));
page.setDefaultTimeout(180_000);
const pageErrors = [];
page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
page.on("pageerror", (e) => pageErrors.push(String(e)));

// 起動前に AudioContext.suspend/resume を patch する（previewAudioClock.ts の生成より必ず先に
// 差し込まれるよう addInitScript を使う。ページ内 script より前に評価される）。
await page.addInitScript(() => {
  window.__audioHoldLog = [];
  const proto = window.AudioContext?.prototype;
  if (!proto) return;
  const origSuspend = proto.suspend;
  const origResume = proto.resume;
  proto.suspend = function patchedSuspend(...args) {
    window.__audioHoldLog.push({ t: performance.now(), kind: "suspend" });
    return origSuspend.apply(this, args);
  };
  proto.resume = function patchedResume(...args) {
    window.__audioHoldLog.push({ t: performance.now(), kind: "resume" });
    return origResume.apply(this, args);
  };
});

// zip が大きい（100MB超）ので V8 heap を溢れさせないよう route.fulfill でファイルを直結し、
// ページ内 fetch() で取得する（verify-comp32-webm-instability.mjs と同じ手法）。
await page.route("**/__verify_project.zip", (route) => route.fulfill({ path: ZIP, contentType: "application/zip" }));

const cdp = await page.context().newCDPSession(page);

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => window.__mafterEditorStore?.getState().getFs, { timeout: 20000 });

console.log(`importing project zip (${ZIP})... this may take a while for a large file`);
await page.evaluate(async () => {
  const resp = await fetch("/__verify_project.zip");
  const buf = new Uint8Array(await resp.arrayBuffer());
  const { importZip } = await import("/src/fs/zip.ts");
  const st = window.__mafterEditorStore.getState();
  await importZip(st.getFs(), buf);
  await st.loadFromFs();
});

const setup = await page.evaluate(({ compId, audioLayer, video2Layer }) => {
  const S = () => window.__mafterEditorStore.getState();
  const project = S().project;
  if (!project) return { error: "project not loaded" };
  S().setCurrentComp(compId);
  // Comp 10 の audio レイヤー・第2 video レイヤーは既定 disabled なので有効化する
  // （standalone audio を鳴らしつつ decode 負荷を上げるための一時的な編集・zip は書き換えない）。
  S().updateObject(audioLayer, { enabled: true }, "verify: enable audio layer");
  S().updateObject(video2Layer, { enabled: true }, "verify: enable second video layer");
  return { compId: S().currentCompId, ok: true };
}, { compId: COMP10, audioLayer: AUDIO_LAYER, video2Layer: VIDEO2_LAYER });
console.log("setup:", JSON.stringify(setup));
if (setup.error) { await browser.close(); process.exit(1); }

await page.waitForTimeout(500);

// 重負荷: CPU throttle で video decode/render をタイムラインより遅らせる
// （§11.4 の holdTimeline を誘発する条件。実プロジェクトの重い comp 編集を模擬）。
await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE_RATE });
console.log(`CPU throttled ${CPU_THROTTLE_RATE}x, playing for ${PLAY_MS}ms...`);

const run = await page.evaluate(async ({ durationMs }) => {
  const S = () => window.__mafterEditorStore.getState();
  const frames = [];
  let rafId = 0;
  let intervalId = 0;
  const t0 = performance.now();
  const record = () => {
    frames.push({ t: performance.now() - t0, frame: S().currentFrame, playing: S().isPlaying });
  };
  const sample = () => {
    record();
    if (performance.now() - t0 < durationMs && S().isPlaying) rafId = requestAnimationFrame(sample);
  };
  S().setFrame(0);
  S().setPlaying(true);
  // start() の中の ctx.resume()（再生ジェスチャの正当な resume・holdTimeline とは無関係）が
  // 走り終わるのを少し待ってからカウント開始する。以降に積まれる suspend/resume は holdTimeline 由来のみ。
  await new Promise((resolve) => setTimeout(resolve, 400));
  window.__audioHoldLog.length = 0;
  // CPU throttle 下では rAF が枯れてサンプルが粗くなるため setInterval でも記録する（重複可・判定は frame 単調性のみ）。
  intervalId = setInterval(record, 200);
  rafId = requestAnimationFrame(sample);
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  S().setPlaying(false);
  cancelAnimationFrame(rafId);
  clearInterval(intervalId);
  return { frames, holdLog: window.__audioHoldLog.slice() };
}, { durationMs: PLAY_MS });

await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
intentionalClose = true;
await browser.close();

// --- 判定 ---
const { frames, holdLog } = run;
const suspendCalls = holdLog.filter((e) => e.kind === "suspend").length;
const resumeCalls = holdLog.filter((e) => e.kind === "resume").length;
const lastFrame = frames.length ? frames[frames.length - 1].frame : -1;
const wallSecAtLastFrame = frames.length ? frames[frames.length - 1].t / 1000 : 0;
// audio-master なら frame 進行は壁時計にほぼ比例する（30fps comp なら約 30 frame/秒）はず。
const impliedFps = wallSecAtLastFrame > 0 ? lastFrame / wallSecAtLastFrame : 0;

console.log(`frames sampled: ${frames.length}, lastFrame: ${lastFrame}, wallSecAtLastFrame: ${wallSecAtLastFrame.toFixed(2)}s, impliedFps: ${impliedFps.toFixed(1)}`);
console.log(`AudioContext.suspend()/resume() calls AFTER startup (holdTimeline-driven only): suspend=${suspendCalls} resume=${resumeCalls}`);
console.log("console errors:", pageErrors.length ? pageErrors.slice(0, 5) : "none");

// audio-master 判定: holdTimeline 由来の suspend/resume が 0 で、かつ frame が壁時計とともに進む
// （凍結していない）。frame 単調前進は wrap を跨ぐため「最大到達 frame > 0 かつ複数の相異なる値」で見る。
const distinctFrames = new Set(frames.map((f) => f.frame)).size;
const pass = suspendCalls === 0 && resumeCalls === 0 && frames.length > 3 && distinctFrames > 2 && lastFrame > 0;
console.log(`distinct frames observed: ${distinctFrames}`);
console.log(pass
  ? "\nVERIFY: PASS (audio-master — AudioContext never suspended under CPU-throttled video lag; frame kept advancing)"
  : "\nVERIFY: FAIL");
process.exit(pass ? 0 : 1);
