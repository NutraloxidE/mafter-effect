// §20.5: 3D Extrude が自動で埋め込む ttf が Project パネルのルートに散らばらず、
// ルート直下の `fonts` フォルダへ入ることの実機検証（pre-rendered フォルダと同じ扱い）。
// 併せて、旧プロジェクト（ルート直下に ttf）の読み込み時移送も確認する。
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

async function tree() {
  return page.evaluate(async () => {
    const store = (await import("/src/editor/store.ts")).useEditorStore;
    const { orderedEntriesForParent } = await import("/src/core/projectTree.ts");
    await store.getState().loadFromFs();
    const p = store.getState().project;
    const bins = p.bins ?? [];
    const label = (e) =>
      e.kind === "asset" ? `asset:${p.assets.find((a) => a.id === e.id)?.kind}` :
      e.kind === "bin" ? `bin:${bins.find((b) => b.id === e.id)?.name}` : e.kind;
    const fontsBin = bins.find((b) => b.name === "fonts" && b.parentId === null);
    return {
      root: orderedEntriesForParent(p, null).map(label),
      fontsBin: fontsBin
        ? orderedEntriesForParent(p, fontsBin.id).map(label)
        : null,
      fontCount: p.assets.filter((a) => a.kind === "font").length,
    };
  });
}

// --- 3D Extrude で font を自動埋め込み ---
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

const fresh = await tree();

// --- 旧プロジェクト（ルート直下に ttf）を再現して読み込み移送を確認 ---
await page.evaluate(async () => {
  const store = (await import("/src/editor/store.ts")).useEditorStore;
  const { saveProject } = await import("/src/core/projectFs.ts");
  const s = store.getState();
  const p = s.project;
  const legacy = {
    ...p,
    bins: (p.bins ?? []).filter((b) => b.name !== "fonts"),
    assets: p.assets.map((a) => {
      if (a.kind !== "font") return a;
      const { binId: _drop, ...rest } = a;
      return rest;
    }),
    treeOrder: undefined,
  };
  await saveProject(s.getFs(), legacy);
});
const migrated = await tree();

// フォントが UI のフォント一覧に出続けるか（bin へ移しても family 参照が壊れない）
const fontListOk = await page.evaluate(async () => {
  const store = (await import("/src/editor/store.ts")).useEditorStore;
  const { is3DCapableFont } = await import("/src/editor/fontList.ts");
  return is3DCapableFont("Noto Sans", store.getState().project);
});

const report = { fresh, migrated, fontListOk, errors };
console.log(JSON.stringify(report, null, 2));

const ok =
  fresh.fontCount > 0 &&
  // 新規: ルートに font asset が直接並ばず、fonts フォルダに入る
  !fresh.root.includes("asset:font") &&
  fresh.root.includes("bin:fonts") &&
  fresh.fontsBin?.length === fresh.fontCount &&
  fresh.fontsBin.every((l) => l === "asset:font") &&
  // 旧プロジェクト: 読み込み時に移送される
  !migrated.root.includes("asset:font") &&
  migrated.root.includes("bin:fonts") &&
  migrated.fontsBin?.length === migrated.fontCount &&
  fontListOk &&
  errors.length === 0;

await browser.close();
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
