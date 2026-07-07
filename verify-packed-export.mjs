// Phase 3 gap-fill: §5 の verify-packed-export.mjs（未作成だったもの）。
// verify-packed-alpha-e2e.mjs は PNG 連番 export までしか確認しておらず、
// §2.2「packed は単一ファイル＝bundleCollect の特殊処理がそもそも不要」という主張は
// HTML bundle export で一度も実機確認されていなかった。ここで埋める。
//
// 確認内容:
// 1) packed レイヤーを含む comp の HTML bundle export で、zip に asset ファイルが
//    "1本だけ"（companion .alpha.* が同梱されない）こと。
// 2) 書き出された bundle を実際に配信して <video> が 1 要素だけ・自動再生ジェスチャ前でも
//    フリーズしていないこと（split の verify-bundle-split-alpha-playback.mjs と同型の確認）。
// 3) packed 合成 canvas が非ブランクで正立表示されること（GL/CPU いずれかの合成経路を通っている）。
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.env.VERIFY_PORT ?? "5173";
const APP_URL = `http://localhost:${PORT}/`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, ".verify-packed-export-out");

// §1.2 教訓: headless Chromium は WebCodecs 動画 encode を完了できないことがある。
const browser = await chromium.launch({ headless: false, channel: "chrome" }).catch(() =>
  chromium.launch({ headless: false }),
);
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => window.__mafterEditorStore?.getState().getFs, { timeout: 20000 });

console.log("building synthetic packed-alpha asset + exporting html-bundle...");
const built = await page.evaluate(async () => {
  const { encodeRgbaFramesToPackedVideo } = await import("/src/editor/subjectExtract/encodeAlphaWebm.ts");
  const { newObjectId, newBinId } = await import("/src/core/ids.ts");
  const { DIR_ASSETS } = await import("/src/core/paths.ts");

  const W = 64, H = 64, FPS = 10, FRAMES = 12;
  const frames = [];
  for (let i = 0; i < FRAMES; i++) {
    const rgba = new Uint8ClampedArray(W * H * 4);
    const cx = 8 + (i / FRAMES) * (W - 16);
    const cy = H * 0.3;
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
  const bin = { id: binId, name: "Verify Packed Export", parentId: null };
  const after = { ...before, assets: [...before.assets, asset], bins: [...(before.bins ?? []), bin] };
  st.applyCommand({ label: "verify: add packed asset", before, after });
  // 既定の 1920x1080 comp だと H.264 encoder が isConfigSupported を拒否する環境があり
  // （mp4 export が png-seq へフォールバックしてしまう・packed とは無関係な環境要因）、
  // テスト対象の合成アセット(64x64)に見合った小さい comp を専用に作って export する。
  const compId = st.addTimelineComp("Verify Packed Comp", { width: W, height: H, fps: FPS, duration: FRAMES });
  const comp = window.__mafterEditorStore.getState().project.compositions.find((c) => c.id === compId);
  st.setCurrentComp(comp.id);
  const objId = st.addVideoLayer(assetId, "packed-test");
  if (!objId) throw new Error("addVideoLayer failed");
  await new Promise((r) => setTimeout(r, 300));

  const { exportBundle } = await import("/src/runtime/bundleExporter.ts");
  const fresh = window.__mafterEditorStore.getState();
  const compAfter = fresh.project.compositions.find((c) => c.id === comp.id);
  const cfg = {
    range: [0, compAfter.durationFrames ?? 12],
    fps: compAfter.fps ?? 10,
    scale: 1,
    format: "html-bundle",
    alpha: false,
    textRenderMode: "draft",
    loop: true,
  };
  const result = await exportBundle(fresh.project, comp.id, fresh.getFs(), cfg, () => {}, undefined);
  const ab = await result.blob.arrayBuffer();
  const u8 = new Uint8Array(ab);
  let bin2 = "";
  for (let i = 0; i < u8.length; i++) bin2 += String.fromCharCode(u8[i]);
  return { b64: btoa(bin2), assetPath, compId: comp.id, objId };
});

const JSZip = (await import("jszip")).default;
const zip = await JSZip.loadAsync(Uint8Array.from(atob(built.b64), (c) => c.charCodeAt(0)));
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
const files = Object.keys(zip.files);
for (const [name, entry] of Object.entries(zip.files)) {
  if (entry.dir) continue;
  const data = await entry.async("nodebuffer");
  const outPath = path.join(OUT_DIR, name);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, data);
}

let passed = 0, failed = 0;
const ok = (l) => { passed++; console.log(`  ✓ ${l}`); };
const fail = (l, d) => { failed++; console.error(`  ✗ ${l}: ${d}`); };

console.log("zip files:", files.join(", "));
const assetFiles = files.filter((f) => f.startsWith("assets/") && !f.endsWith("/"));
console.log("asset files:", assetFiles.join(", "));
if (assetFiles.length === 1) {
  ok("bundle zip contains exactly 1 asset file for the packed layer (no companion)");
} else {
  fail("expected exactly 1 asset file (packed = single-file, no alpha companion)", `found ${assetFiles.length}: ${assetFiles.join(", ")}`);
}

const bp = await browser.newPage();
bp.on("console", (m) => { if (m.type() === "error") errors.push(`bundle: ${m.text()}`); });
await bp.route("**/*", async (route) => {
  const u = new URL(route.request().url());
  let rel = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (rel === "") rel = "index.html";
  const fp = path.join(OUT_DIR, rel);
  if (!fs.existsSync(fp)) { await route.fulfill({ status: 404, body: "nf" }); return; }
  const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".webm": "video/webm", ".mp4": "video/mp4" };
  await route.fulfill({ status: 200, contentType: types[path.extname(fp).toLowerCase()] ?? "application/octet-stream", body: fs.readFileSync(fp) });
});

await bp.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle" });
await bp.waitForTimeout(1500);

const videoState = await bp.evaluate(() => {
  const videos = [...document.querySelectorAll("video")];
  return videos.map((v) => ({ paused: v.paused, muted: v.muted, currentTime: +v.currentTime.toFixed(3), readyState: v.readyState }));
});
console.log("video elements in served bundle:", JSON.stringify(videoState));
if (videoState.length === 1) {
  ok("exactly 1 <video> element in the bundle (packed = single stream, no companion)");
} else {
  fail("expected exactly 1 <video> element", `found ${videoState.length}`);
}

const canvasStats = await bp.evaluate(() => {
  const c = document.querySelector("canvas.mafter-packed-alpha-canvas");
  if (!c) return null;
  const w = c.width, h = c.height;
  const ctx = c.getContext("2d") ?? c.getContext("webgl");
  // getImageData だけで判定したいので、素の 2D スナップショットを撮る。
  const off = document.createElement("canvas");
  off.width = w; off.height = h;
  const octx = off.getContext("2d");
  octx.drawImage(c, 0, 0);
  const data = octx.getImageData(0, 0, w, h).data;
  let nonTransparent = 0;
  let opaqueRedInTopHalf = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] > 20) {
        nonTransparent++;
        if (y < h / 2 && data[i] > 150 && data[i + 1] < 100) opaqueRedInTopHalf++;
      }
    }
  }
  return { w, h, nonTransparent, total: w * h, opaqueRedInTopHalf };
});
console.log("packed composite canvas stats:", canvasStats);
if (canvasStats && canvasStats.nonTransparent > 0) {
  ok(`packed composite canvas is non-blank (${canvasStats.nonTransparent}/${canvasStats.total} non-transparent px)`);
} else {
  fail("packed composite canvas appears blank", JSON.stringify(canvasStats));
}
if (canvasStats && canvasStats.opaqueRedInTopHalf > 0) {
  ok("opaque red content found in top half (upright, not flipped)");
} else {
  fail("no opaque red content in top half", "orientation/compositing may be wrong");
}

if (videoState.every((v) => v.muted)) {
  ok("video element stays muted before gesture (autoplay-safe)");
} else {
  fail("a video element is unmuted before gesture", JSON.stringify(videoState));
}

// §5 は packed export の検証対象に mp4 も明記している（bundle/PNG連番は上・別scriptで確認済み）。
// 同じ packed レイヤーを mp4 encode し、書き出したファイルを実際にデコードして非ブランクを確認する。
console.log("running mp4 export...");
const mp4Base64 = await page.evaluate(async ({ compId }) => {
  const { exportComposition } = await import("/src/runtime/exporter.ts");
  const st = window.__mafterEditorStore.getState();
  const result = await exportComposition(
    st.project,
    compId,
    st.getFs(),
    { range: [0, 5], fps: 10, scale: 1, format: "mp4", alpha: false, textRenderMode: "draft" },
    () => {},
  );
  const buf = await result.blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { b64: btoa(binary), format: result.format, fallbackReason: result.fallbackReason };
}, { compId: built.compId });

console.log("mp4 export result format:", mp4Base64.format, mp4Base64.fallbackReason ?? "");
if (mp4Base64.format !== "mp4") {
  fail("mp4 export fell back to a different format", `format=${mp4Base64.format} reason=${mp4Base64.fallbackReason}`);
} else {
  ok("mp4 export produced an actual mp4 (no WebCodecs fallback)");
}

const mp4Path = path.join(OUT_DIR, "packed-export.mp4");
fs.writeFileSync(mp4Path, Buffer.from(mp4Base64.b64, "base64"));
console.log("wrote", mp4Path, fs.statSync(mp4Path).size, "bytes");

const mp4Page = await browser.newPage();
await mp4Page.goto(APP_URL, { waitUntil: "domcontentloaded" });
const mp4Stats = await mp4Page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: "video/mp4" });
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.src = url;
  document.body.appendChild(video);
  await new Promise((resolve, reject) => {
    video.addEventListener("loadedmetadata", resolve, { once: true });
    video.addEventListener("error", () => reject(new Error("mp4 failed to load")), { once: true });
    setTimeout(() => reject(new Error("mp4 loadedmetadata timeout")), 10000);
  });
  video.currentTime = 0.2;
  await new Promise((resolve, reject) => {
    video.addEventListener("seeked", resolve, { once: true });
    setTimeout(() => reject(new Error("mp4 seek timeout")), 10000);
  });
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let nonBlack = 0;
  let redish = 0;
  const px = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum > 8) nonBlack++;
    if (r > 150 && g < 100 && b < 100) redish++;
  }
  video.remove();
  URL.revokeObjectURL(url);
  return { w: canvas.width, h: canvas.height, nonBlackRatio: nonBlack / px, redishRatio: redish / px };
}, mp4Base64.b64);
console.log("mp4 decoded frame stats:", mp4Stats);

if (mp4Stats.nonBlackRatio > 0.005) {
  ok(`mp4 export decodes to non-blank frame (nonBlack=${(mp4Stats.nonBlackRatio * 100).toFixed(2)}%)`);
} else {
  fail("mp4 export frame is essentially blank/black", JSON.stringify(mp4Stats));
}
if (mp4Stats.redishRatio > 0) {
  ok("mp4 export frame contains the expected red composited content");
} else {
  fail("mp4 export frame has no red content (packed color/mask compositing may be broken in mp4 export path)", JSON.stringify(mp4Stats));
}

await browser.close();
console.log(`\npacked export verify: ${passed} passed, ${failed} failed`);
if (errors.length) console.log("Console errors:", errors.slice(0, 8));
process.exit(failed > 0 ? 1 : 0);
