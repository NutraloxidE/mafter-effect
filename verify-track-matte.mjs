/**
 * §5.4f トラックマット — canvas applyTrackMatte 正準の Playwright 検証。
 * 用法: npm run dev → node verify-track-matte.mjs
 */
import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? process.env.PORT ?? "5173";
const URL = `http://localhost:${PORT}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
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

await page.goto(URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });

await page.waitForFunction(
  () => {
    const s = window.__mafterEditorStore;
    return s && s.getState().project && s.getState().currentCompId;
  },
  { timeout: 20000 },
);

// Solid fill + solid matte (small white rect)
const solidSetup = await page.evaluate(async () => {
  const st = () => window.__mafterEditorStore.getState();
  st().newProject();
  const fillId = st().addSolid("FillRed");
  const matteId = st().addSolid("MatteWhite");
  const fill = st().project.compositions
    .find((c) => c.id === st().currentCompId)
    .objects.find((o) => o.id === fillId);
  const matte = st().project.compositions
    .find((c) => c.id === st().currentCompId)
    .objects.find((o) => o.id === matteId);

  st().updateObject(
    fillId,
    {
      components: [
        {
          type: "solid",
          props: {
            color: { value: { r: 1, g: 0, b: 0, a: 1 }, keyframes: [] },
            size: { value: { x: 400, y: 300, z: 0 }, keyframes: [] },
          },
        },
      ],
      transform: {
        ...fill.transform,
        position: { value: { x: 100, y: 100, z: 0 }, keyframes: [] },
      },
    },
    "fill",
  );
  st().updateObject(
    matteId,
    {
      components: [
        {
          type: "solid",
          props: {
            color: { value: { r: 1, g: 1, b: 1, a: 1 }, keyframes: [] },
            size: { value: { x: 120, y: 80, z: 0 }, keyframes: [] },
          },
        },
      ],
      transform: {
        ...matte.transform,
        position: { value: { x: 180, y: 160, z: 0 }, keyframes: [] },
      },
    },
    "matte",
  );
  st().setTrackMatteMode(fillId, "alpha");
  return { fillId, matteId };
});

// wait for async track matte compose
await page.waitForFunction(
  (fillId) => {
    const host = document.querySelector(`[data-object-id="${fillId}"]`);
    const canvas = host?.querySelector("canvas[data-track-matte-result]");
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width < 1) return false;
    const ctx = canvas.getContext("2d");
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) opaque++;
    return opaque > 10;
  },
  solidSetup.fillId,
  { timeout: 10000 },
);

const solidStats = await page.evaluate(async (fillId) => {
  const store = window.__mafterEditorStore.getState();
  // PreviewPanel flush path
  const renderer = window.__mafterPreviewRenderer;
  if (renderer?.flushTrackMattes) await renderer.flushTrackMattes();
  else if (renderer?.flushRasterEffects) await renderer.flushRasterEffects();

  const host = document.querySelector(`[data-object-id="${fillId}"]`);
  const canvas = host?.querySelector("canvas[data-track-matte-result]");
  if (!(canvas instanceof HTMLCanvasElement)) return { error: "no canvas" };
  const ctx = canvas.getContext("2d");
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let opaque = 0;
  let redish = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a > 8) {
      opaque++;
      if (data[i] > 200 && data[i + 1] < 40 && data[i + 2] < 40) redish++;
    }
  }
  const total = width * height;
  // sample outside matte rect (comp space): fill at 100,100 size 400x300, matte at 180,160 size 120x80
  // point (110,110) is in fill but outside matte
  const outX = 110;
  const outY = 110;
  const out = ctx.getImageData(outX, outY, 1, 1).data;
  // point inside matte (200,180)
  const inX = 200;
  const inY = 180;
  const inn = ctx.getImageData(inX, inY, 1, 1).data;
  return {
    coverage: opaque / total,
    redish,
    outA: out[3],
    inA: inn[3],
    inR: inn[0],
    width,
    height,
    hasAttr: host?.hasAttribute("data-track-matte-mask") ?? false,
  };
}, solidSetup.fillId);

if (solidStats.error) fail("solid matte canvas", solidStats.error);
else {
  if (solidStats.hasAttr) ok("solid: fill host marked");
  else fail("solid: fill host marked", "missing attr");

  // matte is 120*80 / (comp typically 1920x1080) — coverage should be small but > 0
  if (solidStats.coverage > 0 && solidStats.coverage < 0.05) ok(`solid: coverage ${solidStats.coverage.toFixed(4)}`);
  else fail("solid: coverage", String(solidStats.coverage));

  if (solidStats.outA < 8) ok("solid: outside matte transparent");
  else fail("solid: outside matte transparent", `a=${solidStats.outA}`);

  if (solidStats.inA > 200 && solidStats.inR > 200) ok("solid: inside matte red opaque");
  else fail("solid: inside matte red opaque", JSON.stringify(solidStats));
}

// Text as matte
const textSetup = await page.evaluate(async () => {
  const st = () => window.__mafterEditorStore.getState();
  st().newProject();
  const fillId = st().addSolid("FillBlue");
  const textId = st().addText("MatteText");
  const fill = st().project.compositions
    .find((c) => c.id === st().currentCompId)
    .objects.find((o) => o.id === fillId);
  const text = st().project.compositions
    .find((c) => c.id === st().currentCompId)
    .objects.find((o) => o.id === textId);

  st().updateObject(
    fillId,
    {
      components: [
        {
          type: "solid",
          props: {
            color: { value: { r: 0, g: 0, b: 1, a: 1 }, keyframes: [] },
            size: { value: { x: 500, y: 300, z: 0 }, keyframes: [] },
          },
        },
      ],
      transform: {
        ...fill.transform,
        position: { value: { x: 50, y: 50, z: 0 }, keyframes: [] },
      },
    },
    "fill",
  );
  st().updateObject(
    textId,
    {
      transform: {
        ...text.transform,
        position: { value: { x: 120, y: 120, z: 0 }, keyframes: [] },
      },
    },
    "text",
  );
  st().setTrackMatteMode(fillId, "alpha");
  return { fillId, textId };
});

await page.waitForFunction(
  (fillId) => {
    const host = document.querySelector(`[data-object-id="${fillId}"]`);
    const canvas = host?.querySelector("canvas[data-track-matte-result]");
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width < 1) return false;
    const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) opaque++;
    const total = canvas.width * canvas.height;
    const c = opaque / total;
    return c > 0 && c < 0.4;
  },
  textSetup.fillId,
  { timeout: 15000 },
);

const textStats = await page.evaluate((fillId) => {
  const host = document.querySelector(`[data-object-id="${fillId}"]`);
  const canvas = host?.querySelector("canvas[data-track-matte-result]");
  if (!(canvas instanceof HTMLCanvasElement)) return { error: "no canvas" };
  const { data, width, height } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 8) opaque++;
  const coverage = opaque / (width * height);
  // far corner of fill rect should be transparent (text is near 120,120)
  const far = canvas.getContext("2d").getImageData(500, 300, 1, 1).data;
  return { coverage, farA: far[3] };
}, textSetup.fillId);

if (textStats.error) fail("text matte", textStats.error);
else {
  if (textStats.coverage > 0 && textStats.coverage < 0.4) ok(`text: coverage ${textStats.coverage.toFixed(4)} (not full, not empty)`);
  else fail("text: coverage", String(textStats.coverage));

  if (textStats.farA < 8) ok("text: far fill corner transparent");
  else fail("text: far fill corner transparent", `a=${textStats.farA}`);
}

// clear
await page.evaluate((fillId) => {
  window.__mafterEditorStore.getState().setTrackMatteMode(fillId, null);
}, textSetup.fillId);
await page.waitForTimeout(300);

const cleared = await page.evaluate(
  ({ fillId, textId }) => {
    const fillEl = document.querySelector(`[data-object-id="${fillId}"]`);
    const textEl = document.querySelector(`[data-object-id="${textId}"]`);
    return {
      maskAttr: fillEl?.getAttribute("data-track-matte-mask"),
      hasResultCanvas: !!fillEl?.querySelector("canvas[data-track-matte-result]"),
      textParentIsFill: textEl?.parentElement === fillEl,
    };
  },
  textSetup,
);

if (!cleared.maskAttr && !cleared.hasResultCanvas) ok("clear removes matte host state");
else fail("clear", JSON.stringify(cleared));

if (!cleared.textParentIsFill) ok("text returns to stage");
else fail("text returns to stage", "still under fill");

await page.screenshot({ path: "verify-track-matte.png" });

if (errors.length) fail("page errors", errors.slice(0, 3).join(" | "));
else ok("no page errors");

console.log(failed === 0 ? `PASS (${passed})` : `FAIL (${failed} failed, ${passed} passed)`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
