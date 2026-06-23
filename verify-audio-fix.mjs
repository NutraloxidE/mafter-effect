import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const PORT = process.env.PORT || 5173;
const URL = `http://localhost:${PORT}/`;
const AUDIO = "audio/Angelize_23.11.mastered.mp3";

const b64 = readFileSync(AUDIO).toString("base64");
console.log("mp3 bytes:", Math.round(readFileSync(AUDIO).length / 1024), "KB");

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("[page error]", m.text()); });

await page.goto(URL);
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-waveform-cache"));
await page.reload();
await page.waitForFunction(() => {
  const s = window.__mafterEditorStore;
  return s && s.getState().project && s.getState().currentCompId;
}, { timeout: 15000 });
console.log("booted");

// import the real mp3 + add layer
const imported = await page.evaluate(async (b64) => {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const file = new File([u8], "Angelize.mp3", { type: "audio/mpeg" });
  const store = window.__mafterEditorStore;
  const assetId = await store.getState().importAudioAsset(file);
  if (!assetId) return { error: "import failed" };
  const layerId = store.getState().addAudioLayer(assetId, "Angelize");
  const asset = store.getState().project.assets.find((a) => a.id === assetId);
  return { assetId, layerId, meta: asset?.meta ?? null };
}, b64);
console.log("imported:", JSON.stringify(imported));
if (imported.error) { console.log("FAIL", imported.error); await browser.close(); process.exit(1); }

// duration meta must be the real song length (minutes), not the ~5s comp length
const durSec = imported.meta && typeof imported.meta.duration === "number" ? imported.meta.duration : 0;
console.log("asset.meta.duration(sec):", durSec);

await page.waitForTimeout(1200); // waveform compute

// waveform overlay: bucket amplitudes across the bar — verify it is NOT the crammed whole-song envelope.
// With the fix, the bar shows only the first ~5s slice → roughly uniform loudness (mastered), not a fade.
const wave = await page.evaluate(() => {
  const cvs = [...document.querySelectorAll("canvas")];
  let best = null, bestCount = -1;
  for (const cv of cvs) {
    if (!cv.width || !cv.height) continue;
    const ctx = cv.getContext("2d");
    let count = 0; const colHeights = [];
    try {
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      for (let x = 0; x < cv.width; x++) {
        let top = -1, bot = -1;
        for (let y = 0; y < cv.height; y++) {
          if (d[(y * cv.width + x) * 4 + 3] > 0) { if (top < 0) top = y; bot = y; count++; }
        }
        if (top >= 0) colHeights.push(bot - top);
      }
    } catch { continue; }
    if (count > bestCount) { bestCount = count; best = { count, w: cv.width, h: cv.height, colHeights }; }
  }
  return best;
});
// compare mean height of left third vs right third of the bar
const ch = wave.colHeights;
const third = Math.floor(ch.length / 3);
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const leftMean = mean(ch.slice(0, third));
const rightMean = mean(ch.slice(ch.length - third));
const ratio = rightMean / Math.max(1e-6, leftMean);
console.log(`waveform cols=${ch.length} leftMean=${leftMean.toFixed(1)} rightMean=${rightMean.toFixed(1)} ratio=${ratio.toFixed(2)}`);
await page.screenshot({ path: "verify-audio-fix.png" });

// preload latency: buffer should already be resident → play starts advancing quickly
const play = await page.evaluate(async () => {
  const store = window.__mafterEditorStore;
  store.getState().setFrame(0);
  const t0 = performance.now();
  store.getState().setPlaying(true);
  // poll for frame advance
  let advancedAt = -1;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 16));
    if (store.getState().currentFrame > 0) { advancedAt = performance.now() - t0; break; }
  }
  store.getState().setPlaying(false);
  return { advancedAtMs: advancedAt };
});
console.log("play start latency(ms):", play.advancedAtMs);

// assertions:
//  - duration meta is the real song length (> 30s, well beyond the 5s comp)
//  - waveform spans the bar and is roughly uniform (ratio not a strong fade): 0.5..2.0
//  - playback advanced within ~500ms (no big decode stall; buffer preloaded)
const pass =
  durSec > 30 &&
  ch.length > 50 &&
  ratio > 0.5 && ratio < 2.0 &&
  play.advancedAtMs >= 0 && play.advancedAtMs < 500;

console.log(pass ? "VERIFY PASS" : "VERIFY FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
