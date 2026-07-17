// 調査(pixel計測 v3): 上位 live 調整(tint backdrop-filter)が各レイヤー領域に効くかを、
// stage 全体を adj ON/OFF で撮って comp 座標にマップした領域ごとの mean-abs 差で判定する。
// layer div が 0×0（solid/nested の実体は子要素）でも座標指定で計測できる。

import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5173";
const APP_URL = `https://localhost:${PORT}/`;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, ignoreHTTPSErrors: true });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(APP_URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);
const ev = (fn, arg) => page.evaluate(fn, arg);

// レイヤーの comp 座標中心（W=640,H=360）
const CENTERS = { s2d: [90, 180], t3d: [250, 180], n2d: [400, 180], n3d: [540, 180] };

const built = await ev(() => {
  const s = window.__mafterEditorStore.getState();
  const W = 640, H = 360, DUR = 90;
  const setPos = (id, x, y) => {
    const st = window.__mafterEditorStore.getState();
    const comp = st.project.compositions.find((c) => c.id === st.currentCompId);
    const o = comp.objects.find((oo) => oo.id === id);
    st.updateObject(id, { transform: { ...o.transform, position: { value: { x, y, z: 0 }, keyframes: [] } } });
  };
  const solid = (name, color, size, z) => {
    const id = s.addSolid(name);
    s.updateObject(id, { zOrder: z, components: [{ type: "solid", props: { color: { value: color, keyframes: [] }, size: { value: size, keyframes: [] } } }] });
    return id;
  };
  const inner2d = s.addTimelineComp("FX2D", { width: 160, height: 160, fps: 30, duration: DUR });
  s.setCurrentComp(inner2d);
  solid("i2", { r: 0.9, g: 0.9, b: 0.9, a: 1 }, { x: 160, y: 160, z: 0 }, 0);
  const inner3d = s.addTimelineComp("FX3D", { width: 160, height: 160, fps: 30, duration: DUR });
  s.setCurrentComp(inner3d);
  const it = s.addText("Tin"); s.updateObject(it, { zOrder: 0 }); if (s.setThreeD) s.setThreeD(it, true);

  const mainId = s.addTimelineComp("main 1", { width: W, height: H, fps: 30, duration: DUR });
  s.setCurrentComp(mainId);
  solid("BG", { r: 0.05, g: 0.05, b: 0.08, a: 1 }, { x: W, y: H, z: 0 }, 0);
  const s2d = solid("S2D", { r: 0.95, g: 0.9, b: 0.2, a: 1 }, { x: 130, y: 200, z: 0 }, 1); setPos(s2d, 90, 180);
  const t3d = s.addText("T3D"); s.updateObject(t3d, { zOrder: 1 }); if (s.setThreeD) s.setThreeD(t3d, true); setPos(t3d, 250, 180);
  const n2d = s.addCompLayer(inner2d, "N2D"); s.updateObject(n2d, { zOrder: 1 }); setPos(n2d, 400, 180);
  const n3d = s.addCompLayer(inner3d, "N3D"); s.updateObject(n3d, { zOrder: 1 }); setPos(n3d, 540, 180);
  const adj = (s.addRasterAdjustmentLayer ? s.addRasterAdjustmentLayer("Adj") : s.addAdjustmentLayer("Adj"));
  s.updateObject(adj, { zOrder: 2 });
  const fxId = s.addEffect(adj, "tint");
  s.setCurrentComp(mainId); s.setFrame(0);
  return { mainId, adj, fxId, W, H };
});
await ev((a) => window.__mafterEditorStore.getState().setFrame(a.f), { f: 45 });
await page.waitForTimeout(400);

const adjRect = await ev((ids) => {
  const el = document.querySelector(`[data-object-id="${ids.adj}"]`);
  const b = el.getBoundingClientRect();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}, built);
console.log("adjRect(=stage):", JSON.stringify(adjRect), "scale=", (adjRect.w / built.W).toFixed(3));

async function setAdj(on) {
  await ev((a) => {
    const s = window.__mafterEditorStore.getState();
    const comp = s.project.compositions.find((c) => c.id === a.mainId);
    const fx = comp.objects.find((o) => o.id === a.adj)?.effects?.find((e) => e.id === a.fxId);
    if (fx && fx.enabled !== a.on) s.toggleEffect(a.adj, a.fxId);
  }, { mainId: built.mainId, adj: built.adj, fxId: built.fxId, on });
  await page.waitForTimeout(300);
}

async function stageShot() {
  const clip = { x: Math.max(0, adjRect.x), y: Math.max(0, adjRect.y), width: adjRect.w, height: adjRect.h };
  const buf = await page.screenshot({ clip });
  return "data:image/png;base64," + buf.toString("base64");
}

await setAdj(true); const onImg = await stageShot();
await setAdj(false); const offImg = await stageShot();

// 2枚を page 内で decode して領域ごとの mean-abs 差を計算
const diffs = await ev(async (a) => {
  const dec = async (url) => {
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    const cv = document.createElement("canvas"); cv.width = bmp.width; cv.height = bmp.height;
    const g = cv.getContext("2d"); g.drawImage(bmp, 0, 0);
    return { data: g.getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height };
  };
  const A = await dec(a.onImg), B = await dec(a.offImg);
  const scale = A.w / a.W; // screenshot は stage をそのまま
  const region = (cx, cy) => {
    const px = Math.round(cx * scale), py = Math.round(cy * scale), R = 18;
    let sum = 0, n = 0;
    for (let y = py - R; y < py + R; y++) for (let x = px - R; x < px + R; x++) {
      if (x < 0 || y < 0 || x >= A.w || y >= A.h) continue;
      const i = (y * A.w + x) * 4;
      sum += Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]);
      n += 3;
    }
    return n ? +(sum / n).toFixed(2) : -1;
  };
  const out = {};
  for (const [k, c] of Object.entries(a.centers)) out[k] = region(c[0], c[1]);
  return out;
}, { onImg, offImg, W: built.W, centers: CENTERS });

console.log("\nlayer  meanAbsDiff(adjON vs OFF)  affected?");
for (const [k, d] of Object.entries(diffs)) {
  const aff = d < 0 ? "N/A" : d > 4 ? "YES(効く)" : "NO(逃げ)";
  console.log(`${k.padEnd(6)} ${String(d).padEnd(10)}  ${aff}`);
}
console.log("\npageErrors:", errs.length, errs.slice(0, 3));
await browser.close();
const escaping = Object.entries(diffs).filter(([, d]) => d >= 0 && d <= 4).map(([k]) => k);
console.log("ESCAPING:", escaping.length ? escaping.join(", ") : "(none)");
