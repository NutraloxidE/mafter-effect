// §11.4 異なるアセット間カット境界の先読み warm-up（Next steps #0b）実機検証。
//
// 異なる2アセット（A: 0–60f / B: 60–150f）を連結した comp を組み、再生でカット境界を跨ぎ、
// 境界直後フレームでの入場側 <video> の readyState / videoWidth を計測する。
//  - warm-up あり（修正後）: 境界直後から readyState >= 2 && videoWidth > 0（コールドスタート空白なし）
//  - warm-up なし（修正前）: rs=0 が数フレーム続く（2026-06-30 の実測と同型）
// VERIFY_PORT で対象サーバを切替（worktree=5199 / main=5174 で before/after 比較可能）。
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5199";
const URL = `http://localhost:${PORT}/`;
const VIDEO_A = path.join("for-debug-data", "Comp_20.mp4");
const VIDEO_B = path.join("for-debug-data", "video_motion.mp4");

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

const bytesA = fs.readFileSync(VIDEO_A);
const bytesB = fs.readFileSync(VIDEO_B);

const setup = await page.evaluate(async ({ a, b }) => {
  const store = window.__mafterEditorStore;
  const S = () => store.getState();
  await S().newProject();
  const fileA = new File([new Uint8Array(a.bytes)], a.name, { type: "video/mp4" });
  const fileB = new File([new Uint8Array(b.bytes)], b.name, { type: "video/mp4" });
  const assetA = await S().importVideoAsset(fileA);
  const assetB = await S().importVideoAsset(fileB);
  if (!assetA || !assetB) return { error: "import failed" };
  const layerA = S().addVideoLayer(assetA, "clipA");
  const layerB = S().addVideoLayer(assetB, "clipB");
  if (!layerA || !layerB) return { error: "addVideoLayer failed" };
  S().updateObject(layerA, { inPoint: 0, outPoint: 60 }, "verify inout A");
  S().updateObject(layerB, { inPoint: 60, outPoint: 150 }, "verify inout B");
  return { assetA, assetB, layerA, layerB, boundary: 60 };
}, {
  a: { bytes: [...bytesA], name: "Comp_20.mp4" },
  b: { bytes: [...bytesB], name: "video_motion.mp4" },
});

console.log("setup:", JSON.stringify(setup));
if (setup.error) { await browser.close(); process.exit(1); }

const run = await page.evaluate(async ({ setup }) => {
  const store = window.__mafterEditorStore;
  const S = () => store.getState();
  const { assetB, boundary } = setup;

  S().setPlaying(false);
  S().setFrame(0);
  await new Promise((r) => setTimeout(r, 1500)); // マウント + idle warm-up 猶予

  const samples = [];
  let done;
  const finished = new Promise((r) => { done = r; });
  const deadline = performance.now() + 12000;
  const tick = () => {
    const f = S().currentFrame;
    const vids = [...document.querySelectorAll("video")].filter((v) => v.isConnected);
    samples.push({
      f,
      vids: vids.map((v) => ({
        asset: v.dataset.mafterVideoAsset ?? null,
        rs: v.readyState,
        vw: v.videoWidth,
      })),
    });
    if (f >= boundary + 20 || performance.now() > deadline) { done(); return; }
    requestAnimationFrame(tick);
  };
  S().setPlaying(true);
  requestAnimationFrame(tick);
  await finished;
  S().setPlaying(false);

  return { samples, assetB };
}, { setup });

// 境界直後（f = boundary .. boundary+6）に connected な assetB 側 video の readyState を評価。
const boundary = setup.boundary;
const post = run.samples.filter((s) => s.f >= boundary && s.f <= boundary + 6);
const bStates = [];
for (const s of post) {
  for (const v of s.vids) {
    if (v.asset === setup.assetB) bStates.push({ f: s.f, rs: v.rs, vw: v.vw });
  }
}
console.log("assetB states at boundary+0..6:", JSON.stringify(bStates));

const notReady = bStates.filter((x) => x.rs < 2 || x.vw <= 0);
const seen = bStates.length > 0;
console.log(`assetB samples=${bStates.length} notReady=${notReady.length}`,
  notReady.length ? JSON.stringify(notReady.slice(0, 8)) : "");
console.log("console errors:", errors.length ? errors.slice(0, 5) : "none");

const pass = seen && notReady.length === 0 && errors.length === 0;
console.log(pass ? "\nVERIFY: PASS" : "\nVERIFY: FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
