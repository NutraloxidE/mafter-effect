// §27.12 改定3 — Fast* を raster 無し live CSS filter 化した後の export-parity 検証。
// 問い: live `filter: url(#fx)`（feImage/feDisplacementMap）が export の foreignObject
// 経路（captureElementToCanvas）でも適用されるか? = preview だけでなく export でも変位が出るか。
// 既存 live SVG 効果（linearWipe/pixelSortLite）が同経路で通る前提だが回帰防止で固定する。

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

const report = await page.evaluate(async () => {
  const store = window.__mafterEditorStore;
  const S = () => store.getState();
  if (!S().project) throw new Error("project never loaded");

  const sp = (v) => ({ value: v, keyframes: [] });
  const v3 = (x, y) => ({ x, y, z: 0 });

  const comp0 = S().project.compositions.find((k) => k.kind === "timeline");
  const W = comp0.width, H = comp0.height;
  const SZ = 180;
  // 6 slots (top-left origin). centroid は slot 中心 (pos + SZ/2) 基準で測る。
  const slots = {
    baseline:      v3(Math.round(W * 0.20 - SZ / 2), Math.round(H * 0.30 - SZ / 2)),
    fastWave:      v3(Math.round(W * 0.50 - SZ / 2), Math.round(H * 0.30 - SZ / 2)),
    fastRipple:    v3(Math.round(W * 0.80 - SZ / 2), Math.round(H * 0.30 - SZ / 2)),
    fastTurbulent: v3(Math.round(W * 0.20 - SZ / 2), Math.round(H * 0.70 - SZ / 2)),
    waveFull:      v3(Math.round(W * 0.50 - SZ / 2), Math.round(H * 0.70 - SZ / 2)),
    tint:          v3(Math.round(W * 0.80 - SZ / 2), Math.round(H * 0.70 - SZ / 2)),
  };

  function mkSolid(name, pos, type, fxProps) {
    const id = S().addSolid(name);
    const fxId = type ? S().addEffect(id, type) : null;
    const comp = S().project.compositions.find((k) => k.kind === "timeline" && k.objects.some((o) => o.id === id));
    const obj = comp.objects.find((o) => o.id === id);
    const comps = obj.components.map((c) => c.type === "solid"
      ? { ...c, props: { ...c.props, color: sp({ r: 1, g: 1, b: 1, a: 1 }), size: sp(v3(SZ, SZ)) } }
      : c);
    let effects = [];
    if (fxId) {
      const fx = obj.effects.find((e) => e.id === fxId);
      const p = {};
      for (const [k, val] of Object.entries(fxProps)) p[k] = typeof val === "string" ? val : sp(val);
      effects = [{ ...fx, props: p }];
    }
    S().updateObject(id, {
      transform: { ...obj.transform, position: sp(pos) },
      components: comps,
      effects,
    }, "setup");
    return id;
  }

  mkSolid("baseline", slots.baseline, null, null);
  mkSolid("fastWave", slots.fastWave, "fastWave", { amplitude: 40, wavelength: 40, direction: "horizontal", phase: 0, antiAlias: false });
  // radius は矩形の半対角(≈127px)を十分越える 220 にし、右端(中心から90px)で振幅が残るようにする
  // （ripple は env=1-dist/radius でちょうど radius で振幅0。solid 内部は均一なのでエッジでしか変位が見えない）。
  mkSolid("fastRipple", slots.fastRipple, "fastRipple", { radius: 220, amplitude: 40, frequency: 6, centerX: 0.5, centerY: 0.5, antiAlias: false });
  mkSolid("fastTurbulent", slots.fastTurbulent, "fastTurbulentDisplace", { amount: 60, size: 60, complexity: 2, evolution: 0, offsetX: 0, offsetY: 0, randomSeed: 7, antiAlias: false });
  mkSolid("waveFull", slots.waveFull, "wave", { amplitude: 40, wavelength: 40, direction: "horizontal", phase: 0 });
  mkSolid("tint", slots.tint, "tint", { mapBlack: { r: 0, g: 0, b: 0, a: 1 }, mapWhite: { r: 1, g: 0, b: 0, a: 1 }, amount: 1 });

  await new Promise((r) => setTimeout(r, 800));

  // ── EXPORT path: offscreen DomRenderer + captureElementToCanvas (foreignObject) ──
  const { DomRenderer } = await import("/src/runtime/DomRenderer.ts");
  const { resolve } = await import("/src/runtime/resolve.ts");
  const { captureElementToCanvas } = await import("/src/runtime/rasterCapture.ts");

  const comp = S().project.compositions.find((k) => k.kind === "timeline");
  const container = document.createElement("div");
  container.style.cssText = `position:fixed;left:-${W + 40}px;top:0;width:${W}px;height:${H}px;overflow:hidden;`;
  document.body.appendChild(container);

  const renderer = new DomRenderer();
  renderer.mount(container, comp);
  renderer.resize(comp.width, comp.height);
  renderer.renderFrame(resolve(comp, 0), 0);
  await renderer.flushRasterEffects();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  const canvas = await captureElementToCanvas(renderer.getRoot(), W, H, "#000000");
  const cx = canvas.getContext("2d");
  const img = cx.getImageData(0, 0, W, H).data;

  function analyzeRegion(pos) {
    const M = 70;
    const x0 = Math.max(0, pos.x - M), y0 = Math.max(0, pos.y - M);
    const x1 = Math.min(W, pos.x + SZ + M), y1 = Math.min(H, pos.y + SZ + M);
    let ink = 0, sr = 0, sg = 0, sb = 0, cxSum = 0, cySum = 0;
    let minX = W, maxX = 0, minY = H, maxY = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        const r = img[i], g = img[i + 1], b = img[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum > 16) {
          ink++; sr += r; sg += g; sb += b; cxSum += x; cySum += y;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    const avg = ink ? { r: Math.round(sr / ink), g: Math.round(sg / ink), b: Math.round(sb / ink) } : { r: 0, g: 0, b: 0 };
    // ink centroid を slot 中心 (pos + SZ/2) からのドリフトに換算。
    const centerX = pos.x + SZ / 2, centerY = pos.y + SZ / 2;
    const drift = ink ? Math.hypot(cxSum / ink - centerX, cySum / ink - centerY) : 0;
    // 右端 x の行ごとの std = 縦エッジの変位量（distortion が効いている証拠）。
    const rightEdges = [];
    for (let y = y0; y < y1; y++) {
      let rx = -1;
      for (let x = x1 - 1; x >= x0; x--) {
        const i = (y * W + x) * 4;
        const lum = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
        if (lum > 16) { rx = x; break; }
      }
      if (rx >= 0) rightEdges.push(rx);
    }
    let edgeStd = 0;
    if (rightEdges.length > 1) {
      const m = rightEdges.reduce((a, b) => a + b, 0) / rightEdges.length;
      edgeStd = Math.sqrt(rightEdges.reduce((a, b) => a + (b - m) ** 2, 0) / rightEdges.length);
    }
    return {
      ink, avg,
      edgeStd: Math.round(edgeStd * 100) / 100,
      drift: Math.round(drift * 100) / 100,
      bbox: ink ? { w: maxX - minX + 1, h: maxY - minY + 1 } : { w: 0, h: 0 },
    };
  }

  const regions = {};
  for (const [k, pos] of Object.entries(slots)) regions[k] = analyzeRegion(pos);

  const dataUrl = canvas.toDataURL("image/png");
  document.body.removeChild(container);
  renderer.dispose();
  return { W, H, SZ, regions, dataUrl };
}, []);

const b64 = report.dataUrl.split(",")[1];
fs.writeFileSync("verify-fast-export-parity.png", Buffer.from(b64, "base64"));

const R = report.regions;
const base = R.baseline;
const fmt = (o) => `ink=${o.ink} edgeStd=${o.edgeStd} drift=${o.drift}px bbox=${o.bbox.w}x${o.bbox.h} avg=rgb(${o.avg.r},${o.avg.g},${o.avg.b})`;
console.log(`=== export foreignObject capture — comp ${report.W}x${report.H}, solid ${report.SZ}px ===`);
console.log(`[baseline     ] ${fmt(R.baseline)}`);
console.log(`[fastWave live] ${fmt(R.fastWave)}`);
console.log(`[fastRipple lv] ${fmt(R.fastRipple)}`);
console.log(`[fastTurb live] ${fmt(R.fastTurbulent)}`);
console.log(`[wave full ras] ${fmt(R.waveFull)}`);
console.log(`[tint SVG url ] ${fmt(R.tint)}`);
console.log("");
console.log("=== verdict (live fast* が export foreignObject で変位を出すか) ===");
const distorts = (o) => o.edgeStd > base.edgeStd + 2;
const v = {
  fastWave: distorts(R.fastWave),
  fastRipple: distorts(R.fastRipple),
  fastTurbulent: distorts(R.fastTurbulent),
  waveFull: distorts(R.waveFull),
  tint: R.tint.avg.r > 120 && R.tint.avg.g < 80,
};
console.log(`fastWave  (live filter)   in export: ${v.fastWave ? "WORKS" : "MISSING"}  drift=${R.fastWave.drift}px`);
console.log(`fastRipple(live filter)   in export: ${v.fastRipple ? "WORKS" : "MISSING"}  drift=${R.fastRipple.drift}px`);
console.log(`fastTurb  (live filter)   in export: ${v.fastTurbulent ? "WORKS" : "MISSING"}  drift=${R.fastTurbulent.drift}px`);
console.log(`wave full (raster)        in export: ${v.waveFull ? "WORKS" : "MISSING"}  (regression control)`);
console.log(`tint      (SVG url ctrl)  in export: ${v.tint ? "WORKS" : "MISSING"}`);
console.log("=== errors:", errors.length ? errors : "none");

await browser.close();
const allFast = v.fastWave && v.fastRipple && v.fastTurbulent;
process.exit(allFast ? 0 : 1);
