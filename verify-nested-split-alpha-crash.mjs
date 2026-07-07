import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const PORT = process.env.PORT || "5173";
const URL = `http://localhost:${PORT}/`;

const FIXTURE_DIR = "for-debug-data/splitalpha";
const colorBytes = Array.from(readFileSync(`${FIXTURE_DIR}/color.webm`));
const alphaBytes = Array.from(readFileSync(`${FIXTURE_DIR}/alpha.webm`));

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") { console.log("PAGE ERR:", m.text()); pageErrors.push(m.text()); }
});
page.on("pageerror", (e) => {
  console.log("UNCAUGHT:", e.message);
  pageErrors.push(e.message);
});

await page.goto(URL);
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload();

await page.waitForFunction(() => {
  const s = window.__mafterEditorStore;
  return s && s.getState().project && s.getState().currentCompId;
}, { timeout: 15000 });

const setup = await page.evaluate(async ({ colorBytes, alphaBytes }) => {
  const store = window.__mafterEditorStore;
  const st = () => store.getState();

  // Comp A: 160x90/30fps/60f, contains the split-alpha video layer (repro's "comp 32").
  const compAId = st().addTimelineComp("Comp A (split-alpha)", { width: 160, height: 90, fps: 30, duration: 60 });

  const colorFile = new File([new Uint8Array(colorBytes)], "color.webm", { type: "video/webm" });
  const assetId = await st().importVideoAsset(colorFile);
  if (!assetId) return { error: "importVideoAsset failed" };

  // Write the alpha companion into fs and mark the asset as split-alpha (mirrors SubjectExtractFields.tsx flow).
  const fs = st().getFs();
  const alphaPath = `assets/${assetId}.alpha.webm`;
  await fs.write(alphaPath, new Uint8Array(alphaBytes));

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

  const videoLayerId = st().addVideoLayer(assetId);

  // Comp B: the "new comp" the user drops Comp A into as a precomp.
  const compBId = st().addTimelineComp("Comp B (nest target)", { width: 320, height: 180, fps: 30, duration: 60 });
  const nestLayerId = st().addCompLayer(compAId);

  return { compAId, compBId, assetId, videoLayerId, nestLayerId };
}, { colorBytes, alphaBytes });

console.log("setup:", setup);

// Give the preview effect a beat to mount/render (this is where the crash previously threw).
await page.waitForTimeout(1500);

const domCheck = await page.evaluate(() => {
  const canvas = document.querySelector("canvas.mafter-split-alpha-canvas");
  const video = document.querySelector("video.mafter-split-alpha");
  return {
    canvasFound: !!canvas,
    canvasConnected: canvas ? canvas.isConnected : false,
    canvasSize: canvas ? { w: canvas.width, h: canvas.height } : null,
    alphaVideoFound: !!video,
  };
});
console.log("dom check:", domCheck);

await page.screenshot({ path: "verify-nested-split-alpha-crash.png" });

const ok = pageErrors.length === 0 && domCheck.canvasFound && domCheck.canvasConnected;
console.log(pageErrors.length ? `page errors: ${pageErrors.length}` : "no page errors");
console.log(ok ? "PASS" : "FAIL");

await browser.close();
process.exit(ok ? 0 : 1);
