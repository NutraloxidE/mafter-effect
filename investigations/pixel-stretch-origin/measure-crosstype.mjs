// 型ごとに box(offsetWidth/H) vs ink(実塗り bbox) のズレを実測。
// 仮説検証: solid はズレ0、text/shape は inset でズレあり、を確かめる（ユーザーの「全型同じ？」確認）。
import { chromium } from "playwright";
const PORT = process.env.PORT || process.env.VERIFY_PORT || "5177";
const scheme = PORT === "5177" ? "https" : "http";
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1, ignoreHTTPSErrors: true });
page.on("console", (m) => { if (m.type() === "error") console.log("PAGE ERR:", m.text()); });
await page.goto(`${scheme}://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload();
await page.waitForFunction(() => window.__mafterEditorStore?.getState().project && window.__mafterEditorStore.getState().currentCompId, { timeout: 15000 });

async function makeAndMeasure(kind) {
  // 1つ作って中央付近に置き、他は消す
  const objId = await page.evaluate((kind) => {
    const st = () => window.__mafterEditorStore.getState();
    // 既存を全部消す
    const comp0 = st().project.compositions.find((c) => c.id === st().currentCompId);
    st().removeObjects(comp0.objects.map((o) => o.id));
    let id;
    if (kind === "solid") id = st().addSolid("S");
    else if (kind === "shape") id = st().addShape("Sh");
    else { id = st().addText("T"); const comp = st().project.compositions.find((c) => c.id === st().currentCompId); const t = comp.objects.find((o) => o.id === id);
      st().updateObject(id, { components: t.components.map((c) => c.type === "text" ? { ...c, props: { ...c.props, text: { value: "Tp", keyframes: [] }, size: { value: 160, keyframes: [] } } } : c) }, "big"); }
    return id;
  }, kind);
  await page.waitForTimeout(400);

  const box = await page.evaluate((objId) => {
    const el = document.querySelector(`[data-object-id="${objId}"]`);
    if (!el) return null;
    let layerW = 0, layerH = 0;
    for (const ch of el.children) { layerW = Math.max(layerW, ch.offsetWidth); layerH = Math.max(layerH, ch.offsetHeight); }
    const r = el.getBoundingClientRect();
    return { layerW: Math.round(layerW), layerH: Math.round(layerH), x: r.x, y: r.y, w: r.width, h: r.height };
  }, objId);
  if (!box) return { kind, err: "no element" };

  // box より 24px 広い領域を screenshot → comp bg を四隅から取り、非bg bbox = ink
  const M = 24;
  const clip = { x: Math.max(0, Math.floor(box.x - M)), y: Math.max(0, Math.floor(box.y - M)), width: Math.ceil(box.w + 2 * M), height: Math.ceil(box.h + 2 * M) };
  const buf = await page.screenshot({ clip });
  const uri = "data:image/png;base64," + buf.toString("base64");
  const ink = await page.evaluate(async ({ uri }) => {
    const img = new Image(); img.src = uri; await new Promise((r) => { img.onload = r; });
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const c = cv.getContext("2d"); c.drawImage(img, 0, 0);
    const px = c.getImageData(0, 0, cv.width, cv.height).data;
    const at = (x, y) => { const o = (y * cv.width + x) * 4; return [px[o], px[o + 1], px[o + 2], px[o + 3]]; };
    const bg = at(1, 1);
    const diff = (x, y) => { const p = at(x, y); return Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) + Math.abs(p[3] - bg[3]); };
    let minX = cv.width, minY = cv.height, maxX = -1, maxY = -1;
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++)
      if (diff(x, y) > 40) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    if (maxX < 0) return null;
    return { left: minX, top: minY, w: maxX - minX + 1, h: maxY - minY + 1, cvW: cv.width, cvH: cv.height };
  }, { uri });

  if (!ink) return { kind, box, ink: null, note: "no ink detected" };
  // box は screenshot 内で [M, M] から始まる（left/top マージン M）
  const inkLeftInBox = ink.left - M;
  const inkTopInBox = ink.top - M;
  // linePos=0.5 の line(box基準) と ink 中央の差（screen px）
  const biasX = Math.round(0.5 * box.w - (inkLeftInBox + 0.5 * ink.w));
  const biasY = Math.round(0.5 * box.h - (inkTopInBox + 0.5 * ink.h));
  return {
    kind,
    layerBox: { w: box.layerW, h: box.layerH },
    screenBox: { w: Math.round(box.w), h: Math.round(box.h) },
    ink: { w: ink.w, h: ink.h, leftInBox: inkLeftInBox, topInBox: inkTopInBox },
    leftPad_px: inkLeftInBox, topPad_px: inkTopInBox,
    biasX_at_linePos0_5: biasX, biasY_at_linePos0_5: biasY,
  };
}

const results = [];
for (const k of ["solid", "shape", "text"]) results.push(await makeAndMeasure(k));
console.log(JSON.stringify(results, null, 2));
await browser.close();
