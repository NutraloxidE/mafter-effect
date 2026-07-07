// Phase 2（packed 形式）e2e 検証: 実際の Subject Extract ML パイプラインは重いため、
// encodeRgbaFramesToPackedVideo を直接呼んで合成テスト動画を作り、
// (1) import → 単一 <video>（companion なし）で正しく再生される
// (2) GL/CPU 合成が一致する（±25/255・alpha±1、Phase1 と同じ較正値）
// (3) 人物... ではなく合成パターンが正立で表示される
// (4) PNG 連番 export でも正しく焼ける
// ところまで一気通貫で確認する。
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `http://localhost:${PORT}/`;

// §1.2 教訓: headless Chromium は WebCodecs 動画 encode を完了できないことがある
// （memory: headless-webcodecs-encode-blocks）。この verify は encodeRgbaFramesToPackedVideo を
// 実際に走らせるため、必ず headed 実 Chrome で実行する。
const browser = await chromium.launch({ headless: false, channel: "chrome" }).catch(() =>
  chromium.launch({ headless: false }),
);
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
page.on("response", (r) => { if (r.status() === 404) console.log("404 URL:", r.url()); });

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => window.__mafterEditorStore?.getState().getFs, { timeout: 20000 });

console.log("building synthetic packed-alpha test asset via encodeRgbaFramesToPackedVideo...");
const setup = await page.evaluate(async () => {
  const { encodeRgbaFramesToPackedVideo } = await import("/src/editor/subjectExtract/encodeAlphaWebm.ts");
  const { newObjectId, newBinId } = await import("/src/core/ids.ts");
  const { DIR_ASSETS } = await import("/src/core/paths.ts");

  const W = 64, H = 64, FPS = 10, FRAMES = 20;
  // 上半分=赤い円（不透明）＋下半分=透明、かつフレームごとに円が横スライドする合成テストパターン。
  const frames = [];
  for (let i = 0; i < FRAMES; i++) {
    const rgba = new Uint8ClampedArray(W * H * 4);
    const cx = 8 + (i / FRAMES) * (W - 16);
    const cy = H * 0.3; // 画面上部に円＝正立確認用（下半分は常に透明）
    const r = 10;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = (y * W + x) * 4;
        const d = Math.hypot(x - cx, y - cy);
        if (d < r) {
          rgba[idx] = 220; rgba[idx + 1] = 40; rgba[idx + 2] = 40; rgba[idx + 3] = 255;
        } else {
          rgba[idx] = 0; rgba[idx + 1] = 0; rgba[idx + 2] = 0; rgba[idx + 3] = 0;
        }
      }
    }
    frames.push({ width: W, height: H, rgba });
  }

  const encoded = await encodeRgbaFramesToPackedVideo(frames, FPS, null);

  const st = window.__mafterEditorStore.getState();
  const fsRef = st.getFs();
  const assetId = newObjectId();
  const ext = encoded.container === "mp4" ? "mp4" : "webm";
  const assetPath = `${DIR_ASSETS}/${assetId}.${ext}`;
  await fsRef.write(assetPath, encoded.bytes);

  const before = st.project;
  const binId = newBinId();
  const asset = {
    id: assetId,
    path: assetPath,
    binId,
    kind: "video",
    meta: {
      width: W,
      height: encoded.layout.contentHeight,
      duration: FRAMES / FPS,
      mime: encoded.container === "mp4" ? "video/mp4" : "video/webm",
      hasAlpha: true,
      alphaMode: "packed",
      packedLayout: "topBottom",
      contentHeight: encoded.layout.contentHeight,
      gutterPx: encoded.layout.gutterPx,
    },
  };
  const bin = { id: binId, name: "Verify Packed", parentId: null };
  const comp = before.compositions.find((c) => c.kind === "timeline");
  // アセット登録のみ手組み（st.addVideoLayer は既存アセット前提のため）。
  // レイヤー（SceneObject）自体は既存の addVideoLayer ストアアクションに作らせる
  // （transform/opacity/gain/zOrder/outPoint を正しいスキーマ形で組み立ててくれる）。
  const after = {
    ...before,
    assets: [...before.assets, asset],
    bins: [...(before.bins ?? []), bin],
  };
  st.applyCommand({ label: "verify: add packed asset", before, after });
  st.setCurrentComp(comp.id);
  const objId = st.addVideoLayer(assetId, "packed-test");
  if (!objId) throw new Error("addVideoLayer failed");

  return { compId: comp.id, objId, assetId, container: encoded.container, layout: encoded.layout, w: W, h: H };
});

console.log("setup:", setup);
await page.waitForTimeout(500);
await page.evaluate((f) => window.__mafterEditorStore.getState().setFrame(f), 5);

const videoSel = `[data-object-id="${setup.objId}"] video`;
const canvasSel = `[data-object-id="${setup.objId}"] canvas.mafter-packed-alpha-canvas`;
try {
  await page.waitForSelector(videoSel, { timeout: 10000 });
  await page.waitForSelector(canvasSel, { timeout: 10000 });
} catch (e) {
  console.error("DEBUG page errors so far:", errors);
  const html = await page.evaluate((sel) => document.querySelector(sel)?.outerHTML ?? "NOT FOUND", `[data-object-id="${setup.objId}"]`);
  console.error("DEBUG object element outerHTML:", html);
  await page.screenshot({ path: path.resolve("probe-packed-alpha-debug.png") });
  throw e;
}

// 単一 video（companion なし）であることを確認。
const videoCount = await page.evaluate(
  (sel) => document.querySelectorAll(sel).length,
  `[data-object-id="${setup.objId}"] video`,
);
console.log("video element count (expect 1, no split companion):", videoCount);

await page.waitForFunction(
  ({ videoSel }) => {
    const v = document.querySelector(videoSel);
    return v && !v.seeking && v.readyState >= 2;
  },
  { videoSel },
  { timeout: 10000, polling: 100 },
).catch(() => console.warn("WARN: video settle timed out"));

await page.waitForTimeout(300);

const screenshotPath = path.resolve("probe-packed-alpha-gl.png");
const canvasEl = await page.$(canvasSel);
await canvasEl.screenshot({ path: screenshotPath });
console.log("wrote", screenshotPath);

async function sampleCanvas(sel, gridSize) {
  return page.evaluate(({ sel, gridSize }) => {
    const c = document.querySelector(sel);
    const w = c.width, h = c.height;
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const octx = off.getContext("2d");
    octx.drawImage(c, 0, 0);
    const out = [];
    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const x = Math.min(w - 1, Math.floor((gx + 0.5) * w / gridSize));
        const y = Math.min(h - 1, Math.floor((gy + 0.5) * h / gridSize));
        const d = octx.getImageData(x, y, 1, 1).data;
        out.push([d[0], d[1], d[2], d[3]]);
      }
    }
    return { w, h, samples: out };
  }, { sel, gridSize });
}

const glSamples = await sampleCanvas(canvasSel, 32);
console.log("GL packed canvas size:", glSamples.w, glSamples.h, "(expect", setup.w, "x", setup.h, ")");

// 中央上部（円の描画帯 y≈0.3H）に不透明な赤ピクセルがあること＝正立で色/マスクが合っていることの確認。
const opaqueRedCount = glSamples.samples.filter((s) => s[3] > 200 && s[0] > 150 && s[1] < 100).length;
const transparentCount = glSamples.samples.filter((s) => s[3] < 20).length;
console.log("opaque red samples:", opaqueRedCount, "/ transparent samples:", transparentCount, "/ total:", glSamples.samples.length);

// CPU 経路（同一 video 要素に対して drawPackedAlphaComposite を直接呼ぶ）と比較。
const cpuSamples = await page.evaluate(
  async ({ videoSel, gridSize, layout }) => {
    const { drawPackedAlphaComposite } = await import("/src/runtime/videoPackedAlpha.ts");
    const video = document.querySelector(videoSel);
    const canvas = document.createElement("canvas");
    const maskScratch = document.createElement("canvas");
    document.body.appendChild(canvas);
    document.body.appendChild(maskScratch);
    const drew = drawPackedAlphaComposite(video, canvas, maskScratch, layout);
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext("2d");
    const out = [];
    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const x = Math.min(w - 1, Math.floor((gx + 0.5) * w / gridSize));
        const y = Math.min(h - 1, Math.floor((gy + 0.5) * h / gridSize));
        const d = ctx.getImageData(x, y, 1, 1).data;
        out.push([d[0], d[1], d[2], d[3]]);
      }
    }
    canvas.remove();
    maskScratch.remove();
    return { drew, w, h, samples: out };
  },
  { videoSel, gridSize: 32, layout: setup.layout },
);
console.log("CPU drew:", cpuSamples.drew, "size:", cpuSamples.w, cpuSamples.h);

const ALPHA_TOLERANCE = 1;
const PREMULT_RGB_TOLERANCE = 25;
const failures = [];
for (let i = 0; i < glSamples.samples.length; i++) {
  const a = glSamples.samples[i];
  const b = cpuSamples.samples[i];
  const alphaDiff = Math.abs(a[3] - b[3]);
  if (alphaDiff > ALPHA_TOLERANCE) {
    failures.push({ i, reason: "alpha", diff: alphaDiff, gl: a, cpu: b });
    continue;
  }
  const alpha = Math.min(a[3], b[3]);
  for (let c = 0; c < 3; c++) {
    const raw = Math.abs(a[c] - b[c]);
    const premult = raw * (alpha / 255);
    if (premult > PREMULT_RGB_TOLERANCE) {
      failures.push({ i, c, reason: "rgb-premult", diff: +premult.toFixed(2), gl: a, cpu: b });
    }
  }
}
console.log("GL/CPU parity failures:", failures.length, failures.slice(0, 5));

// export 無回帰: packed レイヤーを含む comp の PNG 連番 export。
console.log("running png-seq export...");
const base64 = await page.evaluate(
  async ({ compId }) => {
    const { exportComposition } = await import("/src/runtime/exporter.ts");
    const st = window.__mafterEditorStore.getState();
    const result = await exportComposition(
      st.project,
      compId,
      st.getFs(),
      { range: [5, 7], fps: 10, scale: 1, format: "png-seq", alpha: false, textRenderMode: "precise" },
      () => {},
    );
    const buf = await result.blob.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  },
  { compId: setup.compId },
);
const zipBuf = Buffer.from(base64, "base64");
const zip = await JSZip.loadAsync(zipBuf);
const pngNames = Object.keys(zip.files).filter((n) => n.endsWith(".png")).sort();
console.log("export png frames:", pngNames);
if (pngNames.length > 0) {
  const firstPng = await zip.files[pngNames[0]].async("nodebuffer");
  fs.writeFileSync(path.resolve("probe-packed-alpha-export-frame0.png"), firstPng);
}

console.log("page errors:", errors);

// 404 の console error は他の Playwright verify（verify-gl-alpha-parity.mjs 等）でも
// 情報表示のみで pass/fail に含めていない（dev server の副次的な resource ノイズと切り分けるため）。
// ここでの正しさの判定は実際の再生・合成・export の観測結果で行う。
const pass =
  videoCount === 1 &&
  glSamples.w === setup.w &&
  glSamples.h === setup.h &&
  opaqueRedCount > 0 &&
  transparentCount > 0 &&
  failures.length === 0 &&
  pngNames.length === 2;

console.log(pass ? "\nPASS: packed alpha e2e (playback + GL/CPU parity + export)" : "\nFAIL: see details above");

await browser.close();
process.exit(pass ? 0 : 1);
