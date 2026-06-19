/**
 * §11.7 Static HTML bundle — Playwright 実機検証。
 * 用法: npm run dev → node verify-bundle-export.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const PORT = process.env.VERIFY_PORT ?? "5173";
const APP_URL = `http://localhost:${PORT}/`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, ".verify-bundle-out");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

let passed = 0;
let failed = 0;

function ok(label) {
  passed++;
  console.log(`  ✓ ${label}`);
}
function fail(label, detail) {
  failed++;
  console.error(`  ✗ ${label}: ${detail}`);
}

await page.goto(APP_URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(500);

const zipB64 = await page.evaluate(async () => {
  const store = (await import("/src/editor/store.ts")).useEditorStore;
  const S = () => store.getState();
  for (let i = 0; i < 80 && !S().project; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!S().project) {
    S().newProject();
    for (let i = 0; i < 40 && !S().project; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!S().project) throw new Error("project not loaded");

  const solidId = S().addSolid("BundleSolid");
  const comp = S().project.compositions.find((c) => c.id === S().currentCompId);
  const obj = comp.objects.find((o) => o.id === solidId);
  S().updateObject(solidId, {
    transform: {
      ...obj.transform,
      position: {
        value: { x: 400, y: 300, z: 0 },
        keyframes: [
          { frame: 0, value: { x: 100, y: 300, z: 0 }, easing: { type: "linear" } },
          { frame: 60, value: { x: 1700, y: 300, z: 0 }, easing: { type: "linear" } },
        ],
      },
    },
  }, "setup");

  const { IndexedDbFs } = await import("/src/fs/IndexedDbFs.ts");
  const { exportBundle } = await import("/src/runtime/bundleExporter.ts");
  const fsDb = new IndexedDbFs("mafter-effect-fs");
  const cfg = {
    range: [0, 60],
    fps: 30,
    scale: 0.25,
    format: "html-bundle",
    alpha: false,
    textRenderMode: "draft",
  };
  const result = await exportBundle(S().project, S().currentCompId, fsDb, cfg, () => {}, undefined);
  const ab = await result.blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
});

const zipBytes = Uint8Array.from(atob(zipB64), (c) => c.charCodeAt(0));
const zip = await JSZip.loadAsync(zipBytes);
if (zip.file("index.html") && zip.file("player.js") && zip.file("bundle-manifest.json")) {
  ok("ZIP contains index.html, player.js, bundle-manifest.json");
} else {
  fail("ZIP structure", "missing required files");
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, entry] of Object.entries(zip.files)) {
  if (entry.dir) continue;
  const data = await entry.async("nodebuffer");
  const outPath = path.join(OUT_DIR, name);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, data);
}

const bundlePage = await browser.newPage();
bundlePage.on("console", (m) => { if (m.type() === "error") errors.push(`bundle: ${m.text()}`); });

await bundlePage.route("**/*", async (route) => {
  const u = new URL(route.request().url());
  let rel = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (rel === "" || rel === "index.html") rel = "index.html";
  const filePath = path.join(OUT_DIR, rel);
  if (!fs.existsSync(filePath)) {
    await route.fulfill({ status: 404, body: "not found" });
    return;
  }
  const body = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".webm": "video/webm",
  };
  await route.fulfill({
    status: 200,
    contentType: types[ext] ?? "application/octet-stream",
    body,
  });
});

await bundlePage.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle" });
await bundlePage.waitForTimeout(1500);

const childCount = await bundlePage.locator("#mafter-stage *").count();
if (childCount > 0) {
  ok("bundle player rendered and playing");
} else {
  fail("bundle player", "stage empty");
}

await browser.close();

console.log(`\nBundle export verify: ${passed} passed, ${failed} failed`);
if (errors.length) console.log("Console errors:", errors.slice(0, 8));
process.exit(failed > 0 ? 1 : 0);
