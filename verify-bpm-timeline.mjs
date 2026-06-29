import { chromium } from "playwright";

const PORT = process.env.PORT || "5173";
const URL = `http://localhost:${PORT}/`;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("PAGE ERR:", m.text()); });

await page.goto(URL);
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload();
await page.waitForFunction(() => {
  const s = window.__mafterEditorStore;
  return s && s.getState().project && s.getState().currentCompId;
}, { timeout: 15000 });

// 30fps, frame 60. bpm=0 → timecode only. bpm=120 → "· 2.1" companion.
await page.evaluate(() => {
  const st = window.__mafterEditorStore.getState();
  st.setCompFps(30);
  st.setCompDuration(150);
  st.setCompBpm(0);
  st.setFrame(60);
});
await page.waitForTimeout(300);

const readTc = () => page.locator('[data-testid="tl-timecode"]').textContent();

const off = (await readTc()).trim();
console.log("bpm=0 timecode:", JSON.stringify(off));

await page.evaluate(() => {
  const st = window.__mafterEditorStore.getState();
  st.setCompBpm(120);
});
await page.waitForTimeout(300);
const on = (await readTc()).trim();
console.log("bpm=120 timecode:", JSON.stringify(on));

// 3/4 time at frame 45 → bar 2 beat 1.
await page.evaluate(() => {
  const st = window.__mafterEditorStore.getState();
  st.setCompBeatsPerBar(3);
  st.setFrame(45);
});
await page.waitForTimeout(300);
const threeFour = (await readTc()).trim();
console.log("bpm=120 3/4 @f45:", JSON.stringify(threeFour));

// Back to bpm=0 → companion disappears.
await page.evaluate(() => {
  const st = window.__mafterEditorStore.getState();
  st.setCompBpm(0);
  st.setFrame(60);
});
await page.waitForTimeout(300);
const offAgain = (await readTc()).trim();
console.log("bpm=0 again:", JSON.stringify(offAgain));

await page.screenshot({ path: "verify-bpm-timeline.png" });

const pass =
  off === "0:00:02:00" &&
  on === "0:00:02:00 · 2.1" &&
  threeFour === "0:00:01:15 · 2.1" &&
  offAgain === "0:00:02:00";
console.log(pass ? "PASS ✅" : "FAIL ❌");

await browser.close();
process.exit(pass ? 0 : 1);
