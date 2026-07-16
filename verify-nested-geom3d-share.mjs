// §5.5f-1 — geomShareCanvas がネスト comp（precomp）経路でも効くことの実機検証。
// 回帰内容: renderNestedComp が updateComponentEl へ canvas/isHost/clearedCanvases を渡さず、
// 共有指定を無視して per-layer 1 canvas を作っていた。3D text を十数枚積んだ comp を親から呼ぶと
// Chrome の同時 WebGL context 上限（~16）を超え、古い context から黙って破棄＝ちらつく。
//
// ゲートは「ネスト時の geom3d canvas 枚数」。共有が効けばグループは 1 枚に畳まれる。
// "Too many active WebGL contexts" 警告は GC 依存で出たり出なかったりするため合否条件にしない。
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5175";
const URL = `https://localhost:${PORT}/`;
// 実 pj（mafter-project (10) (1).zip）から巨大 media（mkv/wav）だけ除いた fixture。
// 3D text は fonts/project.json しか要らない＝媒体は検証に無関係。
const ZIP = process.env.VERIFY_ZIP ?? "C:/Users/resis/AppData/Local/Temp/claude/c--Workspace-mafter-effect/c7344427-946c-49e4-ae7d-f1139d158be3/scratchpad/trimmed.zip";

const CHILD = "2-もう一人じゃないよって";
// ユーザー報告の「親コンポ 9 秒あたりでちらつく」= main(15fps) frame 135。子レイヤーは in=84 なので
// 子 frame 51 — 3D text が 17 枚同時に生きる（>16 で Chrome の context 上限を超える）。
// 親は実 pj の main ではなく専用の Outer を作る: main は 3D text を持つ precomp を 2 つ
// （"1-ああゆらり-" と "2-…"）同時に載せるため canvas が 2 グループになるのが正しく、
// 「1 グループに畳まれたか」を測れない。グループは precomp 単位＝ここでは 1 つが期待値。
const CHILD_FRAME = 51;

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

const zipB64 = readFileSync(ZIP).toString("base64");
await page.evaluate(async (b64) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const { importZip } = await import("/src/fs/zip.ts");
  const store = window.__mafterEditorStore;
  await importZip(store.getState().getFs(), bin.buffer);
  await store.getState().loadFromFs();
}, zipB64);
await page.waitForTimeout(2000);

/** geom3d canvas の枚数と不透明ピクセル数（= 押し出された字面のインク量）。 */
async function measure() {
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

async function openComp(name) {
  return page.evaluate((n) => {
    const store = window.__mafterEditorStore;
    const c = store.getState().project.compositions.find((x) => x.name === n);
    store.getState().setCurrentComp(c.id);
    return c.id;
  }, name);
}

async function gotoFrame(frame, settleMs = 800) {
  await page.evaluate((f) => window.__mafterEditorStore.getState().setFrame(f), frame);
  await page.waitForTimeout(settleMs);
}

// --- A: 子 comp を単独で開く（基準。共有が効いていれば 1 枚に畳まれている） ---
const childId = await openComp(CHILD);
await gotoFrame(CHILD_FRAME);
const standalone = await measure();

// --- B: precomp として親から呼ぶ = ユーザー報告の経路 ---
// Outer の fps は子と違いうる（§23.2 は秒ベース換算）。同じ子 frame を指す親 frame へ直す＝
// でないとインク比較が「別フレーム同士」になり偽 FAIL する。
const parentFrame = await page.evaluate((id) => {
  const store = window.__mafterEditorStore;
  const child = store.getState().project.compositions.find((c) => c.id === id);
  const outerId = store.getState().addTimelineComp("Outer");
  store.getState().setCurrentComp(outerId);
  store.getState().addCompLayer(id);
  const outer = store.getState().project.compositions.find((c) => c.id === outerId);
  return { frame: Math.round((51 / child.fps) * outer.fps), childFps: child.fps, outerFps: outer.fps };
}, childId);
await gotoFrame(parentFrame.frame);
const nested = await measure();

// --- C: ちらつきの時間窓をスクラブ（context 上限超過は数十フレームかけて顕在化する） ---
for (let f = parentFrame.frame - 6; f <= parentFrame.frame + 24; f++) await gotoFrame(f, 120);
const afterScrub = await measure();

const report = { parentFrame, standalone, nested, afterScrub, glWarnings: glWarnings.slice(0, 5), errors: errors.slice(0, 5) };
console.log(JSON.stringify(report, null, 2));

const ratio = standalone.ink ? nested.ink / standalone.ink : 0;
const ok =
  standalone.ink > 100 &&
  // 共有が効いている＝グループは 1 枚（修正前はネストだけ十数枚に膨れる）
  standalone.canvases === 1 &&
  nested.canvases === standalone.canvases &&
  Math.abs(ratio - 1) < 0.1 &&
  // ちらつき窓をスクラブしても 3D が生き続ける（context を失っていない）
  afterScrub.canvases === standalone.canvases &&
  afterScrub.ink > 100 &&
  errors.length === 0;

await browser.close();
console.log(ok ? "PASS" : "FAIL", "nested canvases =", nested.canvases, "ink ratio =", ratio.toFixed(3));
process.exit(ok ? 0 : 1);
