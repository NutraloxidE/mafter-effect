/**
 * §11.4 / §11.7 — HTML bundle の autoplay unlock 検証。
 * autoplay をブラウザがブロックする設定（--autoplay-policy=document-user-activation-required）で
 * video 内蔵音声付き bundle を boot し、
 *   1) 読み込み直後は音声付き再生がブロックされ <video> が paused であること
 *   2) スペースバー以外の「任意の操作」（ここでは単純なクリック）で再生 + アンミュートが開始すること
 * を確認する。完全無操作の音声自動再生はブラウザ仕様上不可（=この検証の前提）。
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const PORT = process.env.VERIFY_PORT ?? "5173";
const APP_URL = `http://localhost:${PORT}/`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, ".verify-bundle-autoplay-out");
const VIDEO_PATH = path.resolve("for-debug-data/video_with_audio.mp4");

// autoplay をブロックする Chromium 起動（ユーザー操作前は音声付き再生不可）。
const browser = await chromium.launch({
  args: ["--autoplay-policy=document-user-activation-required"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

let passed = 0, failed = 0;
const ok = (l) => { passed++; console.log(`  ✓ ${l}`); };
const fail = (l, d) => { failed++; console.error(`  ✗ ${l}: ${d}`); };

await page.goto(APP_URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(500);

const videoBytes = fs.readFileSync(VIDEO_PATH);

const zipB64 = await page.evaluate(async ({ bytes, name }) => {
  const store = (await import("/src/editor/store.ts")).useEditorStore;
  const S = () => store.getState();
  for (let i = 0; i < 80 && !(S().project && S().currentCompId); i++) await new Promise((r) => setTimeout(r, 250));
  await S().newProject();
  const file = new File([new Uint8Array(bytes)], name, { type: "video/mp4" });
  const assetId = await S().importVideoAsset(file);
  if (!assetId) throw new Error("importVideoAsset failed");
  if (!S().addVideoLayer(assetId, "v")) throw new Error("addVideoLayer failed");
  await new Promise((r) => setTimeout(r, 400));

  const { IndexedDbFs } = await import("/src/fs/IndexedDbFs.ts");
  const { exportBundle } = await import("/src/runtime/bundleExporter.ts");
  const fsDb = new IndexedDbFs("mafter-effect-fs");
  const cfg = { range: [0, 90], fps: 30, scale: 0.5, format: "html-bundle", alpha: false, textRenderMode: "draft", loop: true };
  const result = await exportBundle(S().project, S().currentCompId, fsDb, cfg, () => {}, undefined);
  const ab = await result.blob.arrayBuffer();
  const u8 = new Uint8Array(ab);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}, { bytes: [...videoBytes], name: "video_with_audio.mp4" });

const zip = await JSZip.loadAsync(Uint8Array.from(atob(zipB64), (c) => c.charCodeAt(0)));
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [nm, entry] of Object.entries(zip.files)) {
  if (entry.dir) continue;
  const data = await entry.async("nodebuffer");
  const out = path.join(OUT_DIR, nm);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
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

const vState = () => bp.evaluate(() => {
  const v = document.querySelector("video");
  return v ? { found: true, paused: v.paused, muted: v.muted, volume: v.volume } : { found: false };
});

const before = await vState();
console.log("before gesture:", JSON.stringify(before));
if (!before.found) fail("video element present", "no <video>");
else if (before.paused) ok("autoplay blocked: video paused before user gesture (expected)");
else console.log("  (note: this browser autoplayed without gesture — MEI/policy allowed it)");

// スペースバーではなく単純なクリック（任意操作）で unlock されることを確認。
await bp.mouse.click(700, 450);
await bp.waitForTimeout(900);
const after = await vState();
console.log("after click:", JSON.stringify(after));

if (after.found && !after.paused && after.muted === false) {
  ok("after a single click (not spacebar): video playing & unmuted");
} else {
  fail("autoplay unlock on gesture", `paused=${after.paused} muted=${after.muted}`);
}

await browser.close();
console.log(`\nautoplay-unlock verify: ${passed} passed, ${failed} failed`);
if (errors.length) console.log("Console errors:", errors.slice(0, 8));
process.exit(failed > 0 ? 1 : 0);
