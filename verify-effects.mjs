import { chromium } from "playwright";

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

  function textLayer(name, pos, text, type, fxProps) {
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
    out.push({ name, id });
  }

  function solidLayer(name, pos, color, type, fxProps) {
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
    out.push({ name, id });
  }

  function adjustmentLayerWithFx(name, type, fxProps) {
    const id = S().addAdjustmentLayer(name);
    const fxId = S().addEffect(id, type);
    S().updateObject(id, {
      effects: [patchFx(id, fxId, fxProps)],
    }, "setup");
    out.push({ name, id, isAdjustment: true });
  }

  // quadrants of 1920x1080
  textLayer("wave", v3(60, 120), "WAVE", "wave", { amplitude: 22, wavelength: 70, direction: "horizontal", phase: 30 });
  textLayer("turbulent", v3(510, 120), "TURB", "turbulentDisplace", { amount: 40, size: 100, complexity: 2, evolution: 0, offsetX: 0, offsetY: 0, randomSeed: 0 });
  textLayer("ripple", v3(1010, 120), "RIPPLE", "ripple", { amplitude: 26, radius: 300, frequency: 7, centerX: 0.5, centerY: 0.4 });
  solidLayer("linearWipe", v3(60, 620), { r: 1, g: 0.5, b: 0.2, a: 1 }, "linearWipe", { completion: 0.5, angle: 0, feather: 12 });
  solidLayer("angularWipe", v3(1010, 620), { r: 0.3, g: 1, b: 0.5, a: 1 }, "angularWipe", { completion: 0.3, startAngle: 0, centerX: 0.5, centerY: 0.5, feather: 4 });
  solidLayer("pixelSorter", v3(960, 540), { r: 0.9, g: 0.4, b: 0.1, a: 1 }, "pixelSorter", { sortingMode: "simple", thresholdLow: 0.2, thresholdHigh: 0.85, angle: 45, length: 512, offset: 0, feather: 0, sortBlocks: 1 });
  solidLayer("pixelSortLite", v3(960, 200), { r: 0.95, g: 0.55, b: 0.15, a: 1 }, "pixelSortLite", { angle: 90, threshold: 0.5, streakLength: 128, stripWidth: 1, intensity: 1, phase: 0 });
  solidLayer("gradA", v3(400, 900), { r: 1, g: 0.25, b: 0.1, a: 1 }, null, null);
  solidLayer("gradB", v3(1520, 900), { r: 0.15, g: 0.35, b: 1, a: 1 }, null, null);
  adjustmentLayerWithFx("pixelSortLiteAdj", "pixelSortLite", { angle: 90, threshold: 0.4, streakLength: 96, stripWidth: 4, intensity: 1, phase: 0 });

  await new Promise((r) => setTimeout(r, 2500));
  for (const o of out) {
    const el = document.querySelector(`[data-object-id="${o.id}"]`);
    const cs = el ? getComputedStyle(el) : null;
    o.filter = cs ? cs.filter : "(no el)";
    o.backdropFilter = cs ? cs.backdropFilter : "(no el)";
    o.box = el ? `${el.offsetWidth}x${el.offsetHeight}` : "-";
  }
  return { out, domCount: document.querySelectorAll("[data-object-id]").length };
}, []);

console.log("=== layers === domCount:", report.domCount, "port:", PORT);
for (const r of report.out) {
  const extra = r.isAdjustment ? ` backdrop=${r.backdropFilter}` : "";
  console.log(`[${r.name}] ${r.id} box=${r.box} filter=${r.filter}${extra}`);
}
console.log("=== errors:", errors.length ? errors : "none");

await page.screenshot({ path: "verify-effects.png" });
await browser.close();
