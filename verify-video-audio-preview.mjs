// §11.4 動画内蔵音声 — preview の mute 制御検証。
// 再生中は <video> がアンミュート、停止/スクラブ後はミュートに戻ることを確認する。
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `http://localhost:${PORT}/`;
const VIDEO_PATH = resolve("for-debug-data/video_with_audio.mp4");

console.log("verify-video-audio-preview: starting…");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(800);

const videoBytes = readFileSync(VIDEO_PATH);

await page.evaluate(async ({ bytes, name }) => {
  const storeMod = await import("/src/editor/store.ts");
  const S = () => storeMod.useEditorStore.getState();
  for (let i = 0; i < 80 && !(S().project && S().currentCompId); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  await S().newProject();
  const file = new File([new Uint8Array(bytes)], name, { type: "video/mp4" });
  const assetId = await S().importVideoAsset(file);
  if (!assetId) throw new Error("importVideoAsset failed");
  const layer = S().addVideoLayer(assetId, "video-audio");
  if (!layer) throw new Error("addVideoLayer failed");
  // §11.4 keyframed gain: 内蔵音声を 50% に設定し、preview の video.volume に反映されることを確認する。
  const obj = S().project.compositions
    .find((c) => c.id === S().currentCompId)
    .objects.find((o) => o.id === layer);
  const nextComponents = obj.components.map((c) =>
    c.type === "video" ? { ...c, props: { ...c.props, gain: { value: 0.5, keyframes: [] } } } : c,
  );
  S().updateObject(layer, { components: nextComponents }, "Set volume");
  await new Promise((r) => setTimeout(r, 800));
}, { bytes: [...videoBytes], name: "video_with_audio.mp4" });

function videoMuted() {
  return page.evaluate(() => {
    const v = document.querySelector("video");
    return v ? { found: true, muted: v.muted, paused: v.paused, volume: v.volume } : { found: false };
  });
}

// 初期（停止）= muted
const idle = await videoMuted();
console.log("idle:", idle);

// 再生開始（再生ボタン）
await page.evaluate(() => {
  // 再生トグルをストア経由で叩く（UI ボタン依存を避ける）
  return import("/src/editor/store.ts").then((m) => {
    const S = m.useEditorStore.getState();
    if (typeof S.play === "function") S.play();
    else if (typeof S.togglePlay === "function") S.togglePlay();
    else if (typeof S.setPlaying === "function") S.setPlaying(true);
  });
});
await page.waitForTimeout(900);
const playing = await videoMuted();
console.log("playing:", playing);

// 停止
await page.evaluate(() => import("/src/editor/store.ts").then((m) => {
  const S = m.useEditorStore.getState();
  if (typeof S.pause === "function") S.pause();
  else if (typeof S.togglePlay === "function") S.togglePlay();
  else if (typeof S.setPlaying === "function") S.setPlaying(false);
}));
await page.waitForTimeout(500);
const stopped = await videoMuted();
console.log("stopped:", stopped);

let pass = true;
if (!idle.found) { console.error("FAIL: no <video> element"); pass = false; }
if (idle.found && idle.muted !== true) { console.error("FAIL: idle video should be muted"); pass = false; }
if (playing.found && playing.muted !== false) { console.error("FAIL: playing video should be unmuted (§11.4)"); pass = false; }
if (playing.found && !(Math.abs(playing.volume - 0.5) < 0.01)) { console.error(`FAIL: playing video volume should reflect gain 0.5, got ${playing.volume}`); pass = false; }
else if (playing.found) console.log(`video.volume reflects gain OK: ${playing.volume}`);
if (stopped.found && stopped.muted !== true) { console.error("FAIL: stopped video should be muted again"); pass = false; }

if (errors.length > 0) { console.error("console errors:", errors); pass = false; }

await browser.close();
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
