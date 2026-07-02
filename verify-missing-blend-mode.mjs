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

// 正準 project を addSolid で作り、FS 上の project.json にだけ未知 blendMode を注入 → loadFromFs
const setup = await page.evaluate(async () => {
  const store = window.__mafterEditorStore;
  const id = store.getState().addSolid("DitherLayer");
  if (!id) return { error: "addSolid failed" };

  const fs = store.getState().getFs();
  await store.getState().saveToFs?.();
  const text = await fs.readText("project.json");
  const raw = JSON.parse(text);
  const comp = raw.compositions.find((c) => c.id === raw.rootComposition);
  const obj = comp?.objects.find((o) => o.id === id);
  if (!obj) return { error: "object not in project.json", id };

  obj.blendMode = "ditherDissolve";
  await fs.write("project.json", JSON.stringify(raw, null, 2) + "\n");

  try {
    await store.getState().loadFromFs();
  } catch (e) {
    return { error: `loadFromFs threw: ${e}`, id };
  }

  const st = store.getState();
  const comp2 = st.project.compositions.find((c) => c.id === st.currentCompId);
  const loaded = comp2?.objects.find((o) => o.id === id);
  if (!loaded) return { error: "object missing after loadFromFs", id };

  store.getState().selectObjects([id]);
  return { id, missing: st.missingBlendModes[id], blendMode: loaded.blendMode };
});

if (setup.error) {
  console.log("setup failed:", setup);
  await page.screenshot({ path: "verify-missing-blend-mode.png" });
  await browser.close();
  process.exit(1);
}

await page.waitForTimeout(400);

const check = await page.evaluate((id) => {
  const store = window.__mafterEditorStore;
  const st = store.getState();
  const missing = st.missingBlendModes[id];
  const comp2 = st.project.compositions.find((c) => c.id === st.currentCompId);
  const obj = comp2?.objects.find((o) => o.id === id);
  const el = document.querySelector(`[data-object-id="${id}"]`);
  const cs = el && getComputedStyle(el);
  const selects = [...document.querySelectorAll("select")];
  const blendSelect = selects.find((s) => [...s.options].some((o) => o.text.includes("(missing)")));
  const options = blendSelect ? [...blendSelect.options].map((o) => o.text) : [];
  return {
    missing,
    blendMode: obj?.blendMode,
    mixBlendMode: cs?.mixBlendMode,
    maskImage: cs?.maskImage,
    options,
    selected: st.selectedObjectIds,
  };
}, setup.id);

console.log("setup:", setup);
console.log("missing blend check:", check);

const ok =
  check.missing === "ditherDissolve" &&
  check.blendMode === undefined &&
  check.mixBlendMode === "normal" &&
  (!check.maskImage || check.maskImage === "none") &&
  check.options.some((t) => t.includes("ditherDissolve") && t.includes("(missing)"));

console.log(ok ? "PASS" : "FAIL");
await page.screenshot({ path: "verify-missing-blend-mode.png" });
await browser.close();
process.exit(ok ? 0 : 1);
