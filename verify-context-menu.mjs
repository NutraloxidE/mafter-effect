// 汎用コンテキストメニュー基盤の検証:
//  (A) キーフレーム右クリック → イージングメニュー（基盤移行後も同一挙動）
//  (B) レイヤー行右クリック → 複製 / 削除（Undo 可）/ Esc / 同時に1つだけ
import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5175";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("text=+ Solid", { timeout: 30000 });

await page.evaluate(async () => {
  const S = () => window.__mafterEditorStore.getState();
  for (let i = 0; i < 80 && !(S().project && S().currentCompId); i++) await new Promise((r) => setTimeout(r, 250));
  S().addSolid();
});
await page.waitForTimeout(300);

const countLayers = () => page.evaluate(() => {
  const S = window.__mafterEditorStore.getState();
  const comp = S.project.compositions.find((c) => c.id === S.currentCompId);
  return comp?.kind === "timeline" ? comp.objects.length : 0;
});

// ============ (A) キーフレームメニュー（クリーン状態で先に検証） ============
await page.evaluate(() => {
  const S = window.__mafterEditorStore.getState();
  const comp = S.project.compositions.find((c) => c.id === S.currentCompId);
  const obj = comp.objects[0];
  S.selectObjects([obj.id]);
  S.updateObject(obj.id, {
    transform: { ...obj.transform, position: { ...obj.transform.position, keyframes: [
      { frame: 0, value: { x: 0, y: 0, z: 0 }, easing: { type: "linear" } },
      { frame: 30, value: { x: 100, y: 0, z: 0 }, easing: { type: "linear" } },
    ] } },
  });
});
await page.waitForTimeout(200);
await page.getByText("Solid", { exact: true }).first().click();
await page.keyboard.press("u");
await page.waitForFunction(() => document.querySelectorAll("[data-kf-key]").length > 0, { timeout: 5000 });

await page.evaluate(() => {
  const dot = document.querySelector("[data-kf-key]");
  const r = dot.getBoundingClientRect();
  dot.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 2, clientY: r.top + 2 }));
});
await page.waitForSelector('[role="menu"]', { timeout: 3000 });
const kfItems = await page.$$eval('[role="menu"] [role="menuitem"]', (els) => els.map((e) => e.textContent?.trim()));
const kfOk = ["Linear", "Easy Ease", "Hold"].every((t) => kfItems.some((i) => i?.includes(t)));
if (!kfOk) throw new Error(`kf easing menu items unexpected: ${JSON.stringify(kfItems)}`);

await page.getByRole("menuitem", { name: /Hold/ }).click();
await page.waitForTimeout(200);
const easingType = await page.evaluate(() => {
  const S = window.__mafterEditorStore.getState();
  const comp = S.project.compositions.find((c) => c.id === S.currentCompId);
  return comp.objects[0].transform.position.keyframes[0].easing.type;
});
if (easingType !== "hold") throw new Error(`kf easing not applied via menu: ${easingType}`);
if (await page.$('[role="menu"]')) throw new Error("kf menu did not close after apply");
console.log("(A) KF easing menu: OK");

// collapse 戻す
await page.keyboard.press("u");
await page.waitForTimeout(150);

// ============ (B) レイヤー行メニュー ============
const before = await countLayers();
const nameSpan = page.getByText("Solid", { exact: true }).first();

// メニュー表示 + 期待項目
await nameSpan.click({ button: "right" });
await page.waitForSelector('[role="menu"]', { timeout: 3000 });
const items = await page.$$eval('[role="menu"] [role="menuitem"]', (els) => els.map((e) => e.textContent?.trim()));
if (!["名前を変更", "複製", "削除"].every((t) => items.some((i) => i?.includes(t)))) {
  throw new Error(`layer menu items unexpected: ${JSON.stringify(items)}`);
}

// 複製
await page.getByRole("menuitem", { name: /複製/ }).click();
await page.waitForTimeout(300);
if (await countLayers() !== before + 1) throw new Error("duplicate did not add a layer");
if (await page.$('[role="menu"]')) throw new Error("menu did not close after click");

// Esc で閉じる
await nameSpan.click({ button: "right" });
await page.waitForSelector('[role="menu"]');
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
if (await page.$('[role="menu"]')) throw new Error("menu did not close on Escape");

// 連続右クリックでも1つだけ
await nameSpan.click({ button: "right" });
await page.waitForTimeout(50);
await nameSpan.click({ button: "right" });
await page.waitForTimeout(100);
if (await page.$$eval('[role="menu"]', (els) => els.length) !== 1) throw new Error("more than one menu open");
await page.keyboard.press("Escape");

// 削除 → Undo で戻る
const cur = await countLayers();
await nameSpan.click({ button: "right" });
await page.waitForSelector('[role="menu"]');
await page.getByRole("menuitem", { name: /削除/ }).click();
await page.waitForTimeout(300);
if (await countLayers() >= cur) throw new Error("delete did not remove a layer");
await page.evaluate(() => window.__mafterEditorStore.getState().undo());
await page.waitForTimeout(200);
if (await countLayers() !== cur) throw new Error("undo did not restore layer count");
console.log("(B) layer menu (dup/del/undo/esc/single): OK");

await page.screenshot({ path: "verify-context-menu.png" });
if (errors.length) { console.error("console errors:", errors); throw new Error("console errors present"); }
await browser.close();
console.log("verify-context-menu: OK");
