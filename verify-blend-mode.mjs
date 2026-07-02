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

const result = await page.evaluate(async () => {
  const store = window.__mafterEditorStore;
  const st = () => store.getState();
  const id1 = st().addSolid("A");
  const id2 = st().addSolid("B");
  return { id1, id2 };
});
console.log("setup:", result);

const ids = await page.evaluate(() => {
  const store = window.__mafterEditorStore;
  const st = store.getState();
  const comp = st.project.compositions.find((c) => c.id === st.currentCompId);
  return comp.objects.map((o) => o.id);
});
const topId = ids[ids.length - 1];

await page.evaluate((id) => {
  window.__mafterEditorStore.getState().setBlendMode(id, "multiply");
}, topId);
await page.waitForTimeout(300);

const multiplyCheck = await page.evaluate((id) => {
  const el = document.querySelector(`[data-object-id="${id}"]`);
  return { found: !!el, mixBlendMode: el && getComputedStyle(el).mixBlendMode };
}, topId);
console.log("multiply check:", multiplyCheck);

await page.screenshot({ path: "verify-blend-mode.png" });

const ok = multiplyCheck.mixBlendMode === "multiply";
console.log(ok ? "PASS" : "FAIL");

await browser.close();
process.exit(ok ? 0 : 1);
