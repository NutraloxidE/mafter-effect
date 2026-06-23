import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const PORT = process.env.PORT || 5173;
const URL = `http://localhost:${PORT}/`;
const AUDIO = "audio/Angelize_23.11.mastered.mp3";
const b64 = readFileSync(AUDIO).toString("base64");

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("[page error]", m.text()); });

await page.goto(URL);
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-waveform-cache"));
await page.reload();
await page.waitForFunction(() => window.__mafterEditorStore && window.__mafterEditorStore.getState().project && window.__mafterEditorStore.getState().currentCompId, { timeout: 15000 });
console.log("booted");

// import, add layer, then STRIP meta to simulate an asset imported before the fix.
const r = await page.evaluate(async (b64) => {
  const bin = atob(b64); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const store = window.__mafterEditorStore;
  const assetId = await store.getState().importAudioAsset(new File([u8], "Angelize.mp3", { type: "audio/mpeg" }));
  store.getState().addAudioLayer(assetId, "Angelize");
  // simulate legacy asset: remove meta from project (as if loaded from old project.json)
  const st = store.getState();
  const proj = st.project;
  const assets = proj.assets.map((a) => a.id === assetId ? { id: a.id, path: a.path, kind: a.kind } : a);
  store.setState({ project: { ...proj, assets } });
  const after = store.getState().project.assets.find((a) => a.id === assetId);
  return { assetId, metaAfterStrip: after?.meta ?? null };
}, b64);
console.log("meta after strip:", JSON.stringify(r.metaAfterStrip)); // should be null/undefined

await page.waitForTimeout(1500); // waveform compute + buffer load for real duration

// measure waveform column heights across the full bar in 5 segments.
const seg = await page.evaluate(() => {
  const cvs = [...document.querySelectorAll("canvas")];
  let best = null, bestCount = -1;
  for (const cv of cvs) {
    if (!cv.width || !cv.height) continue;
    const ctx = cv.getContext("2d");
    let count = 0; const colH = [];
    try {
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      for (let x = 0; x < cv.width; x++) {
        let top = -1, bot = -1;
        for (let y = 0; y < cv.height; y++) {
          if (d[(y * cv.width + x) * 4 + 3] > 0) { if (top < 0) top = y; bot = y; count++; }
        }
        colH.push(top >= 0 ? bot - top : 0);
      }
    } catch { continue; }
    if (count > bestCount) { bestCount = count; best = { w: cv.width, h: cv.height, colH }; }
  }
  return best;
});
const colH = seg.colH;
const n = colH.length;
const segMeans = [];
for (let s = 0; s < 5; s++) {
  const a = colH.slice(Math.floor(s * n / 5), Math.floor((s + 1) * n / 5));
  segMeans.push(a.reduce((x, v) => x + v, 0) / Math.max(1, a.length));
}
console.log("segment mean heights (L→R):", segMeans.map((v) => v.toFixed(1)).join(", "));
await page.screenshot({ path: "verify-audio-nometa.png" });

// crammed/shrinking symptom = last segment collapses to ~flat while first is tall.
const first = segMeans[0], last = segMeans[4];
const lastToFirst = last / Math.max(1e-6, first);
console.log(`lastToFirst=${lastToFirst.toFixed(2)} (crammed≈near 0; fixed≈uniform ~1)`);

// PASS: even WITHOUT meta, the bar shows the first slice uniformly (last segment not collapsed).
const pass = first > 2 && last > 2 && lastToFirst > 0.4;
console.log(pass ? "VERIFY PASS" : "VERIFY FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
