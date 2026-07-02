// §11.4 trim-in forceSeek 修正（e9f7928）の実機検証。
//
// 同一アセット連結カット（Comp 23 系: a.outPoint == b.inPoint・同一 asset）で:
//  Case A（無変更・読み出し位置連続）: 境界で seek せず currentTime が連続（無音継続維持）。
//  Case B（b.trimStart を +6f = 0.2s ずらす）: 差が 0.5s 未満でも境界で半フレーム精度の
//    forceSeek が働き、currentTime が新 trim-in の軌道へジャンプする（修正前は seek 抜け）。
//
// 判定: 境界前の軌道オフセット b_pre = median(ct - clip1期待時刻) と
//       境界後の b_post = median(ct - clip2期待時刻) を比較。
//       seek が正しく効いていれば A/B とも b_post ≈ b_pre（期待軌道に乗る）。
//       修正前の B は b_post ≈ b_pre - 0.2（旧軌道のまま＝期待から 0.2s 遅れ）になる。
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5174";
const URL = `http://localhost:${PORT}/`;
const ZIP_PATH = path.join("for-debug-data", "mafter-project (11).zip");
const TRIM_DELTA_FRAMES = 6; // 0.2s @30fps（旧 PLAYBACK_RESYNC_THRESHOLD_SEC=0.5 未満）

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForFunction(() => {
  const s = window.__mafterEditorStore;
  return s && s.getState().project && s.getState().currentCompId;
}, { timeout: 20000 });

const zipBytes = fs.readFileSync(ZIP_PATH);

// zip import → 同一アセット連結境界を持つ timeline comp と隣接クリップ対を特定。
const setup = await page.evaluate(async ({ zipArr }) => {
  const { importZip } = await import("/src/fs/zip.ts");
  const store = window.__mafterEditorStore;
  const S = () => store.getState();
  await importZip(S().getFs(), new Uint8Array(zipArr));
  await S().loadFromFs();
  const project = S().project;
  for (const comp of project.compositions) {
    if (comp.kind !== "timeline") continue;
    const vids = comp.objects
      .filter((o) => o.enabled && o.components.some((c) => c.type === "video" && typeof c.props.asset === "string" && c.props.asset))
      .map((o) => {
        const vc = o.components.find((c) => c.type === "video");
        return { id: o.id, inPoint: o.inPoint, outPoint: o.outPoint, asset: vc.props.asset, trimStart: vc.props.trimStart ?? 0 };
      })
      .sort((x, y) => x.inPoint - y.inPoint);
    for (let i = 0; i + 1 < vids.length; i++) {
      const a = vids[i], b = vids[i + 1];
      if (a.outPoint === b.inPoint && a.asset === b.asset) {
        return { compId: comp.id, compName: comp.name, fps: comp.fps ?? 30, a, b };
      }
    }
  }
  return { error: "no adjacent same-asset video pair found" };
}, { zipArr: [...zipBytes] });

console.log("setup:", JSON.stringify(setup, null, 2));
if (setup.error) { await browser.close(); process.exit(1); }

// 1 シナリオ再生: trimDelta フレームだけ b.trimStart をずらし（0=無変更）、
// 境界前後を rAF サンプリングして {frame, currentTime} 列と seeking イベントを返す。
async function runScenario(trimDelta) {
  return await page.evaluate(async ({ setup, trimDelta }) => {
    const store = window.__mafterEditorStore;
    const S = () => store.getState();
    const { compId, a, b, fps } = setup;

    // trim 変更（updateObject 経由・undo 可だが検証後に復元する）
    const patchTrim = (delta) => {
      const comp = S().project.compositions.find((c) => c.id === compId);
      const obj = comp.objects.find((o) => o.id === b.id);
      const components = obj.components.map((c) =>
        c.type === "video" ? { ...c, props: { ...c.props, trimStart: (b.trimStart ?? 0) + delta } } : c
      );
      S().updateObject(b.id, { components }, "verify trim patch");
    };
    if (trimDelta !== 0) patchTrim(trimDelta);

    S().setCurrentComp(compId);
    S().setPlaying(false);
    S().setFrame(Math.max(0, b.inPoint - 20));
    // マウント + idle warm-up の猶予
    await new Promise((r) => setTimeout(r, 1200));

    // seeking イベント計測。listener は要素に1度だけ貼るが、push 先はシナリオごとに
    // リセットされるグローバル配列（クロージャ配列だと2回目のシナリオで死んだ配列に積まれる）。
    window.__mafterSeekLog = [];
    const hookSeek = (v) => {
      if (v.__mafterSeekHooked) return;
      v.__mafterSeekHooked = true;
      v.addEventListener("seeking", () => {
        window.__mafterSeekLog.push({ frame: S().currentFrame, ct: v.currentTime });
      });
    };
    document.querySelectorAll("video").forEach(hookSeek);

    const samples = [];
    let done;
    const finished = new Promise((r) => { done = r; });
    const endFrame = b.inPoint + 25;
    const deadline = performance.now() + 10000;
    const tick = () => {
      document.querySelectorAll("video").forEach(hookSeek);
      const f = S().currentFrame;
      const vids = [...document.querySelectorAll("video")].filter((v) => v.isConnected);
      samples.push({ f, cts: vids.map((v) => ({ ct: v.currentTime, paused: v.paused })) });
      if (f >= endFrame || performance.now() > deadline) { done(); return; }
      requestAnimationFrame(tick);
    };
    S().setPlaying(true);
    requestAnimationFrame(tick);
    await finished;
    S().setPlaying(false);
    if (trimDelta !== 0) patchTrim(0); // 復元

    return { samples, seekEvents: window.__mafterSeekLog };
  }, { setup, trimDelta });
}

const median = (arr) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

function analyze(name, run, trimDelta) {
  const { a, b, fps } = setup;
  const trimUsed = (b.trimStart ?? 0) + trimDelta;
  // 各サンプルは connected video 1 本前提（同一アセット pool 再利用）。複数なら先頭。
  const pts = run.samples
    .filter((s) => s.cts.length > 0)
    .map((s) => ({ f: s.f, ct: s.cts[0].ct }));
  const pre = pts.filter((p) => p.f >= b.inPoint - 15 && p.f <= b.inPoint - 2)
    .map((p) => p.ct - (p.f - a.inPoint + (a.trimStart ?? 0)) / fps);
  const post = pts.filter((p) => p.f >= b.inPoint + 4 && p.f <= b.inPoint + 20)
    .map((p) => p.ct - (p.f - b.inPoint + trimUsed) / fps);
  const bPre = median(pre);
  const bPost = median(post);
  const boundarySeeks = run.seekEvents.filter((e) => e.frame >= b.inPoint - 2 && e.frame <= b.inPoint + 6);
  const res = { name, bPre, bPost, drift: bPost !== null && bPre !== null ? bPost - bPre : null, preN: pre.length, postN: post.length, boundarySeeks: boundarySeeks.length, totalSeeks: run.seekEvents.length };
  console.log(JSON.stringify(res));
  return res;
}

console.log("\n--- Case A: seamless (trim unchanged) ---");
const runA = await runScenario(0);
const resA = analyze("A-seamless", runA, 0);

console.log("\n--- Case B: trim-in shifted +" + TRIM_DELTA_FRAMES + "f (0.2s) ---");
const runB = await runScenario(TRIM_DELTA_FRAMES);
const resB = analyze("B-trim-shift", runB, TRIM_DELTA_FRAMES);

// 判定:
//  A: 期待軌道からのドリフト無し（|drift| < 0.1s）かつ境界 seek 無し（無音継続維持）。
//  B: 新 trim-in の期待軌道に乗る（|drift| < 0.1s）。修正前は drift ≈ -0.2s になる。
//     境界 seek は 1 回以上（forceSeek が実際に発火した証跡）。
const passA = resA.drift !== null && Math.abs(resA.drift) < 0.1 && resA.boundarySeeks === 0;
const passB = resB.drift !== null && Math.abs(resB.drift) < 0.1 && resB.boundarySeeks >= 1;

console.log("\nA (seamless continuity, no boundary seek):", passA ? "PASS" : "FAIL");
console.log("B (forceSeek to shifted trim-in):", passB ? "PASS" : "FAIL");
console.log("console errors:", errors.length ? errors.slice(0, 5) : "none");

await browser.close();
const pass = passA && passB && errors.length === 0;
console.log(pass ? "\nVERIFY: PASS" : "\nVERIFY: FAIL");
process.exit(pass ? 0 : 1);
