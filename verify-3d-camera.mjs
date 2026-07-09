// Phase 1 検証（§5.4b / §6.5b）: カメラ builtin・two-node・2D 層のカメラ免除・3D 層のカメラ応答。
// 問い: アクティブカメラを移動したとき、2D 層は画面上で不動（免除）、3D 層は動く（応答）か。
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
await page.waitForTimeout(500);

const report = await page.evaluate(async () => {
  const store = (await import("/src/editor/store.ts")).useEditorStore;
  const { resolve } = await import("/src/runtime/resolve.ts");
  const { globalPluginRegistry } = await import("/src/runtime/pluginRegistry.ts");
  const S = () => store.getState();
  for (let i = 0; i < 60 && !(S().project && S().currentCompId); i++) await new Promise((r) => setTimeout(r, 250));
  if (!S().project) throw new Error("project never loaded");

  const sp = (v) => ({ value: v, keyframes: [] });
  const v3 = (x, y, z = 0) => ({ x, y, z });
  const out = {};

  out.cameraRegistered = !!globalPluginRegistry.getComponentDef("camera");

  const comp0 = S().project.compositions.find((k) => k.kind === "timeline");
  const W = comp0.width, H = comp0.height;

  // 2D solid（中央）と 3D solid（中央, Y回転で奥行きを可視化）。
  const id2d = S().addSolid("flat2d");
  const id3d = S().addSolid("deep3d");
  const setSolid = (id, pos, threeD, rotY) => {
    const comp = S().project.compositions.find((k) => k.objects?.some((o) => o.id === id));
    const obj = comp.objects.find((o) => o.id === id);
    const comps = obj.components.map((c) => c.type === "solid"
      ? { ...c, props: { ...c.props, color: sp({ r: 1, g: 1, b: 1, a: 1 }), size: sp(v3(200, 200)) } } : c);
    const t = { ...obj.transform, position: sp(pos), rotation: sp(v3(0, rotY, 0)) };
    S().updateObject(id, { components: comps, transform: t, threeD: threeD ? true : undefined }, "setup");
  };
  setSolid(id2d, v3(W / 2 - 100, H / 2 - 100, 0), false, 0);
  setSolid(id3d, v3(W / 2 - 100, H / 2 - 100, 0), true, 35);

  // カメラ追加（two-node, 中央注視）。
  const camId = S().addCamera();
  out.activeCameraSet = S().project.compositions.find((k) => k.id === comp0.id).activeCamera === camId;

  // resolve で scene.camera を確認。
  const compNow = () => S().project.compositions.find((k) => k.id === comp0.id);
  const scene0 = resolve(compNow(), 0);
  out.sceneHasCamera = !!scene0.camera;
  out.fov = scene0.camera ? Math.round(scene0.camera.fov * 10) / 10 : null;
  const r3d0 = scene0.objects.find((o) => o.id === id3d);
  const r2d0 = scene0.objects.find((o) => o.id === id2d);
  out.threeDFlag = { d3: r3d0?.threeD === true, mode: r3d0?.mode3d, d2: r2d0?.threeD };

  await new Promise((r) => setTimeout(r, 400));
  out.totalObjDivs = document.querySelectorAll("[data-object-id]").length;
  // 子（solid content）が absolute の場合 object div の box は 0 になるため、子孫の union を測る。
  const unionRect = (root) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const scan = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { minX = Math.min(minX, r.left); minY = Math.min(minY, r.top); maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom); }
      for (const c of el.children) scan(c);
    };
    scan(root);
    if (maxX <= minX) return null;
    return { x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2), w: Math.round(maxX - minX), h: Math.round(maxY - minY) };
  };
  const rect = (id) => {
    const els = [...document.querySelectorAll(`[data-object-id="${id}"]`)];
    let best = null;
    for (const el of els) {
      const u = unionRect(el);
      if (u && (!best || u.w * u.h > best.w * best.h)) best = u;
    }
    return best;
  };
  const before = { d2: rect(id2d), d3: rect(id3d) };

  // カメラを右へ 400px パン（POI は中央のまま → 3D は応答、2D は免除）。
  const cam = compNow().objects.find((o) => o.id === camId);
  const camPos = cam.transform.position.value;
  S().updateObject(camId, { transform: { ...cam.transform, position: sp(v3(camPos.x + 400, camPos.y, camPos.z)) } }, "pan camera");
  await new Promise((r) => setTimeout(r, 300));
  const after = { d2: rect(id2d), d3: rect(id3d) };

  out.before = before; out.after = after;
  // §6.5b: 3D 層はカメラパンに応答、2D 層は免除（不動）。退化描画（巨大 rect）が無いこと。
  const sane = (r) => r && r.w > 1 && r.w < 5000 && r.h < 5000 && Math.abs(r.x) < 20000 && Math.abs(r.y) < 20000;
  const dx2d = before.d2 && after.d2 ? Math.abs(after.d2.x - before.d2.x) : null;
  const dx3d = before.d3 && after.d3 ? Math.abs(after.d3.x - before.d3.x) : null;
  out.dx2d = dx2d; out.dx3d = dx3d;
  out.noDegenerate = sane(before.d2) && sane(before.d3) && sane(after.d2) && sane(after.d3);
  out.threeDPans = dx3d !== null && dx3d >= 10;     // 3D 応答
  out.twoDExempt = dx2d !== null && dx2d <= 2;       // 2D 免除（不動）
  return out;
});

await page.screenshot({ path: "verify-3d-camera.png" });
await browser.close();

console.log(JSON.stringify(report, null, 2));
console.log("console errors:", errors.length ? errors : "none");
const ok = report.cameraRegistered && report.sceneHasCamera &&
  report.fov === 50 && report.threeDFlag.d3 && report.threeDFlag.mode === "dom" && !report.threeDFlag.d2 &&
  report.noDegenerate && report.threeDPans && report.twoDExempt && errors.length === 0;
console.log(ok ? "\nPASS ✅" : "\nFAIL ❌");
process.exit(ok ? 0 : 1);
