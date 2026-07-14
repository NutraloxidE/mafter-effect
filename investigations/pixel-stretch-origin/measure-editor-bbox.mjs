// 実エディタで対象オブジェクトの「レイヤーボックス(offsetWidth/H = linePos の基準枠)」と
// 「実塗り ink bbox(非透明画素の範囲)」を比較し、左/上パディング量を計測する。
// 仮説: text は上/左にパディングを持つ → linePos が原点方向へズレる。solid は control(ズレ0)。
import { chromium } from "playwright";
const PORT = process.env.PORT || process.env.VERIFY_PORT || "5177";
const scheme = PORT === "5177" ? "https" : "http";
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1, ignoreHTTPSErrors: true });
page.on("console", (m) => { if (m.type() === "error") console.log("PAGE ERR:", m.text()); });
await page.goto(`${scheme}://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload();
await page.waitForFunction(() => {
  const s = window.__mafterEditorStore;
  return s && s.getState().project && s.getState().currentCompId;
}, { timeout: 15000 });

// text を作り、大きな文字に（prop 形状は { value, keyframes: [] }）
const ids = await page.evaluate(() => {
  const st = () => window.__mafterEditorStore.getState();
  const tId = st().addText("BBoxText");
  const comp = st().project.compositions.find((c) => c.id === st().currentCompId);
  const t = comp.objects.find((o) => o.id === tId);
  st().updateObject(tId, {
    components: t.components.map((c) => c.type === "text"
      ? { ...c, props: { ...c.props, text: { value: "Tp", keyframes: [] }, size: { value: 160, keyframes: [] } } }
      : c),
  }, "big text");
  return { tId };
});
await page.waitForTimeout(500);

// text 子要素の box(offsetWidth/H = linePos の基準枠) と、
// 同じ font で canvas measureText した ink bbox(actualBoundingBox*) を比較。
const out = await page.evaluate(async ({ objId }) => {
  const el = document.querySelector(`[data-object-id="${objId}"]`);
  if (!el) return { err: "no element" };
  // text を実際に描いている子要素を探す（テキスト内容を持つ最深要素）
  let node = el;
  const walk = el.querySelectorAll("*");
  for (const n of walk) if ((n.textContent || "").includes("Tp")) node = n;
  const cs = getComputedStyle(node);
  const boxW = node.offsetWidth, boxH = node.offsetHeight;
  const lineH = parseFloat(cs.lineHeight) || boxH;
  const fontPx = parseFloat(cs.fontSize);

  // canvas で ink を測る
  const cv = document.createElement("canvas"); cv.width = 512; cv.height = 512;
  const c = cv.getContext("2d");
  c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  c.textBaseline = "alphabetic";
  const m = c.measureText("Tp");
  const inkW = (m.actualBoundingBoxLeft ?? 0) + (m.actualBoundingBoxRight ?? 0);
  const ascent = m.actualBoundingBoxAscent ?? 0;   // baseline から上の ink
  const descent = m.actualBoundingBoxDescent ?? 0; // baseline から下の ink
  const inkH = ascent + descent;
  // 行ボックス内の baseline 位置（近似）: (lineH - fontPx)/2 + fontAscent。
  // fontAscent は font metrics の ascent（measureText の fontBoundingBoxAscent）。
  const fontAscent = m.fontBoundingBoxAscent ?? ascent;
  const baselineY = (lineH - fontPx) / 2 + fontAscent;
  const inkTop = baselineY - ascent;        // box 上端 → ink 上端 = 上パディング
  const inkLeft = m.actualBoundingBoxLeft != null ? Math.max(0, -m.actualBoundingBoxLeft + (m.actualBoundingBoxLeft)) : 0; // side bearing ≈ small
  // left side bearing:
  const leftPad = m.actualBoundingBoxLeft != null ? (0 - (-Math.abs(0))) : 0;

  return {
    font: c.font, boxW, boxH, lineH, fontPx,
    inkW: Math.round(inkW), inkH: Math.round(inkH),
    ascent: Math.round(ascent), descent: Math.round(descent), fontAscent: Math.round(fontAscent),
    baselineY: Math.round(baselineY),
    topPad_px: Math.round(inkTop),                 // 縦ストレッチ(down/up)が上へ寄る量
    bottomPad_px: Math.round(boxH - (inkTop + inkH)),
    // linePos=0.5(縦) の line と ink 中央の差 = 上方向バイアス
    biasY_at_linePos0_5: Math.round(0.5 * boxH - (inkTop + 0.5 * inkH)),
  };
}, { objId: ids.tId });

console.log(JSON.stringify(out, null, 2));
await page.screenshot({ path: "editor-bbox.png" });
await browser.close();
