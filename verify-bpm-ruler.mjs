import { chromium } from "playwright";

const PORT = process.env.PORT || "5173";
const URL = `http://localhost:${PORT}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("console", (m) => { if (m.type() === "error") console.log("PAGE ERR:", m.text()); });

await page.goto(URL);
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload();
await page.waitForFunction(() => {
  const s = window.__mafterEditorStore;
  return s && s.getState().project && s.getState().currentCompId;
}, { timeout: 15000 });

// 120 BPM, 4/4, 30fps, 8s. Two-tier ruler should show timecode (top) + bar.beat (bottom).
await page.evaluate(() => {
  const st = window.__mafterEditorStore.getState();
  st.setCompFps(30);
  st.setCompDuration(240);
  st.setCompBpm(120);
  st.setCompBeatsPerBar(4);
  st.selectObjects([]);
});
await page.waitForTimeout(400);
await page.screenshot({ path: "verify-bpm-ruler-on.png" });

// bpm=0 → single-tier (timecode only).
await page.evaluate(() => window.__mafterEditorStore.getState().setCompBpm(0));
await page.waitForTimeout(400);
await page.screenshot({ path: "verify-bpm-ruler-off.png" });

// Read beat tick labels present while bpm>0 again.
await page.evaluate(() => window.__mafterEditorStore.getState().setCompBpm(120));
await page.waitForTimeout(400);
const labels = await page.evaluate(() => {
  const spans = Array.from(document.querySelectorAll("span"));
  return spans.map((s) => s.textContent?.trim()).filter((t) => /^\d+\.\d+$/.test(t || ""));
});
console.log("bar.beat tick labels:", JSON.stringify(labels.slice(0, 20)));
console.log(labels.some((l) => l === "1.1") ? "PASS ✅ (found bar.beat ticks)" : "FAIL ❌");

await browser.close();
