// 調整レイヤー（blur 25）の effect が export で焼けるかの parity 検証。
//
// 旧版は preview/export ともオフスクリーン DomRenderer + flushRasterEffects（forceAdjustmentRaster 無し）
// だったため同一経路同士の比較で常に diff=0、effect 欠落を検出できなかった。
// 本版は: preview = 実エディタの Preview パネル（live backdrop-filter）を screenshot、
//         export  = 実 exporter と同じ forceAdjustmentRaster:true + flushExportComposite のオフスクリーン経路。
// blur が効くと中央走査線に mid-luminance（ぼけ縁）ピクセルが現れる。export で mid≈0 なら effect 欠落=FAIL。
import { chromium } from "playwright";
import fs from "node:fs";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `http://localhost:${PORT}/`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForFunction(() => {
  const s = window.__mafterEditorStore;
  return s && s.getState().project && s.getState().currentCompId;
}, { timeout: 30000 });
await page.waitForTimeout(400);

// ── 合成シーンを実エディタに構築（白ソリッド + blur 調整レイヤー） ────────────────────────────
const built = await page.evaluate(async () => {
  const store = window.__mafterEditorStore;
  const S = () => store.getState();
  const sp = (v) => ({ value: v, keyframes: [] });
  const v3 = (x, y) => ({ x, y, z: 0 });
  const comp0 = S().project.compositions.find((k) => k.kind === "timeline");
  const W = comp0.width, H = comp0.height;

  function findComp(id) {
    return S().project.compositions.find((k) => k.kind === "timeline" && k.objects.some((o) => o.id === id));
  }
  function setProps(id, mut) {
    const obj = findComp(id).objects.find((o) => o.id === id);
    S().updateObject(id, mut(obj), "setup");
  }
  function patchFx(id, fxId, props) {
    const obj = findComp(id).objects.find((o) => o.id === id);
    const fx = obj.effects.find((e) => e.id === fxId);
    const p = {};
    for (const [k, val] of Object.entries(props)) p[k] = typeof val === "string" ? val : sp(val);
    return { ...fx, props: p };
  }

  const belowId = S().addSolid("below");
  setProps(belowId, (obj) => ({
    transform: { ...obj.transform, position: sp(v3(W / 2 - 150, H / 2 - 150)) },
    components: obj.components.map((c) => c.type === "solid"
      ? { ...c, props: { ...c.props, color: sp({ r: 1, g: 1, b: 1, a: 1 }), size: sp(v3(300, 300)) } } : c),
    effects: [],
  }));

  const adjId = S().addAdjustmentLayer("adjBlur");
  const adjFx = S().addEffect(adjId, "blur");
  setProps(adjId, (obj) => ({ effects: [patchFx(adjId, adjFx, { blurriness: 25 })] }));

  S().setFrame(0);
  await new Promise((r) => setTimeout(r, 800));
  return { W, H, compId: findComp(belowId).id };
}, []);

const { W, H, compId } = built;

function edgeSoftness(data, w, h) {
  const cy = Math.round(h / 2);
  let mid = 0, firstWhite = -1, lastWhite = -1;
  for (let x = 0; x < w; x++) {
    const i = (cy * w + x) * 4;
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (lum > 40 && lum < 215) mid++;
    if (lum > 128) { if (firstWhite < 0) firstWhite = x; lastWhite = x; }
  }
  return { mid, width: lastWhite - firstWhite + 1 };
}

// ── preview: 実 Preview パネルを screenshot（live backdrop-filter） ──────────────────────────
await page.waitForTimeout(300);
const pbox = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="preview-canvas-root"]');
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
});
const previewPng = await page.screenshot({
  clip: { x: pbox.x, y: pbox.y, width: Math.max(1, pbox.width), height: Math.max(1, pbox.height) },
});
const prevEdge = await page.evaluate(async ({ b64, W, H }) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `data:image/png;base64,${b64}`; });
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const cx = c.getContext("2d"); cx.drawImage(img, 0, 0, W, H);
  const data = cx.getImageData(0, 0, W, H).data;
  const cy = Math.round(H / 2); let mid = 0;
  for (let x = 0; x < W; x++) {
    const i = (cy * W + x) * 4;
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (lum > 40 && lum < 215) mid++;
  }
  return { mid };
}, { b64: previewPng.toString("base64"), W, H });

// ── export: 実 exporter と同じ forceAdjustmentRaster:true + flushExportComposite ─────────────
const report = await page.evaluate(async ({ compId, W, H }) => {
  const store = window.__mafterEditorStore;
  const S = () => store.getState();
  const comp = S().project.compositions.find((k) => k.id === compId);
  const { DomRenderer } = await import("/src/runtime/DomRenderer.ts");
  const { resolve } = await import("/src/runtime/resolve.ts");
  const { compositeExportFrame } = await import("/src/runtime/exportComposite.ts");

  const container = document.createElement("div");
  container.style.cssText = `position:fixed;left:-${W + 40}px;top:0;width:${W}px;height:${H}px;overflow:hidden;`;
  document.body.appendChild(container);
  const renderer = new DomRenderer();
  renderer.setPreviewRenderOptions({ exportCompositeMode: true });
  renderer.mount(container, comp);
  renderer.resize(W, H);
  renderer.renderFrame(resolve(comp, 0), 0);
  await renderer.flushRasterEffects();
  await new Promise((r) => setTimeout(r, 0));
  const expCanvas = await compositeExportFrame(renderer, W, H, W, H, "#000000");
  const expData = expCanvas.getContext("2d").getImageData(0, 0, W, H).data;
  const expUrl = expCanvas.toDataURL("image/png");
  document.body.removeChild(container);
  renderer.dispose();

  const cy = Math.round(H / 2); let mid = 0, firstWhite = -1, lastWhite = -1;
  for (let x = 0; x < W; x++) {
    const i = (cy * W + x) * 4;
    const lum = 0.299 * expData[i] + 0.587 * expData[i + 1] + 0.114 * expData[i + 2];
    if (lum > 40 && lum < 215) mid++;
    if (lum > 128) { if (firstWhite < 0) firstWhite = x; lastWhite = x; }
  }
  return { expEdge: { mid, width: lastWhite - firstWhite + 1 }, expUrl };
}, { compId, W, H });

fs.writeFileSync("verify-export-adjustment.png", Buffer.from(report.expUrl.split(",")[1], "base64"));

console.log("=== adjustment layer (blur 25) — 実 Preview vs export(bake) parity ===");
console.log(`comp ${W}x${H}`);
console.log(`preview center-line: mid=${prevEdge.mid}`);
console.log(`export  center-line: mid=${report.expEdge.mid}, white-width=${report.expEdge.width}`);
console.log("");

// 判定: export はネイティブ 1920 描画なので、blur なしなら 300px 白四角の中央走査線 mid≈0
// （硬い縁＝0/255 のみ）、blur(25) が焼ければ両縁に ~25px のぼけ縁が出て mid が数十〜百になる。
// よって「export mid が十分大きい」こと自体が effect 焼き込みの証拠（self-contained）。
// preview mid は fit-zoom スクショの縮小リサンプルで全体が滲み過大評価されるため判定には使わない（情報用）。
const ok = report.expEdge.mid > 30;
if (!ok) {
  console.log("FAIL — export で blur 調整 effect が欠落（中央走査線 mid≈0 = 硬い縁のまま）");
  process.exitCode = 1;
} else {
  console.log(`PASS — export(bake) に blur 調整 effect が焼けている（mid=${report.expEdge.mid} のぼけ縁）`);
}
console.log("=== errors:", errors.length ? errors : "none");

await browser.close();
