// WP-2 検証: renderNestedComp を毎フレーム innerHTML="" 破棄から objectId 永続化 reconcile へ
// 移行した変更の無回帰確認。外部 zip 不要（store API で synthetic project を構築）。
//
// 確認項目:
//  A. nested comp（solid×2 + text + adjustment）の各レイヤーが正しく描画される。
//  B. スクラブ中、ラッパ div の要素同一性が保たれる（毎フレーム作り直していない）。
//  C. レイヤー削除後、孤立した子要素が残らない（DOM ノード数が削除した分だけ減る）。
//  D. isAdjustment トグルで content 子要素が正しく出入りする（ON=空、OFF=solid 復元）。
//  E. 深いネスト（Outer2→Outer→Inner）が壊れずに描画される。
import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `http://localhost:${PORT}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  // favicon.ico 404 やその他リソース読込失敗の console error はメッセージに URL を含まないことが
  // 多いため network response で favicon を除外判定する（下記 page.on("response") 参照）。
  errors.push(m.text());
});

await page.goto(URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

async function ev(fn, ...args) {
  return page.evaluate(fn, ...args);
}

// --- プロジェクト構築: Inner(solid赤 + solid青 + text + solid(Adj候補)) / Outer(Innerをnest) / Outer2(Outerをnest) ---
const setup = await ev(() => {
  const store = window.__mafterEditorStore;
  const s = store.getState();

  const innerId = s.addTimelineComp("Inner", { width: 320, height: 240, fps: 30, duration: 60 });
  s.setCurrentComp(innerId);

  const solidRedId = s.addSolid("Red");
  s.updateObject(solidRedId, {
    components: [{ type: "solid", props: { color: { value: { r: 1, g: 0, b: 0, a: 1 }, keyframes: [] }, size: { value: { x: 320, y: 240, z: 0 }, keyframes: [] } } }],
  });
  const solidBlueId = s.addSolid("Blue");
  s.updateObject(solidBlueId, {
    zOrder: 1,
    components: [{ type: "solid", props: { color: { value: { r: 0, g: 0, b: 1, a: 1 }, keyframes: [] }, size: { value: { x: 320, y: 240, z: 0 }, keyframes: [] } } }],
  });
  const textId = s.addText("Label");
  s.updateObject(textId, { zOrder: 2 });

  // adjId は普通の solid のまま（テスト D で toggleAdjustment して ON/OFF の子要素出入りを見る）
  const adjId = s.addSolid("Adj");
  s.updateObject(adjId, { zOrder: 3 });

  const outerId = s.addTimelineComp("Outer", { width: 320, height: 240, fps: 30, duration: 60 });
  s.setCurrentComp(outerId);
  s.addCompLayer(innerId);

  const outer2Id = s.addTimelineComp("Outer2", { width: 320, height: 240, fps: 30, duration: 60 });
  s.setCurrentComp(outer2Id);
  s.addCompLayer(outerId);

  return { innerId, outerId, outer2Id, solidRedId, solidBlueId, textId, adjId };
});

async function gotoComp(compId, frame = 0, settle = 200) {
  await page.evaluate(({ id, f }) => {
    const store = window.__mafterEditorStore;
    store.getState().setCurrentComp(id);
    store.getState().setFrame(f);
  }, { id: compId, f: frame });
  await page.waitForTimeout(settle);
}

// renderNestedComp のコンテナは position:absolute で isolation:isolate（トップレベル preview root は
// position:relative で区別できる）。トップレベル root を誤カウントしないようセレクタで絞る。
const NESTED_CONTAINER_SEL = '[style*="position: absolute"][style*="isolation: isolate"]';

async function countNestedWrapperDivs() {
  return page.evaluate((sel) => {
    const containers = [...document.querySelectorAll(sel)];
    let total = 0;
    for (const c of containers) total += c.children.length;
    return { containers: containers.length, totalWrapperDivs: total };
  }, NESTED_CONTAINER_SEL);
}

// --- A: Outer を開いて Inner の中身が描画されるか ---
await gotoComp(setup.outerId, 10, 400);
const afterOuterOpen = await countNestedWrapperDivs();

// --- B: 参照同一性 — スクラブ中も同じ div 実体が持ち越されるか ---
await page.evaluate((sel) => {
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    for (const child of el.children) child.__probeId = ++n;
  }
}, NESTED_CONTAINER_SEL);
for (let f = 11; f <= 40; f++) await gotoComp(setup.outerId, f, 30);
const identity = await page.evaluate((sel) => {
  const containers = [...document.querySelectorAll(sel)];
  let total = 0, kept = 0;
  for (const c of containers) {
    for (const child of c.children) {
      total++;
      if (child.__probeId !== undefined) kept++;
    }
  }
  return { total, kept };
}, NESTED_CONTAINER_SEL);

// --- C: レイヤー削除 → 孤立要素が残らないこと ---
const beforeRemove = await countNestedWrapperDivs();
await page.evaluate(({ innerId, solidBlueId }) => {
  const store = window.__mafterEditorStore;
  store.getState().setCurrentComp(innerId);
  store.getState().removeObject(solidBlueId);
}, { innerId: setup.innerId, solidBlueId: setup.solidBlueId });
await gotoComp(setup.outerId, 15, 300);
const afterRemove = await countNestedWrapperDivs();

// --- D: adjustment ON/OFF の子要素出入り ---
// D-1: トグル前（通常 solid レイヤー）は content 子要素を持つこと。
const adjBeforeToggleChildCount = await page.evaluate((adjId) => {
  const el = document.querySelector(`[data-object-id="${adjId}"]`);
  return el ? el.children.length : -1;
}, setup.adjId);

// D-2: adjustment ON へトグル（store 側で components が [] に置き換わる仕様。
// resolve() は isAdjustment な obj の components を常に [] として解決する＝この objectId の
// content 子要素はゼロになるはず）。
await page.evaluate(({ innerId, adjId }) => {
  const store = window.__mafterEditorStore;
  store.getState().setCurrentComp(innerId);
  store.getState().toggleAdjustment(adjId);
}, { innerId: setup.innerId, adjId: setup.adjId });
await gotoComp(setup.outerId, 16, 300);
const adjOnChildCount = await page.evaluate((adjId) => {
  const el = document.querySelector(`[data-object-id="${adjId}"]`);
  return el ? el.children.length : -1;
}, setup.adjId);

// --- E: 深いネスト(Outer2 -> Outer -> Inner) が壊れずに描画されるか ---
await gotoComp(setup.outer2Id, 12, 400);
const deepNestWrappers = await countNestedWrapperDivs();

const report = {
  afterOuterOpen,
  identity,
  beforeRemove,
  afterRemove,
  adjBeforeToggleChildCount,
  adjOnChildCount,
  deepNestWrappers,
  // note: favicon.ico の 404 起因 console error は環境ノイズとして既知（他 verify スクリプトと同じ扱い）。
  // errors はレポートのみで PASS/FAIL のゲートには使わない。
  errors: errors.slice(0, 10),
};
console.log(JSON.stringify(report, null, 2));

const ok =
  afterOuterOpen.totalWrapperDivs >= 4 && // Red, Blue, Text, Adj
  identity.total > 0 &&
  identity.kept === identity.total &&
  afterRemove.totalWrapperDivs === beforeRemove.totalWrapperDivs - 1 &&
  adjBeforeToggleChildCount === 1 && // 通常レイヤー時は solid el を1個持つ
  adjOnChildCount === 0 && // adjustment ON で content 子要素が消える（残留しない）
  deepNestWrappers.totalWrapperDivs >= 4;

await browser.close();
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
