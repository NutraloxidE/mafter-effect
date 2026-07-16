// §23.3b / §5.5f — ネスト comp 内の 3D 押し出し text が「単独 comp と同じく 3D で描かれる」ことの実機検証。
// 回帰内容: renderNestedComp が updateComponentEl に geom3dCamera を渡していなかったため、
// precomp として呼ばれた瞬間 3D text が 2D フォールバックへ落ちていた（Main 単独では 3D）。
// 測定は GL canvas の実ピクセル（インク量）。3D が効いていれば canvas が存在しインクを持つ。
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5175";
const URL = `https://localhost:${PORT}/`;
const ZIP = process.env.VERIFY_ZIP ?? "C:/Users/resis/Downloads/mafter-pj-3Dtext-with-pixelstretch.zip";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
const errors = [];
const glWarnings = [];
page.on("console", (m) => {
  const t = m.text();
  if (/Too many active WebGL contexts|context.*lost/i.test(t)) glWarnings.push(t);
  if (m.type() === "error") errors.push(t);
});
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);

// ユーザーの実プロジェクト（3D text + pixelStretch + camera + adjustment）を取り込む。
// store は必ず window.__mafterEditorStore（アプリ本体のインスタンス）を使う。
// dynamic import した store は別 Zustand インスタンスになり、UI が一切追従しない。
const zipB64 = readFileSync(ZIP).toString("base64");
await page.evaluate(async (b64) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const { importZip } = await import("/src/fs/zip.ts");
  const store = window.__mafterEditorStore;
  await importZip(store.getState().getFs(), bin.buffer);
  await store.getState().loadFromFs();
}, zipB64);
await page.waitForTimeout(1500);

/** geom3d canvas の不透明ピクセル数 = 押し出された字面のインク量。 */
async function measureInk() {
  return page.evaluate(() => {
    const canvases = [...document.querySelectorAll("canvas.mafter-geom3d-canvas")];
    let ink = 0;
    for (const canvas of canvases) {
      if (!canvas.width || !canvas.height) continue;
      const off = document.createElement("canvas");
      off.width = canvas.width;
      off.height = canvas.height;
      const ctx = off.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      const { data } = ctx.getImageData(0, 0, off.width, off.height);
      for (let i = 3; i < data.length; i += 4) if (data[i] > 16) ink++;
    }
    return { canvases: canvases.length, ink };
  });
}

async function gotoFrame(frame, settleMs = 700) {
  await page.evaluate((f) => {
    window.__mafterEditorStore.getState().setFrame(f);
  }, frame);
  await page.waitForTimeout(settleMs);
}

// --- A: Main を単独で開いたときの 3D インク（基準） ---
const mainId = await page.evaluate(() => {
  const store = window.__mafterEditorStore;
  const main = store.getState().project.compositions.find((c) => c.name === "Main");
  store.getState().setCurrentComp(main.id);
  return main.id;
});
await gotoFrame(30);
const standalone = await measureInk();

// --- B: Main を別 comp のレイヤーとして呼び出したときの 3D インク ---
await page.evaluate((mainId) => {
  const store = window.__mafterEditorStore;
  const outerId = store.getState().addTimelineComp("Outer");
  store.getState().setCurrentComp(outerId);
  store.getState().addCompLayer(mainId);
}, mainId);
await gotoFrame(30);
const nested = await measureInk();

// --- C: スクラブしても canvas 実体が持ち越される（＝毎フレーム WebGL context を作らない） ---
// Chrome の同時 context 上限（~16）超過は "Too many active WebGL contexts" 警告で観測できるが、
// 検出は GC 任せで不安定。ここでは「canvas 要素の同一性が保たれるか」を直接見る（決定論的）。
await page.evaluate(() => {
  let n = 0;
  for (const c of document.querySelectorAll("canvas.mafter-geom3d-canvas")) c.__probeId = ++n;
});
for (let f = 31; f <= 80; f++) await gotoFrame(f, 120);
const afterScrub = await measureInk();
// 持ち越せていれば全 canvas が probeId を保持したまま。作り直していれば probeId 無しの新品になる。
const identity = await page.evaluate(() => {
  const cs = [...document.querySelectorAll("canvas.mafter-geom3d-canvas")];
  return { total: cs.length, kept: cs.filter((c) => c.__probeId !== undefined).length };
});

const report = {
  standalone,
  nested,
  afterScrub,
  identity,
  glWarnings: glWarnings.slice(0, 5),
  errors: errors.slice(0, 5),
};
console.log(JSON.stringify(report, null, 2));

const ratio = standalone.ink ? nested.ink / standalone.ink : 0;
const ok =
  standalone.ink > 100 &&
  // ネストしても 3D canvas が立ち、単独とおおむね同じインク量になる
  nested.canvases === standalone.canvases &&
  Math.abs(ratio - 1) < 0.1 &&
  // スクラブ後も 3D が生き続ける
  afterScrub.ink > 100 &&
  // canvas を毎フレーム作り直していない（＝WebGL context を毎フレーム生まない）
  identity.total > 0 &&
  identity.kept === identity.total &&
  errors.length === 0;

await browser.close();
console.log(ok ? "PASS" : "FAIL", "nested/standalone ink ratio =", ratio.toFixed(3));
process.exit(ok ? 0 : 1);
