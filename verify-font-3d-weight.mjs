// §5.5f / §26.4.1: 3D Extrude が text の weight プロパティに追従することの実機検証。
// 回帰内容: font asset を family だけで重複判定・キャッシュしていたため、最初に埋め込んだ
// weight（通常 400）のアウトラインが居座り、weight を 700 にしても 3D だけ細いままだった。
// 測定は GL canvas の実ピクセル（インク量）。Bold は Regular より確実にインクが増える。
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

async function rowControl(label, tag) {
  return page.evaluateHandle(({ label, tag }) => {
    const spans = [...document.querySelectorAll("span")];
    const span = spans.find((s) => s.textContent === label);
    if (!span) return null;
    return span.parentElement.querySelector(tag);
  }, { label, tag });
}

/** geom3d canvas の不透明ピクセル数 = 押し出された字面のインク量。 */
async function measureInk() {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas.mafter-geom3d-canvas");
    if (!canvas) return null;
    const off = document.createElement("canvas");
    off.width = canvas.width;
    off.height = canvas.height;
    const ctx = off.getContext("2d");
    ctx.drawImage(canvas, 0, 0);
    const { data } = ctx.getImageData(0, 0, off.width, off.height);
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 16) ink++;
    return ink;
  });
}

await page.getByRole("button", { name: "+ Text", exact: true }).click();
await page.waitForTimeout(300);

// Bundled "Noto Sans"（400/500/700 を同梱）を選ぶ。
await page.locator("select").filter({ has: page.locator('option[value*="Noto Sans"]') }).first()
  .selectOption({ label: "Noto Sans" });
await page.waitForTimeout(300);

// 3D Extrude ON（この時点の weight = 400 が埋め込まれる）。
const geomToggle = await rowControl("3D Extrude", "button");
await geomToggle.evaluate((el) => el.click());
await page.waitForTimeout(1200);

const ink400 = await measureInk();

// weight を 700 に変更。修正前はここで 3D のインクが変化しなかった。
const weightSelect = await rowControl("Weight", "select");
await weightSelect.evaluate((el) => {
  el.value = "700";
  el.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(1500);

const ink700 = await measureInk();

const fontAssets = await page.evaluate(async () => {
  const store = (await import("/src/editor/store.ts")).useEditorStore;
  await store.getState().loadFromFs();
  return store.getState().project.assets
    .filter((a) => a.kind === "font")
    .map((a) => ({ family: a.meta?.family, weight: a.meta?.weight }));
});

const ratio = ink400 ? ink700 / ink400 : 0;
const report = { ink400, ink700, ratio: Number(ratio.toFixed(3)), fontAssets, errors };
console.log(JSON.stringify(report, null, 2));

const ok =
  ink400 > 100 &&
  ink700 > 100 &&
  // Bold のアウトラインが実際に使われていれば字面は有意に太る
  ratio > 1.05 &&
  fontAssets.some((a) => a.family === "Noto Sans" && a.weight === 400) &&
  fontAssets.some((a) => a.family === "Noto Sans" && a.weight === 700) &&
  errors.length === 0;

await browser.close();
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
