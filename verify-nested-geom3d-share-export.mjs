// §5.5f-1 — geomShareCanvas がネスト comp（precomp）経路で **書き出し** にも乗るかの実機検証。
// verify-nested-geom3d-share.mjs は preview DOM だけを見る。共有 canvas は host レイヤーの div に
// 宿るため、export の foreignObject インライン化（rasterCapture.inlineCanvasBitmaps は cloned/source の
// canvas を **index 対応** で差し替える）や bundle player 側の別 DomRenderer 実装で片側だけ壊れうる。
//
// ゲート = 「同じ 3D text 群を standalone comp で書き出した絵」と「それを precomp として親から
// 書き出した絵」のインク量が一致すること（ratio≈1）。両方 comp 解像度の PNG なので自己正規化される。
//   A. PNG 連番 export（mp4/webm と同じ compositeExportFrame 経路。encode だけが違う）
//   B. mp4 export（H.264 encode が実際に通るか。headless では落ちうるので参考値・合否外）
//   C. HTML bundle export（public/player.js の DomRenderer ＝ 別ビルド）
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const PORT = process.env.VERIFY_PORT ?? "5175";
const URL_APP = `https://localhost:${PORT}/`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, ".verify-nested-geom3d-share-out");
const FRAME = 10;

// VERIFY_MP4=1 のときは実 Chrome を headed で使う（headless Chromium は WebCodecs encode を完了できない）。
const browser = process.env.VERIFY_MP4 === "1"
  ? await chromium.launch({ channel: "chrome", headless: false })
  : await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
const errors = [];
page.on("console", (m) => {
  // console の 404 は URL を含まないため個別判定できない。実 Chrome(headed) は favicon を要求して
  // 必ず 1 件出る＝ノイズ。URL 単位の 404 検出は bundle 側 response リスナーが担う。
  if (m.type() === "error" && !/status of 404/.test(m.text())) errors.push(m.text());
  if (m.text().startsWith("[verify]")) console.log(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL_APP, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

const report = await page.evaluate(async (frame) => {
  // Vite dev は HMR で store.ts に ?t= を付ける。app が実際に読んだ URL を掴まないと別インスタンスになる。
  const storeUrl = performance.getEntriesByType("resource").map((e) => e.name)
    .find((n) => /\/src\/editor\/store\.ts(\?|$)/.test(n)) ?? "/src/editor/store.ts";
  const store = (await import(storeUrl)).useEditorStore;
  const S = () => store.getState();
  for (let i = 0; i < 80 && !(S().project && S().currentCompId); i++) await new Promise((r) => setTimeout(r, 250));
  if (!S().project) throw new Error("project never loaded");

  const sp = (v) => ({ value: v, keyframes: [] });
  const out = {};

  // ─ 子 comp: 共有指定の 3D text を 3 枚 ─
  const childId = S().addTimelineComp("ShareChild");
  S().setCurrentComp(childId);
  await S().ensureBundledFontAsset("'Noto Sans', sans-serif", 400);
  const child = () => S().project.compositions.find((c) => c.id === childId);
  for (let i = 0; i < 3; i++) {
    const id = S().addText(`t${i}`);
    const obj = child().objects.find((o) => o.id === id);
    const comps = obj.components.map((c) => c.type === "text"
      ? { ...c, props: { ...c.props, text: sp("MAF"), size: sp(90), font: "'Noto Sans', sans-serif", weight: 400,
                         geomEnabled: true, geomDepth: sp(60), geomShareCanvas: true } }
      : c);
    S().updateObject(id, {
      threeD: true,
      components: comps,
      transform: { ...obj.transform, position: sp({ x: 200 + i * 120, y: 200 + i * 90, z: i * 40 }) },
    }, "verify setup");
  }
  await new Promise((r) => setTimeout(r, 1200));
  out.childCanvases = document.querySelectorAll("canvas.mafter-geom3d-canvas").length;

  // ─ 親 comp: 子を precomp として載せる ─
  const outerId = S().addTimelineComp("Outer");
  S().setCurrentComp(outerId);
  S().addCompLayer(childId);
  S().setFrame(frame);
  await new Promise((r) => setTimeout(r, 1200));
  out.nestedCanvases = document.querySelectorAll("canvas.mafter-geom3d-canvas").length;

  // ─ export ─
  const { exportComposition } = await import("/src/runtime/exporter.ts");
  const { exportBundle } = await import("/src/runtime/bundleExporter.ts");
  const fsDb = S().getFs();
  const cfg = (format) => ({ range: [frame, frame + 1], fps: 30, scale: 1, format, alpha: false, textRenderMode: "precise" });

  /** PNG 連番 zip の 1 枚目の不透明でない「絵のインク」量。背景黒なので非黒画素を数える。 */
  const pngInk = async (blob) => {
    // dev の生 <script> 文脈では bare specifier を解決できないため vite の最適化済み dep を直接指す。
    const zip = await (await import("/node_modules/.vite/deps/jszip.js")).default.loadAsync(await blob.arrayBuffer());
    const name = Object.keys(zip.files).find((n) => n.endsWith(".png"));
    const url = URL.createObjectURL(await zip.files[name].async("blob"));
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 24) ink++;
    URL.revokeObjectURL(url);
    return { ink, w: c.width, h: c.height };
  };

  const log = (m) => console.log("[verify]", m);

  log("png-seq standalone…");
  const standaloneBlob = await exportComposition(S().project, childId, fsDb, cfg("png-seq"), () => {});
  out.standalonePng = await pngInk(standaloneBlob.blob);
  log("png-seq nested…");
  const nestedBlob = await exportComposition(S().project, outerId, fsDb, cfg("png-seq"), () => {});
  out.nestedPng = await pngInk(nestedBlob.blob);
  out.pngFallback = { standalone: standaloneBlob.fallbackReason ?? null, nested: nestedBlob.fallbackReason ?? null };

  log("bundle…");

  // bundle zip を base64 で返す（Node 側で配信して player を実走させる）
  const bundle = await exportBundle(S().project, outerId, fsDb, cfg("html-bundle"), () => {});
  const bytes = new Uint8Array(await bundle.blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  out.bundleB64 = btoa(bin);
  out.outerId = outerId;
  return out;
}, FRAME);

// ─ C: bundle player を実際に開く ─
const zip = await JSZip.loadAsync(Uint8Array.from(atob(report.bundleB64), (c) => c.charCodeAt(0)));
delete report.bundleB64;
fs.rmSync(OUT_DIR, { recursive: true, force: true });
for (const [name, entry] of Object.entries(zip.files)) {
  if (entry.dir) continue;
  const p = path.join(OUT_DIR, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, await entry.async("nodebuffer"));
}

const bundlePage = await browser.newPage({ viewport: { width: 1400, height: 900 } });
// favicon は bundle に無く route が 404 を返す（実 Chrome だけが要求する）＝検証対象外のノイズ。
// ただし console の 404 メッセージは URL を含まないため、「favicon だから」で一律に握り潰すと
// **asset 同梱もれの 404**（過去に実際に起きたバグ）まで見逃す。URL は response で個別に見る。
bundlePage.on("console", (m) => {
  if (m.type() === "error" && !/status of 404/.test(m.text())) errors.push(`bundle: ${m.text()}`);
});
// rasterProcess.worker は Vite が player.js の**隣**に出すチャンクだが bundleExporter は player.js しか
// zip しない ＝ 既存の同梱もれ（本件 geom3d 共有とは無関係・raster effect を使う bundle で顕在化）。
// この検証の合否には含めず unrelated404 として可視化だけする。
const unrelated404 = [];
bundlePage.on("response", (r) => {
  if (r.status() !== 404 || /favicon/i.test(r.url())) return;
  (/\.worker-[^/]*\.js$/.test(r.url()) ? unrelated404 : errors).push(`bundle 404: ${r.url()}`);
});
bundlePage.on("pageerror", (e) => errors.push(`bundle: ${e}`));
await bundlePage.route("**/*", async (route) => {
  const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\//, "")) || "index.html";
  const file = path.join(OUT_DIR, rel);
  if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
  const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".ttf": "font/ttf" };
  await route.fulfill({ status: 200, contentType: types[path.extname(file).toLowerCase()] ?? "application/octet-stream", body: fs.readFileSync(file) });
});
await bundlePage.goto("http://127.0.0.1:9/index.html", { waitUntil: "networkidle" });
await bundlePage.waitForTimeout(2500);
report.bundle = await bundlePage.evaluate(() => {
  const canvases = [...document.querySelectorAll("canvas.mafter-geom3d-canvas")];
  let ink = 0;
  for (const cv of canvases) {
    if (!cv.width || !cv.height) continue;
    const off = document.createElement("canvas");
    off.width = cv.width; off.height = cv.height;
    const ctx = off.getContext("2d");
    ctx.drawImage(cv, 0, 0);
    const { data } = ctx.getImageData(0, 0, off.width, off.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] > 16) ink++;
  }
  return { canvases: canvases.length, ink };
});

// ─ B: mp4（encode が実際に通るか・参考値）─
// **必ず最後**に置く: headless Chromium の WebCodecs encode は完了せずメインスレッドを掴んだまま
// になる実績があり（in-page の setTimeout すら発火しない ＝ 中断不能）、先に置くと後続が全滅する。
// ここは Node 側 timeout で切り、合否には含めない。VERIFY_MP4=1 かつ実 Chrome(headed) 推奨。
if (process.env.VERIFY_MP4 === "1") {
  const t0 = Date.now();
  report.mp4 = await Promise.race([
    page.evaluate(async ({ outerId, frame }) => {
      const storeUrl = performance.getEntriesByType("resource").map((e) => e.name)
        .find((n) => /\/src\/editor\/store\.ts(\?|$)/.test(n)) ?? "/src/editor/store.ts";
      const store = (await import(storeUrl)).useEditorStore;
      const { exportComposition } = await import("/src/runtime/exporter.ts");
      const st = store.getState();
      const r = await exportComposition(st.project, outerId, st.getFs(), {
        range: [frame, frame + 4], fps: 30, scale: 1, format: "mp4", alpha: false, textRenderMode: "precise",
      }, () => {});
      return { format: r.format, bytes: r.blob.size, fallbackReason: r.fallbackReason ?? null };
    }, { outerId: report.outerId, frame: FRAME }).catch((e) => ({ error: String(e) })),
    new Promise((res) => setTimeout(() => res({ error: "mp4 export timed out (encode wedged the page)" }), 120000)),
  ]);
  report.mp4.elapsedMs = Date.now() - t0;
} else {
  report.mp4 = { skipped: "set VERIFY_MP4=1 (headed real Chrome) to exercise H.264 encode" };
}

await browser.close();
delete report.outerId;
console.log(JSON.stringify(report, null, 2));
console.log("console errors:", errors.length, errors.slice(0, 8));
if (unrelated404.length) console.log("既知・本件と無関係な 404（bundle の worker 同梱もれ）:", [...new Set(unrelated404)]);

const ratio = report.standalonePng.ink ? report.nestedPng.ink / report.standalonePng.ink : 0;
const ok =
  report.childCanvases === 1 && report.nestedCanvases === 1 && // 共有が効いている（preview の前提）
  report.standalonePng.ink > 500 &&
  Math.abs(ratio - 1) < 0.05 &&                                 // A: PNG/mp4/webm 共通の capture 経路
  report.bundle.canvases === 1 && report.bundle.ink > 500 &&    // C: bundle player でも 1 枚に畳まれ描けている
  errors.length === 0;

console.log(ok ? "PASS" : "FAIL", "png ink ratio =", ratio.toFixed(3), "| bundle canvases =", report.bundle.canvases, "| mp4:", JSON.stringify(report.mp4));
process.exit(ok ? 0 : 1);
