// §5.5f INV-2 中立性: camera 無し・回転無し・depth=0 の 3D-extrude text は 2D text と
// スクリーン位置/サイズがほぼ一致すること（実 MVP 投影が既存 2D 描画を破壊していないことの証明）。
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
  const storeUrl = performance.getEntriesByType("resource")
    .map((e) => e.name)
    .find((n) => /\/src\/editor\/store\.ts(\?|$)/.test(n)) ?? "/src/editor/store.ts";
  const store = (await import(storeUrl)).useEditorStore;
  const S = () => store.getState();
  for (let i = 0; i < 60 && !(S().project && S().currentCompId); i++) await new Promise((r) => setTimeout(r, 250));
  if (!S().project) throw new Error("project never loaded");

  const sp = (v) => ({ value: v, keyframes: [] });
  const comp = () => S().project.compositions.find((c) => c.id === S().currentCompId);

  const id = S().addText("neutraltext");
  const findObj = () => comp().objects.find((o) => o.id === id);
  const setTextProp = (patch) => {
    const obj = findObj();
    const comps = obj.components.map((c) => c.type === "text" ? { ...c, props: { ...c.props, ...patch } } : c);
    S().updateObject(id, { components: comps }, "verify setup");
  };

  // GL canvas は常に comp buffer 解像度（compW*dpr 等）で描く。canvas の getBoundingClientRect()
  // （page px）÷ canvas.width（buffer px）で「buffer px → page px」の実効スケール（dpr と Preview
  // の Fit ズーム両方を含む）を直接測れる。2D 経路の getBoundingClientRect() も同じ page px なので、
  // このスケールで揃えれば Preview のズーム状態に関わらず公正に比較できる。
  const readBBox = () => {
    const canvas = document.querySelector("canvas.mafter-geom3d-canvas");
    if (canvas) {
      const w = canvas.width, h = canvas.height;
      const tmp = document.createElement("canvas");
      tmp.width = w; tmp.height = h;
      const ctx = tmp.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      const data = ctx.getImageData(0, 0, w, h).data;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] > 10) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < minX) return null;
      const rect = canvas.getBoundingClientRect();
      const scale = rect.width / w; // buffer px → page px
      return {
        minX: rect.left + minX * scale,
        minY: rect.top + minY * scale,
        w: (maxX - minX) * scale,
        h: (maxY - minY) * scale,
        mode: "gl",
      };
    }
    // 2D フォールバック: text コンポーネント el の描画コンテンツを直接測る（page px）。
    const els = [...document.querySelectorAll(`[data-object-id="${id}"] *`)];
    let best = null;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && (!best || r.width * r.height > best.w * best.h)) {
        best = { minX: r.left, minY: r.top, w: r.width, h: r.height, mode: "2d" };
      }
    }
    return best;
  };

  const out = {};

  // 2D（3D OFF）でのベースライン測定。
  setTextProp({ text: sp("Neutral"), size: sp(80), font: "'Noto Sans', sans-serif", weight: 400, geomEnabled: false });
  await new Promise((r) => setTimeout(r, 400));
  out.baseline2D = readBBox();

  // 3D ON（camera無し・回転無し・depth=0）→ neutral のはず。
  setTextProp({ geomEnabled: true, geomDepth: sp(0) });
  await S().ensureBundledFontAsset("'Noto Sans', sans-serif", 400);
  await new Promise((r) => setTimeout(r, 500));
  out.neutral3D = readBBox();

  return out;
});

console.log(JSON.stringify(report, null, 2));
console.log("console errors:", errors.length, errors.slice(0, 10));
await browser.close();

const b2 = report.baseline2D, b3 = report.neutral3D;
const close = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol;
// Y/height は「2D の CSS line-box（ascender/leading 込み）」対「GL の ink bbox（実インクのみ）」を
// 比較しているため、glyph 上部の空白ぶんズレるのは実装バグではなく測定方法の差（許容を広げる）。
// X/width は line-box と ink-bbox でほぼ一致するはずなのでタイトに見る（水平方向の投影精度の証明）。
const ok =
  b2 && b3 && b3.mode === "gl" &&
  close(b2.minX, b3.minX, 6) && close(b2.minY, b3.minY, 20) &&
  close(b2.w, b3.w, 8) && close(b2.h, b3.h, 20) &&
  errors.length === 0;

console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
