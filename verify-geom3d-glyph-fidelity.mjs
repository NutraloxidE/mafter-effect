// §5.5f グリフ忠実度: 3D-extrude text の front cap が、ブラウザ自身のフォントラスタライザ
// （Canvas2D fillText = フォントと同じ nonzero winding rule）と同じ形に塗られること。
//
// なぜ bbox 比較（verify-geom3d-neutral.mjs）では足りないか:
//   輪郭の nonzero 正規化を欠いていた頃、Noto Sans JP の `日` は「枠の内側が塗り潰れた塊」に
//   化けていたが、**bbox は正しいまま**だったため neutral verify は緑で通り抜けていた。
//   壊れるのは塗りの中身なので、面積・IoU で測る必要がある。
//
// 測り方: camera 無し・回転無し・depth=0（front cap を正対で見る中立条件）でレンダリングし、
// GL canvas の alpha マスクと、同じフォント・同じサイズで fillText したマスクを、
// それぞれの ink bbox で正規化してから IoU を取る（Preview の Fit ズーム・dpr に非依存）。
//
// 閾値の較正（2026-07-15・実 Chrome で正規化を bypass して実測）:
//   壊れている側   日 0.346 / 本 0.406 / Roboto A 0.466 / 語 0.726
//   健全な側       語 0.898 / 本 0.928 / A 0.930 / 8 0.936 / O 0.949 / B 0.970 / 日 0.975
// IoU=1.0 には構造的に届かない: 解像度の異なる 2 マスクを共通格子へリサンプルする際のエッジ量子化が
// 効くため、周長の長いグリフほど上限が下がる（`O` は本バグと無関係な対照群だが 0.949 が天井。
// curveQuality を high にしても 0.9488 までしか動かず、曲線近似は主因ではないと確認済み）。
// よって 0.726 と 0.898 の間＝両側に余裕のある 0.85 を gate とする。
// 併せて塗り率超過も見る: 「塗り潰れた塊」は ref を大きく上回る（日 は bypass 時 +80%）のに対し、
// 健全なら GL は常に ref をわずかに下回る。IoU とは独立に塊化を捉える鋭い指標。
import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5175";
const URL = `https://localhost:${PORT}/`;
// 生アウトラインが重なる（＝旧実装が壊していた）グリフを含む。ASCII のみのフォントでも起きるため
// Roboto の 'AB8' を併せて見る（フォント依存であって言語依存ではないことの回帰）。
const CASES = [
  { family: "Noto Sans JP", text: "日" },
  { family: "Noto Sans JP", text: "本" },
  { family: "Noto Sans JP", text: "語" },
  { family: "Roboto", text: "A" },
  { family: "Roboto", text: "B" },
  { family: "Roboto", text: "8" },
  { family: "Noto Sans", text: "O" }, // 真の穴を持つ対照群（正規化が穴を埋めていないこと）
];
const MIN_IOU = 0.85;
/** GL の塗り率が正解を何割超えたら「塗り潰れ」とみなすか（健全時は常に ref をやや下回る）。 */
const MAX_FILL_EXCESS = 0.15;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(500);

const results = await page.evaluate(async ({ CASES }) => {
  const storeUrl = performance.getEntriesByType("resource")
    .map((e) => e.name)
    .find((n) => /\/src\/editor\/store\.ts(\?|$)/.test(n)) ?? "/src/editor/store.ts";
  const store = (await import(storeUrl)).useEditorStore;
  const S = () => store.getState();
  for (let i = 0; i < 60 && !(S().project && S().currentCompId); i++) await new Promise((r) => setTimeout(r, 250));
  if (!S().project) throw new Error("project never loaded");
  const comp = () => S().project.compositions.find((c) => c.id === S().currentCompId);

  const SIZE = 200;
  const sp = (v) => ({ value: v, keyframes: [] });
  const id = S().addText("fidelity");
  const setProps = (patch) => {
    const obj = comp().objects.find((o) => o.id === id);
    S().updateObject(id, {
      components: obj.components.map((c) => c.type === "text" ? { ...c, props: { ...c.props, ...patch } } : c),
    }, "verify setup");
  };

  /** alpha>10 を ink とみなす二値マスク + その bbox。 */
  const maskOf = (imgData, w, h) => {
    const m = new Uint8Array(w * h);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (imgData[(y * w + x) * 4 + 3] > 10) {
        m[y * w + x] = 1;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    return maxX < minX ? null : { m, w, h, minX, minY, bw: maxX - minX + 1, bh: maxY - minY + 1 };
  };

  /** マスクを自身の ink bbox で正規化し、N×N の共通格子へリサンプルする。 */
  const N = 128;
  const resample = (mk) => {
    const g = new Uint8Array(N * N);
    for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
      const sx = Math.min(mk.w - 1, Math.round(mk.minX + ((gx + 0.5) / N) * mk.bw));
      const sy = Math.min(mk.h - 1, Math.round(mk.minY + ((gy + 0.5) / N) * mk.bh));
      g[gy * N + gx] = mk.m[sy * mk.w + sx];
    }
    return g;
  };

  const out = [];
  for (const c of CASES) {
    const stack = `'${c.family}', sans-serif`;
    setProps({
      text: sp(c.text), font: stack, size: sp(SIZE), weight: 400,
      geomEnabled: true, geomDepth: sp(0), geomBevelSize: sp(0), geomShading: "none",
    });
    // アウトライン抽出には bundled フォントが asset として登録されている必要がある（§26.4.1）。
    await S().ensureBundledFontAsset(stack, 400);
    // フォント読み込み + メッシュ再生成 + GL 描画の落ち着きを待つ
    await document.fonts.ready;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => requestAnimationFrame(() => r()));
      if (document.querySelector("canvas.mafter-geom3d-canvas")) break;
    }
    await new Promise((r) => setTimeout(r, 400));

    const glCanvas = document.querySelector("canvas.mafter-geom3d-canvas");
    if (!glCanvas) { out.push({ ...c, error: "no GL canvas (font outline unavailable?)" }); continue; }
    const tmp = document.createElement("canvas");
    tmp.width = glCanvas.width; tmp.height = glCanvas.height;
    tmp.getContext("2d").drawImage(glCanvas, 0, 0);
    const glMask = maskOf(tmp.getContext("2d").getImageData(0, 0, tmp.width, tmp.height).data, tmp.width, tmp.height);
    if (!glMask) { out.push({ ...c, error: "GL canvas is blank" }); continue; }

    // 正解 = ブラウザのフォントラスタライザ（同じ nonzero rule で塗る、実装非依存の第三者）
    const ref = document.createElement("canvas");
    ref.width = 512; ref.height = 512;
    const rctx = ref.getContext("2d");
    rctx.fillStyle = "#fff";
    rctx.font = `400 ${SIZE}px "${c.family}"`;
    rctx.textBaseline = "middle";
    rctx.fillText(c.text, 40, 256);
    const refMask = maskOf(rctx.getImageData(0, 0, 512, 512).data, 512, 512);
    if (!refMask) { out.push({ ...c, error: "reference fillText is blank" }); continue; }

    const a = resample(glMask), b = resample(refMask);
    let inter = 0, uni = 0, aInk = 0, bInk = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] && b[i]) inter++;
      if (a[i] || b[i]) uni++;
      if (a[i]) aInk++;
      if (b[i]) bInk++;
    }
    out.push({
      ...c,
      iou: uni ? inter / uni : 0,
      glFillRatio: aInk / a.length,
      refFillRatio: bInk / b.length,
    });
  }
  return out;
}, { CASES });

let failed = 0;
console.log("glyph fidelity: 3D front cap (depth=0) vs browser fillText\n");
for (const r of results) {
  if (r.error) {
    console.log(`  FAIL ${r.family} '${r.text}': ${r.error}`);
    failed++;
    continue;
  }
  const excess = r.glFillRatio / r.refFillRatio - 1;
  const ok = r.iou >= MIN_IOU && excess <= MAX_FILL_EXCESS;
  if (!ok) failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"} ${r.family.padEnd(13)} '${r.text}'  IoU=${r.iou.toFixed(4)}` +
    `  fill: gl=${r.glFillRatio.toFixed(3)} ref=${r.refFillRatio.toFixed(3)}` +
    ` (${excess >= 0 ? "+" : ""}${(excess * 100).toFixed(1)}%)`,
  );
}
if (errors.length) {
  console.log(`\nconsole errors (${errors.length}):`);
  for (const e of errors.slice(0, 5)) console.log("  " + e);
}
console.log(`\n${failed === 0 && errors.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed}/${results.length} glyphs >= IoU ${MIN_IOU}`);
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
