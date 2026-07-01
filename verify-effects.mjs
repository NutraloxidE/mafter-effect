import { chromium } from "playwright";

// §27 effect routing — 現行アーキテクチャでは効果ごとに描画経路が分かれる:
//  - full displacement（wave/turbulentDisplace/ripple）と pixelSorter（previewBakeRequired）
//    は self-capture raster: 元コンテンツを visibility:hidden にし、entry.div に <canvas> を追加する。
//    entry.div 自身の CSS filter は「none」が正しい（ラスタ側で既に確定済み）。
//  - linearWipe/angularWipe/pixelSortLite は live SVG filter（entry.div.style.filter=url(#...)）。
//  - 調整レイヤー（pixelSortLiteAdj）は backdrop-filter を entry.div 自身に適用（isAdjustment は
//    entry.div の width/height をコンプ全面に明示設定するため、wrapper の box 自体が意味を持つ）。
// 旧版はいずれの場合も [data-object-id] の getBoundingClientRect/filter だけを見ており、
// 通常レイヤーは子要素が position:absolute（out-of-flow）のため wrapper が常に 0x0 に潰れ、
// full displacement / pixelSorter は raster 経路のため filter が常に "none" になる — これは
// 現行実装として正しい挙動であり、旧版の「効いていないように見える」誤読の原因だった。
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
await page.waitForTimeout(400);

const report = await page.evaluate(async () => {
  const store = (await import("/src/editor/store.ts")).useEditorStore;
  const S = () => store.getState();
  // 空 IDB → アプリ boot が loadFromFs→newProject で自動作成し preview をマウントする。
  for (let i = 0; i < 60 && !(S().project && S().currentCompId); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!S().project) throw new Error("project never loaded");
  const sp = (v) => ({ value: v, keyframes: [] });
  const v3 = (x, y) => ({ x, y, z: 0 });
  const out = [];

  function patchFx(objId, fxId, props) {
    const comp = S().project.compositions.find((k) => k.kind === "timeline" && k.objects.some((o) => o.id === objId));
    const obj = comp.objects.find((o) => o.id === objId);
    const fx = obj.effects.find((e) => e.id === fxId);
    const p = {};
    for (const [k, val] of Object.entries(props)) p[k] = typeof val === "string" ? val : sp(val);
    return { ...fx, props: p };
  }

  // "raster": full displacement / pixelSorter は self-capture canvas 経路。
  // "svgFilter": linearWipe/angularWipe/pixelSortLite は live CSS filter 経路。
  function textLayer(name, pos, text, type, fxProps, routing) {
    const id = S().addText(name);
    const fxId = S().addEffect(id, type);
    const comp = S().project.compositions.find((k) => k.kind === "timeline" && k.objects.some((o) => o.id === id));
    const obj = comp.objects.find((o) => o.id === id);
    const comps = obj.components.map((c) => c.type === "text"
      ? { ...c, props: { ...c.props, text: sp(text), size: sp(150), color: sp({ r: 0.6, g: 0.85, b: 1, a: 1 }), weight: 700 } }
      : c);
    S().updateObject(id, {
      transform: { ...obj.transform, position: sp(pos) },
      components: comps,
      effects: [patchFx(id, fxId, fxProps)],
    }, "setup");
    out.push({ name, id, routing });
  }

  function solidLayer(name, pos, color, type, fxProps, routing) {
    const id = S().addSolid(name);
    const fxId = type ? S().addEffect(id, type) : null;
    const comp = S().project.compositions.find((k) => k.kind === "timeline" && k.objects.some((o) => o.id === id));
    const obj = comp.objects.find((o) => o.id === id);
    const comps = obj.components.map((c) => c.type === "solid"
      ? { ...c, props: { ...c.props, color: sp(color), size: sp(v3(560, 360)) } }
      : c);
    S().updateObject(id, {
      transform: { ...obj.transform, position: sp(pos) },
      components: comps,
      effects: fxId ? [patchFx(id, fxId, fxProps)] : [],
    }, "setup");
    out.push({ name, id, routing });
  }

  function adjustmentLayerWithFx(name, type, fxProps, routing) {
    const id = S().addAdjustmentLayer(name);
    const fxId = S().addEffect(id, type);
    S().updateObject(id, {
      effects: [patchFx(id, fxId, fxProps)],
    }, "setup");
    out.push({ name, id, isAdjustment: true, routing });
  }

  // quadrants of 1920x1080
  textLayer("wave", v3(60, 120), "WAVE", "wave", { amplitude: 22, wavelength: 70, direction: "horizontal", phase: 30 }, "raster");
  textLayer("turbulent", v3(510, 120), "TURB", "turbulentDisplace", { amount: 40, size: 100, complexity: 2, evolution: 0, offsetX: 0, offsetY: 0, randomSeed: 0 }, "raster");
  textLayer("ripple", v3(1010, 120), "RIPPLE", "ripple", { amplitude: 26, radius: 300, frequency: 7, centerX: 0.5, centerY: 0.4 }, "raster");
  solidLayer("linearWipe", v3(60, 620), { r: 1, g: 0.5, b: 0.2, a: 1 }, "linearWipe", { completion: 0.5, angle: 0, feather: 12 }, "svgFilter");
  solidLayer("angularWipe", v3(1010, 620), { r: 0.3, g: 1, b: 0.5, a: 1 }, "angularWipe", { completion: 0.3, startAngle: 0, centerX: 0.5, centerY: 0.5, feather: 4 }, "svgFilter");
  solidLayer("pixelSorter", v3(960, 540), { r: 0.9, g: 0.4, b: 0.1, a: 1 }, "pixelSorter", { sortingMode: "simple", thresholdLow: 0.2, thresholdHigh: 0.85, angle: 45, length: 512, offset: 0, feather: 0, sortBlocks: 1 }, "raster");
  solidLayer("pixelSortLite", v3(960, 200), { r: 0.95, g: 0.55, b: 0.15, a: 1 }, "pixelSortLite", { angle: 90, threshold: 0.5, streakLength: 128, stripWidth: 1, intensity: 1, phase: 0 }, "svgFilter");
  solidLayer("gradA", v3(400, 900), { r: 1, g: 0.25, b: 0.1, a: 1 }, null, null, "plain");
  solidLayer("gradB", v3(1520, 900), { r: 0.15, g: 0.35, b: 1, a: 1 }, null, null, "plain");
  adjustmentLayerWithFx("pixelSortLiteAdj", "pixelSortLite", { angle: 90, threshold: 0.4, streakLength: 96, stripWidth: 4, intensity: 1, phase: 0 }, "backdrop");

  await new Promise((r) => setTimeout(r, 2500));
  for (const o of out) {
    const el = document.querySelector(`[data-object-id="${o.id}"]`);
    if (!el) { o.error = "element not found"; continue; }
    const cs = getComputedStyle(el);
    o.wrapperFilter = cs.filter;
    o.wrapperBackdrop = cs.backdropFilter;
    o.wrapperBox = `${el.offsetWidth}x${el.offsetHeight}`;

    // entry.div の子は「filter defs 用 <svg>（0x0）」+「実描画 component el」が両方入りうるため、
    // 面積最大の子を実描画要素とみなす（firstElementChild だと svg defs を拾ってしまう）。
    const widestChild = [...el.children]
      .map((c) => ({ c, r: c.getBoundingClientRect() }))
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];

    if (o.routing === "raster") {
      const canvas = el.querySelector("canvas");
      o.canvasSize = canvas ? `${canvas.width}x${canvas.height}` : null;
      o.pass = !!canvas && canvas.width > 0 && canvas.height > 0;
    } else if (o.routing === "svgFilter") {
      o.contentBox = widestChild ? `${Math.round(widestChild.r.width)}x${Math.round(widestChild.r.height)}` : null;
      o.pass = cs.filter.includes("url(") && !!widestChild && widestChild.r.width > 0;
    } else if (o.routing === "backdrop") {
      o.pass = cs.backdropFilter.includes("url(") && el.offsetWidth > 0 && el.offsetHeight > 0;
    } else {
      // plain: 効果無しの素の solid。子要素（実描画 box）で判定（wrapper は out-of-flow 子ゆえ 0x0 が正常）。
      o.contentBox = widestChild ? `${Math.round(widestChild.r.width)}x${Math.round(widestChild.r.height)}` : null;
      o.pass = cs.filter === "none" && !!widestChild && widestChild.r.width > 0;
    }
  }
  return { out, domCount: document.querySelectorAll("[data-object-id]").length };
}, []);

console.log("=== layers === domCount:", report.domCount, "port:", PORT);
let allPass = report.domCount === report.out.length;
for (const r of report.out) {
  const detail = r.routing === "raster" ? `canvas=${r.canvasSize}`
    : r.routing === "backdrop" ? `backdrop=${r.wrapperBackdrop} box=${r.wrapperBox}`
    : `filter=${r.wrapperFilter} contentBox=${r.contentBox}`;
  console.log(`[${r.name}] ${r.id} routing=${r.routing} ${detail} pass=${r.pass}`);
  if (!r.pass) allPass = false;
}
console.log("=== errors:", errors.length ? errors : "none");
if (errors.length) allPass = false;

await page.screenshot({ path: "verify-effects.png" });
console.log(allPass ? "PASS" : "FAIL");
if (!allPass) process.exitCode = 1;
await browser.close();
