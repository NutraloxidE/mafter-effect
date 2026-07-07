/**
 * §16.2 / §11.7 — Subject Extract split-alpha webm が HTML bundle export で再生されるかの検証。
 * ユーザー報告「透過webmが書き出されたhtmlで再生されない」の直接確認。
 * 実際の Subject Extract（MediaPipe segmentation）は headless では重い/不安定なので、
 * project.assets に split-alpha 相当の meta（alphaMode:"split" + alphaPath）を直接注入し、
 * DomRenderer/BundlePlayer の split-alpha 合成経路だけを対象に検証する。
 *
 * 用法: npm run dev → node verify-bundle-split-alpha-playback.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const PORT = process.env.VERIFY_PORT ?? "5173";
const APP_URL = `http://localhost:${PORT}/`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, ".verify-bundle-split-alpha-out");
const VIDEO_PATH = path.resolve(process.env.VERIFY_VIDEO ?? "for-debug-data/video_motion.mp4");

const browser = await chromium.launch({
  args: ["--autoplay-policy=document-user-activation-required"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(800);

const videoBytes = fs.readFileSync(VIDEO_PATH);

const zipB64 = await page.evaluate(async ({ bytes, name }) => {
  const store = (await import("/src/editor/store.ts")).useEditorStore;
  const S = () => store.getState();
  for (let i = 0; i < 80 && !(S().project && S().currentCompId); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  await S().newProject();
  const file = new File([new Uint8Array(bytes)], name, { type: "video/mp4" });
  const assetId = await S().importVideoAsset(file);
  if (!assetId) throw new Error("importVideoAsset failed");
  const layer = S().addVideoLayer(assetId, "Person");
  if (!layer) throw new Error("addVideoLayer failed");
  await new Promise((r) => setTimeout(r, 500));

  // split-alpha companion を FS に書き、asset.meta を直接注入する（実 Subject Extract は headless で重いため）。
  const asset = S().project.assets.find((a) => a.id === assetId);
  const alphaPath = asset.path.replace(/\.[^.]+$/, ".alpha.webm");
  const { IndexedDbFs } = await import("/src/fs/IndexedDbFs.ts");
  const fsDb = new IndexedDbFs("mafter-effect-fs");
  await fsDb.write(alphaPath, new Uint8Array(bytes)); // 中身は同じ動画で可（合成経路の疎通確認が目的）

  store.setState((s) => ({
    project: {
      ...s.project,
      assets: s.project.assets.map((a) =>
        a.id === assetId
          ? { ...a, meta: { ...a.meta, hasAlpha: true, alphaMode: "split", alphaPath } }
          : a,
      ),
    },
  }));
  await new Promise((r) => setTimeout(r, 300));

  const { exportBundle } = await import("/src/runtime/bundleExporter.ts");
  const comp = S().project.compositions.find((c) => c.id === S().currentCompId);
  const cfg = {
    range: [0, comp.durationFrames ?? 90],
    fps: comp.fps ?? 30,
    scale: 1,
    format: "html-bundle",
    alpha: false,
    textRenderMode: "draft",
    loop: true,
  };
  const result = await exportBundle(S().project, S().currentCompId, fsDb, cfg, () => {}, undefined);
  const ab = await result.blob.arrayBuffer();
  const u8 = new Uint8Array(ab);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return { b64: btoa(bin), alphaPath };
}, { bytes: [...videoBytes], name: "video_motion.mp4" });

const zip = await JSZip.loadAsync(Uint8Array.from(atob(zipB64.b64), (c) => c.charCodeAt(0)));
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
console.log("alphaPath:", zipB64.alphaPath);
if (files.some((f) => f === zipB64.alphaPath)) {
  ok("split-alpha companion webm is included in the exported zip (bundleCollect fix)");
} else {
  fail("alpha companion missing from zip", "would 404 in the served bundle");
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
await bp.waitForTimeout(1200);

const state = await bp.evaluate(() => {
  const videos = [...document.querySelectorAll("video")];
  return videos.map((v) => ({ paused: v.paused, muted: v.muted, currentTime: +v.currentTime.toFixed(3), readyState: v.readyState }));
});
console.log("video elements after boot (no gesture):", JSON.stringify(state));

if (state.length >= 2) {
  ok(`found ${state.length} <video> elements (color + split-alpha companion)`);
} else {
  fail("expected 2 <video> elements (color + alpha companion)", `found ${state.length}`);
}

const t0 = await bp.evaluate(() => document.querySelector("video")?.currentTime ?? -1);
await bp.waitForTimeout(600);
const t1 = await bp.evaluate(() => document.querySelector("video")?.currentTime ?? -1);
if (t1 > t0 + 0.1) {
  ok(`primary video advanced without a gesture (${t0.toFixed(3)} -> ${t1.toFixed(3)}) — not frozen`);
} else {
  fail("primary video did not advance before gesture", `${t0} -> ${t1}`);
}

if (state.every((v) => v.muted)) {
  ok("all video elements stay muted before gesture (autoplay-safe)");
} else {
  fail("a video element is unmuted before gesture", JSON.stringify(state));
}

await browser.close();
console.log(`\nsplit-alpha bundle playback verify: ${passed} passed, ${failed} failed`);
if (errors.length) console.log("Console errors:", errors.slice(0, 8));
process.exit(failed > 0 ? 1 : 0);
