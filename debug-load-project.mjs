import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5173";
const APP_URL = `http://localhost:${PORT}/`;
const FIXTURE_DIR = ".verify-fixture-src";

const project = JSON.parse(fs.readFileSync("debug-project.json", "utf8"));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => console.log("[console]", m.type(), m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));

await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => window.__mafterEditorStore?.getState().getFs, { timeout: 20000 });

const result = await page.evaluate(async (proj) => {
  const st = window.__mafterEditorStore.getState();
  const fsInst = st.getFs();
  await fsInst.write("project.json", JSON.stringify(proj, null, 2) + "\n");
  try {
    const { loadProject } = await import("/src/core/projectFs.ts");
    const r = await loadProject(fsInst);
    return { ok: true, warnings: r.warnings, rootComposition: r.project.rootComposition };
  } catch (e) {
    return { ok: false, error: String(e), stack: e?.stack };
  }
}, project);

console.log(JSON.stringify(result, null, 2));
await browser.close();
