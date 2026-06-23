import { chromium } from "playwright";

const PORT = process.env.PORT || 5173;
const URL = `http://localhost:${PORT}/`;

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("[page error]", m.text()); });

await page.goto(URL);
// fresh FS
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-waveform-cache"));
await page.reload();

// wait for boot
await page.waitForFunction(() => {
  const s = window.__mafterEditorStore;
  return s && s.getState().project && s.getState().currentCompId;
}, { timeout: 15000 });
console.log("booted");

// Build a WAV File in-page: 1.5s, sustained 220Hz near full-scale (海苔) + sharp transient every 0.5s (kick-like).
const result = await page.evaluate(async () => {
  const sr = 44100, dur = 1.5;
  const n = Math.floor(sr * dur);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0.92 * Math.sin((2 * Math.PI * 220 * i) / sr);
    const phase = i % Math.floor(sr * 0.5);
    if (phase < sr * 0.004) v = Math.max(-1, Math.min(1, v + (1 - phase / (sr * 0.004))));
    data[i] = v;
  }
  // encode 16-bit PCM WAV
  const bytesPerSample = 2;
  const buf = new ArrayBuffer(44 + n * bytesPerSample);
  const dv = new DataView(buf);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF"); dv.setUint32(4, 36 + n * bytesPerSample, true); wstr(8, "WAVE");
  wstr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * bytesPerSample, true); dv.setUint16(32, bytesPerSample, true); dv.setUint16(34, 16, true);
  wstr(36, "data"); dv.setUint32(40, n * bytesPerSample, true);
  let o = 44;
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, data[i])); dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  const file = new File([buf], "kick.wav", { type: "audio/wav" });

  const store = window.__mafterEditorStore;
  const assetId = await store.getState().importAudioAsset(file);
  if (!assetId) return { error: "import failed" };
  const layerId = store.getState().addAudioLayer(assetId, "kick");
  return { assetId, layerId };
});
console.log("imported:", JSON.stringify(result));
if (result.error) { console.log("FAIL", result.error); await browser.close(); process.exit(1); }

await page.waitForTimeout(400);

// helper: read the audio layer canvas pixel signature for current mode
async function canvasSig() {
  return await page.evaluate(() => {
    const canvases = [...document.querySelectorAll("canvas")];
    // pick the canvas with the most non-transparent pixels (the waveform)
    let best = null, bestCount = -1;
    for (const cv of canvases) {
      if (cv.width === 0 || cv.height === 0) continue;
      const ctx = cv.getContext("2d");
      let count = 0, sum = 0;
      try {
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) { count++; sum += i; } }
      } catch { continue; }
      if (count > bestCount) { bestCount = count; best = { count, sum, w: cv.width, h: cv.height }; }
    }
    return best;
  });
}

// set waveform mode via store and capture per mode
const sigs = {};
for (const mode of ["raw", "donshari", "transient"]) {
  await page.evaluate((m) => window.__mafterEditorStore.getState().setWaveformMode(m), mode);
  // wait for cache compute + redraw
  await page.waitForTimeout(900);
  sigs[mode] = await canvasSig();
  console.log(`mode=${mode} ->`, JSON.stringify(sigs[mode]));
  await page.screenshot({ path: `verify-audio-${mode}.png` });
}

// playback: audio layer present → frame should advance during play
const playInfo = await page.evaluate(async () => {
  const store = window.__mafterEditorStore;
  store.getState().setFrame(0);
  const before = store.getState().currentFrame;
  store.getState().setPlaying(true);
  await new Promise((r) => setTimeout(r, 700));
  const during = store.getState().currentFrame;
  store.getState().setPlaying(false);
  return { before, during, playing: store.getState().isPlaying };
});
console.log("playback:", JSON.stringify(playInfo));

// hasAudioLayers check via the pure module path
const audioDetected = await page.evaluate(async () => {
  const { hasAudioLayers } = await import("/src/player/BundleAudioClock.ts");
  const store = window.__mafterEditorStore;
  const st = store.getState();
  const comp = st.project.compositions.find((c) => c.id === st.currentCompId);
  return hasAudioLayers(st.project, comp);
});
console.log("audioDetected:", audioDetected);

// assertions
const pass =
  sigs.raw && sigs.raw.count > 50 &&
  sigs.transient && sigs.transient.count > 0 &&
  sigs.raw.count !== sigs.transient.count &&   // mode changes the drawing
  playInfo.during > playInfo.before &&
  audioDetected === true;

console.log(pass ? "VERIFY PASS" : "VERIFY FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
