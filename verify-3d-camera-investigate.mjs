// Phase 1.1 検証: 3D 層は dolly(Z)/zoom で拡大縮小、2D 層はカメラ免除（不動・等倍）、既定カメラは等倍。
import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5179";
const URL = `http://localhost:${PORT}/`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(500);

const report = await page.evaluate(async () => {
  const store = (await import("/src/editor/store.ts")).useEditorStore;
  const S = () => store.getState();
  for (let i = 0; i < 60 && !(S().project && S().currentCompId); i++) await new Promise((r) => setTimeout(r, 250));
  if (!S().project) throw new Error("project never loaded");

  const sp = (v) => ({ value: v, keyframes: [] });
  const v3 = (x, y, z = 0) => ({ x, y, z });
  const out = { dolly: [], zoom: [] };
  const comp0 = S().project.compositions.find((k) => k.kind === "timeline");
  const W = comp0.width, H = comp0.height;

  const mkSolid = (name, threeD) => {
    const id = S().addSolid(name);
    const comp = S().project.compositions.find((k) => k.objects?.some((o) => o.id === id));
    const obj = comp.objects.find((o) => o.id === id);
    const comps = obj.components.map((c) => c.type === "solid"
      ? { ...c, props: { ...c.props, color: sp({ r: 1, g: 1, b: 1, a: 1 }), size: sp(v3(200, 200)) } } : c);
    const t = { ...obj.transform, position: sp(v3(W / 2 - 100, H / 2 - 100, 0)) };
    S().updateObject(id, { components: comps, transform: t, threeD: threeD ? true : undefined }, "probe");
    return id;
  };
  const id3 = mkSolid("probe3d", true);
  const id2 = mkSolid("probe2d", false);
  await new Promise((r) => setTimeout(r, 300));

  const unionRect = (root) => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    const scan = (el) => { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) { a = Math.min(a, r.left); b = Math.min(b, r.top); c = Math.max(c, r.right); d = Math.max(d, r.bottom); } for (const ch of el.children) scan(ch); };
    scan(root);
    return c <= a ? null : { x: (a + c) / 2, w: c - a };
  };
  const measure = (id) => { let best = null; for (const el of document.querySelectorAll(`[data-object-id="${id}"]`)) { const u = unionRect(el); if (u && (!best || u.w > best.w)) best = u; } return best ? Math.round(best.w * 10) / 10 : null; };

  // 基準: カメラ無し。
  out.Wref3 = measure(id3);
  out.Wref2 = measure(id2);

  const camId = S().addCamera();
  const compNow = () => S().project.compositions.find((k) => k.id === comp0.id);
  const defZoom = (() => { const cam = compNow().objects.find((o) => o.id === camId); return cam.components.find((c) => c.type === "camera").props.zoom.value; })();
  out.defZoom = Math.round(defZoom);
  await new Promise((r) => setTimeout(r, 300));
  out.default3 = measure(id3);
  out.default2 = measure(id2);

  const setCamZ = (z) => { const cam = compNow().objects.find((o) => o.id === camId); S().updateObject(camId, { transform: { ...cam.transform, position: sp(v3(W / 2, H / 2, z)) } }, "z"); };
  const setZoom = (zoom) => { const cam = compNow().objects.find((o) => o.id === camId); const comps = cam.components.map((c) => c.type === "camera" ? { ...c, props: { ...c.props, zoom: sp(zoom) } } : c); S().updateObject(camId, { components: comps }, "zoom"); };

  setZoom(defZoom);
  for (const f of [0.5, 1, 2]) { setCamZ(defZoom * f); await new Promise((r) => setTimeout(r, 250)); out.dolly.push({ camZ: Math.round(defZoom * f), w3: measure(id3), w2: measure(id2) }); }
  setCamZ(defZoom);
  for (const f of [0.5, 1, 2]) { setZoom(defZoom * f); await new Promise((r) => setTimeout(r, 250)); out.zoom.push({ zoom: Math.round(defZoom * f), w3: measure(id3), w2: measure(id2) }); }
  return out;
});

await page.screenshot({ path: "verify-3d-camera-investigate.png" });
await browser.close();
console.log(JSON.stringify(report, null, 2));
console.log("console errors:", errors.length ? errors : "none");

// 判定
const r = report;
const dollyNear = r.dolly.find((d) => d.camZ === Math.round(r.defZoom * 0.5)).w3;
const dollyFar = r.dolly.find((d) => d.camZ === Math.round(r.defZoom * 2)).w3;
const zoomTele = r.zoom.find((z) => z.zoom === Math.round(r.defZoom * 2)).w3;
const zoomWide = r.zoom.find((z) => z.zoom === Math.round(r.defZoom * 0.5)).w3;
const near = (a, b, tol = 0.08) => Math.abs(a - b) / b <= tol;
const checks = {
  defaultNeutral3: near(r.default3, r.Wref3),                 // 既定カメラは 3D 等倍
  dollyInBigger: dollyNear > r.default3 * 1.2,                // 近づくと拡大
  dollyOutSmaller: dollyFar < r.default3 * 0.85,              // 遠のくと縮小
  zoomTeleBigger: zoomTele > r.default3 * 1.2,                // 望遠で拡大
  zoomWideSmaller: zoomWide < r.default3 * 0.85,              // 広角で縮小
  twoDExempt: near(r.default2, r.Wref2) && r.dolly.every((d) => near(d.w2, r.Wref2)) && r.zoom.every((z) => near(z.w2, r.Wref2)),
  noErrors: errors.length === 0,
};
console.log("checks:", JSON.stringify(checks, null, 2));
const ok = Object.values(checks).every(Boolean);
console.log(ok ? "\nPASS ✅" : "\nFAIL ❌");
process.exit(ok ? 0 : 1);
