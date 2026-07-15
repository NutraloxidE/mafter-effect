// §3: assets/font/ 導入前のプロジェクト（フォントが assets/ 直下）を読み込むと、
// loadFromFs が assets/font/<id>.<ext> へ移送し asset.path を書き換えることの実機検証。
import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5175";
const URL = `https://localhost:${PORT}/`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);

// 旧レイアウトを再現: 3D Extrude で font asset を作らせてから、FS/project.json を
// assets/ 直下（migration 前の姿）へ巻き戻す。
await page.getByRole("button", { name: "+ Text", exact: true }).click();
await page.waitForTimeout(300);
await page.locator("select").filter({ has: page.locator('option[value*="Noto Sans"]') }).first()
  .selectOption({ label: "Noto Sans" });
await page.waitForTimeout(300);
const geomToggle = await page.evaluateHandle(() => {
  const span = [...document.querySelectorAll("span")].find((s) => s.textContent === "3D Extrude");
  return span?.parentElement.querySelector("button") ?? null;
});
await geomToggle.evaluate((el) => el.click());
await page.waitForTimeout(1500);

const before = await page.evaluate(async () => {
  const store = (await import("/src/editor/store.ts")).useEditorStore;
  const { saveProject } = await import("/src/core/projectFs.ts");
  await store.getState().loadFromFs();
  const s = store.getState();
  const fs = s.getFs();
  const p = s.project;
  const moved = [];
  for (const a of p.assets) {
    if (a.kind !== "font") continue;
    const legacy = `assets/${a.path.split("/").pop()}`;
    await fs.write(legacy, await fs.read(a.path));
    await fs.delete(a.path);
    moved.push({ id: a.id, legacy });
  }
  const legacyProject = {
    ...p,
    assets: p.assets.map((a) => {
      const m = moved.find((x) => x.id === a.id);
      return m ? { ...a, path: m.legacy } : a;
    }),
  };
  await saveProject(fs, legacyProject);
  return legacyProject.assets.filter((a) => a.kind === "font").map((a) => a.path);
});

const after = await page.evaluate(async () => {
  const store = (await import("/src/editor/store.ts")).useEditorStore;
  await store.getState().loadFromFs();
  const s = store.getState();
  const fs = s.getFs();
  const fonts = s.project.assets.filter((a) => a.kind === "font");
  const onDisk = [];
  for (const a of fonts) onDisk.push({ path: a.path, exists: await fs.exists(a.path) });
  const strays = (await fs.list("assets")).filter((p) => /\.(ttf|otf|woff2?)$/i.test(p) && !p.startsWith("assets/font/"));
  return { paths: fonts.map((a) => a.path), onDisk, strays };
});

const report = { before, after, errors };
console.log(JSON.stringify(report, null, 2));

const ok =
  before.length > 0 &&
  before.every((p) => !p.startsWith("assets/font/")) &&
  after.paths.length === before.length &&
  after.paths.every((p) => p.startsWith("assets/font/")) &&
  after.onDisk.every((f) => f.exists) &&
  after.strays.length === 0 &&
  errors.length === 0;

await browser.close();
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
