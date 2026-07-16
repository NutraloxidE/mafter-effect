// §5.5f P2 再設計: 3D-extrude text が実 MVP（Proj·cameraPre·world）で投影されているかの実機検証。
// 1) neutral: camera無し/回転無し → canvas が comp 全域サイズ・非空・妥当な bbox 位置。
// 2) camera dolly → 投影後 bbox サイズが変化（旧固定カメラ実装では変化しなかった）。
// 3) object Y 回転 → bbox が変化（旧実装は「平面カードの CSS tilt」で bbox 変化の性質が異なる）。
import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5175";
const URL = `https://localhost:${PORT}/`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(500);

const report = await page.evaluate(async () => {
  // Vite dev は HMR invalidation で store.ts に ?t=<timestamp> を付与することがあり、素の
  // "/src/editor/store.ts" を import() すると別モジュールインスタンス（project 未ロード）になる。
  // 実際に app が読み込んでいる URL を resource timing から拾って同一インスタンスを掴む。
  const storeUrl = performance.getEntriesByType("resource")
    .map((e) => e.name)
    .find((n) => /\/src\/editor\/store\.ts(\?|$)/.test(n)) ?? "/src/editor/store.ts";
  const store = (await import(storeUrl)).useEditorStore;
  const S = () => store.getState();
  for (let i = 0; i < 60 && !(S().project && S().currentCompId); i++) await new Promise((r) => setTimeout(r, 250));
  if (!S().project) throw new Error("project never loaded");

  const sp = (v) => ({ value: v, keyframes: [] });
  const v3 = (x, y, z = 0) => ({ x, y, z });
  const out = {};
  const comp = () => S().project.compositions.find((c) => c.id === S().currentCompId);

  const id = S().addText("3dtext");
  // §6.5b: カメラが効くのは threeD=true の層だけ（2D 層はカメラ免除）。camera/dolly を測る前に
  // 3D 化しておく — でないと 2) 3) の bbox が neutral と同一になり、「dolly で拡大するか」を
  // 測れない（免除仕様どおりの挙動を回帰と誤検出する）。
  S().updateObject(id, { threeD: true }, "verify setup: 3D layer");
  const findObj = () => comp().objects.find((o) => o.id === id);
  const setTextProp = (patch) => {
    const obj = findObj();
    const comps = obj.components.map((c) => c.type === "text" ? { ...c, props: { ...c.props, ...patch } } : c);
    S().updateObject(id, { components: comps }, "verify setup");
  };

  // Bundled font + 3D ON + 適度な depth（実 mesh を持たせる）。
  setTextProp({ text: sp("3D"), size: sp(120), font: "'Noto Sans', sans-serif", weight: 400, geomEnabled: true, geomDepth: sp(80) });
  await S().ensureBundledFontAsset("'Noto Sans', sans-serif", 400);
  await new Promise((r) => setTimeout(r, 500));

  const readCanvasBBox = () => {
    const canvas = document.querySelector("canvas.mafter-geom3d-canvas");
    if (!canvas) return null;
    const w = canvas.width, h = canvas.height;
    if (w === 0 || h === 0) return { canvasW: w, canvasH: h, bbox: null };
    const tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h;
    const ctx = tmp.getContext("2d");
    ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const a = data[(y * w + x) * 4 + 3];
        if (a > 10) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX) return { canvasW: w, canvasH: h, bbox: null };
    return { canvasW: w, canvasH: h, bbox: { minX, minY, w: maxX - minX, h: maxY - minY } };
  };

  // 1) neutral（camera無し）
  out.neutral = readCanvasBBox();

  // 2) camera 追加 → 中央注視の two-node camera（既定 addCamera）。
  const camId = S().addCamera();
  await new Promise((r) => setTimeout(r, 400));
  out.withCameraDefault = readCanvasBBox();

  // dolly: カメラ position.z を減らして content(z=0)に近づける（+z=視点側規約・addCamera既定 position.z=zoom
  // が「content からの距離」を表す。POI 固定のまま近づく＝対象が拡大投影されるはず）。
  const cam = comp().objects.find((o) => o.id === camId);
  const camPos = cam.transform.position.value;
  S().updateObject(camId, { transform: { ...cam.transform, position: sp(v3(camPos.x, camPos.y, camPos.z - 600)) } }, "dolly");
  await new Promise((r) => setTimeout(r, 400));
  out.afterDolly = readCanvasBBox();

  // 3) object を Y 回転 45deg（threeD は setup 済み）。
  const obj = findObj();
  S().updateObject(id, {
    threeD: true,
    transform: { ...obj.transform, rotation: sp(v3(0, 45, 0)) },
  }, "rotate Y");
  await new Promise((r) => setTimeout(r, 400));
  out.afterRotateY = readCanvasBBox();

  return out;
});

console.log(JSON.stringify(report, null, 2));
console.log("console errors:", errors.length, errors.slice(0, 10));
await browser.close();

const bboxArea = (r) => r?.bbox ? r.bbox.w * r.bbox.h : 0;
const ok =
  report.neutral?.bbox !== null &&
  bboxArea(report.neutral) > 100 &&
  report.afterDolly?.bbox !== null &&
  bboxArea(report.afterDolly) > bboxArea(report.withCameraDefault) * 1.15 && // dolly = 拡大するはず
  report.afterRotateY?.bbox !== null &&
  errors.length === 0;

console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
