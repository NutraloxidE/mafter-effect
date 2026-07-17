// Regression: 非 matte レイヤーの inline z-index はフレームをまたいで保持されなければならない。
// applyObject の else 経路は毎フレーム clearMatteSourceStyle(div) を呼び zIndex="" にリセットする。
// zIndex 書込を last-value でキャッシュ（WP-4 初期実装）すると、2 フレーム目以降は z===lastZ で
// スキップされ zIndex が auto のまま戻らず、paint 順が壊れて調整レイヤーの backdrop-filter から
// 下位レイヤーが逃げる（3D-extrude text が調整の影響を受けない症状）。無条件書込なら保持される。
//
// 外部 zip 不要（store API で synthetic project を構築）。channel:chrome で実行。
import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5177";
const URL = `https://localhost:${PORT}/`;

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--ignore-certificate-errors"] });
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

const ids = await page.evaluate(() => {
  const s = window.__mafterEditorStore.getState();
  const compId = s.addTimelineComp("ZTest", { width: 320, height: 240, fps: 30, duration: 60 });
  s.setCurrentComp(compId);
  const lo = s.addSolid("Lo");
  s.updateObject(lo, { zOrder: 1 });
  const hi = s.addSolid("Hi");
  s.updateObject(hi, { zOrder: 2 });
  return { compId, lo, hi };
});

async function gotoFrame(f) {
  await page.evaluate((fr) => window.__mafterEditorStore.getState().setFrame(fr), f);
  await page.waitForTimeout(60);
}

// 複数フレームをスクラブ（clearMatteSourceStyle を毎フレーム走らせる）。
for (let f = 0; f <= 5; f++) await gotoFrame(f);

const z = await page.evaluate((ids) => {
  const pick = (oid) => {
    const el = document.querySelector(`[data-object-id="${oid}"]`);
    return el ? getComputedStyle(el).zIndex : "MISSING";
  };
  return { lo: pick(ids.lo), hi: pick(ids.hi) };
}, ids);

console.log(JSON.stringify(z));
await browser.close();

// zOrder 1/2 × BASE_Z(10) = 10 / 20。auto なら回帰。
const ok = z.lo === "10" && z.hi === "20";
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
