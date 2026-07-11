// Phase 1 export 無回帰確認: flushVideoFrames（GL/CPU 共通の compositeSplitAlpha 経由に変更した
// 3箇所のひとつ）を通る PNG 連番 export で、split alpha レイヤー（Person）が非ブランクで
// 正立して書き出されることを確認する。
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `http://localhost:${PORT}/`;
const ZIP = path.resolve("verify-comp32-mini-project.zip");

const COMP32 = "01KWSRT0CQGZKJ0FNKEAD41F7M";
const FRAME = 60;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.route("**/__verify_project.zip", (route) => route.fulfill({ path: ZIP, contentType: "application/zip" }));

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => window.__mafterEditorStore?.getState().getFs, { timeout: 20000 });

await page.evaluate(async () => {
  const resp = await fetch("/__verify_project.zip");
  const buf = new Uint8Array(await resp.arrayBuffer());
  const { importZip } = await import("/src/fs/zip.ts");
  const st = window.__mafterEditorStore.getState();
  await importZip(st.getFs(), buf);
  await st.loadFromFs();
});

console.log("running png-seq export for frames", FRAME, "-", FRAME + 2, "...");
const base64 = await page.evaluate(
  async ({ compId, frame }) => {
    const { exportComposition } = await import("/src/runtime/exporter.ts");
    const st = window.__mafterEditorStore.getState();
    const project = st.project;
    const fs = st.getFs();
    const result = await exportComposition(
      project,
      compId,
      fs,
      {
        range: [frame, frame + 2],
        fps: 30,
        scale: 1,
        format: "png-seq",
        alpha: false,
        textRenderMode: "precise",
      },
      () => {},
    );
    const buf = await result.blob.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  },
  { compId: COMP32, frame: FRAME },
);

console.log("page errors:", errors);

const zipBuf = Buffer.from(base64, "base64");
console.log("png-seq zip bytes:", zipBuf.length);
const zip = await JSZip.loadAsync(zipBuf);
const pngNames = Object.keys(zip.files).filter((n) => n.endsWith(".png")).sort();
console.log("png frames:", pngNames);

if (pngNames.length === 0) {
  console.error("FAIL: no PNG frames in export output");
  await browser.close();
  process.exit(1);
}

const firstPng = await zip.files[pngNames[0]].async("nodebuffer");
const outPath = path.resolve("probe-export-split-alpha-frame0.png");
fs.writeFileSync(outPath, firstPng);
console.log("wrote", outPath, firstPng.length, "bytes");

const pass = errors.length === 0 && pngNames.length === 2;
console.log(pass ? "\nPASS: png-seq export completed without console errors" : "\nFAIL: export had errors or unexpected frame count");

await browser.close();
process.exit(pass ? 0 : 1);
