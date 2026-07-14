// §5.5f / §26.3-26.4: Bundled フォント自動アセット化 + web-safe 3D 不可 + カスタムアップロードの実機検証。
// 実際の UI 操作（+ Text → Font 選択 → 3D Extrude トグル）を Playwright で駆動する。
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

// helper: label span の隣にある select/button を探す。
async function rowControl(label, tag) {
  return page.evaluateHandle(({ label, tag }) => {
    const spans = [...document.querySelectorAll("span")];
    const span = spans.find((s) => s.textContent === label);
    if (!span) return null;
    return span.parentElement.querySelector(tag);
  }, { label, tag });
}

await page.getByRole("button", { name: "+ Text", exact: true }).click();
await page.waitForTimeout(300);

// 1) Font select を Bundled "Noto Sans" に変更。
const fontSelect = await rowControl("Font", "select");
await fontSelect.evaluate((el) => {
  const opt = [...el.options].find((o) => o.textContent === "Noto Sans");
  if (!opt) throw new Error("Noto Sans option not found");
});
await page.locator("select").filter({ has: page.locator('option[value*="Noto Sans"]') }).first()
  .selectOption({ label: "Noto Sans" });
await page.waitForTimeout(300);

// 2) 3D Extrude ON。
const geomToggle = await rowControl("3D Extrude", "button");
await geomToggle.evaluate((el) => el.click());
await page.waitForTimeout(800);

const afterBundled = await page.evaluate(() => ({
  canvas: !!document.querySelector("canvas.mafter-geom3d-canvas"),
  warning: [...document.querySelectorAll("span")].some((s) => s.textContent?.includes("3D 化できません")),
}));

// 3) Font を web-safe "Arial" に変更（3D はまだ ON のまま）。
await page.locator("select").filter({ has: page.locator('option[value^="Arial"]') }).first()
  .selectOption({ label: "Arial (no-3D)" });
await page.waitForTimeout(800);

const afterWebSafe = await page.evaluate(() => ({
  canvas: !!document.querySelector("canvas.mafter-geom3d-canvas"),
  warning: [...document.querySelectorAll("span")].some((s) => s.textContent?.includes("3D 化できません")),
}));

// 4) project.assets に kind:"font" (Noto Sans) が追加されているか、自前 store instance で FS を再読込して確認。
const assets = await page.evaluate(async () => {
  const store = (await import("/src/editor/store.ts")).useEditorStore;
  await store.getState().loadFromFs();
  return store.getState().project.assets.filter((a) => a.kind === "font").map((a) => a.meta?.family);
});

const report = { afterBundled, afterWebSafe, fontAssets: assets, errors };
console.log(JSON.stringify(report, null, 2));

const ok =
  afterBundled.canvas === true &&
  afterBundled.warning === false &&
  afterWebSafe.canvas === false &&
  afterWebSafe.warning === true &&
  assets.includes("Noto Sans") &&
  errors.length === 0;

await browser.close();
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
