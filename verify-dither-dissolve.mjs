import { chromium } from "playwright";

const PORT = process.env.PORT || "5173";
const URL = `http://localhost:${PORT}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });

await page.waitForFunction(() => {
  const s = window.__mafterEditorStore;
  return s && s.getState().project && s.getState().currentCompId;
}, { timeout: 15000 });

/** 重なり領域の純色 R/B と中間色（smooth opacity 署名）を数える。 */
function analyzeOverlap(data, w, h, cx, cy, halfW, halfH) {
  let pureRed = 0;
  let pureBlue = 0;
  let blended = 0;
  const x0 = Math.max(0, Math.round(cx - halfW));
  const y0 = Math.max(0, Math.round(cy - halfH));
  const x1 = Math.min(w, Math.round(cx + halfW));
  const y1 = Math.min(h, Math.round(cy + halfH));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const b = data[i + 2];
      if (r > 180 && b < 80) pureRed++;
      else if (b > 180 && r < 80) pureBlue++;
      else if (r > 40 || b > 40) blended++;
    }
  }
  const chroma = pureRed + pureBlue;
  return {
    pureRed,
    pureBlue,
    blended,
    blueShare: chroma > 0 ? pureBlue / chroma : 0,
  };
}

async function samplePreviewScreenshot(W, H) {
  const pbox = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="preview-canvas-root"]');
    if (!el) throw new Error("preview canvas root not found");
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const png = await page.screenshot({
    clip: { x: pbox.x, y: pbox.y, width: Math.max(1, pbox.width), height: Math.max(1, pbox.height) },
  });
  return page.evaluate(async ({ b64, W, H }) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `data:image/png;base64,${b64}`; });
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0, W, H);
    return Array.from(cx.getImageData(0, 0, W, H).data);
  }, { b64: png.toString("base64"), W, H });
}

const setup = await page.evaluate(async () => {
  const store = window.__mafterEditorStore;
  const sp = (v) => ({ value: v, keyframes: [] });
  const v3 = (x, y) => ({ x, y, z: 0 });
  const color = (r, g, b) => ({ r, g, b, a: 1 });

  const getComp = () =>
    store.getState().project.compositions.find((c) => c.id === store.getState().currentCompId);

  const comp0 = getComp();
  const W = comp0.width;
  const H = comp0.height;

  const bottomId = store.getState().addSolid("Red");
  const topId = store.getState().addSolid("Blue");

  const patchSolid = (id, pos, c, opacity, effects) => {
    const comp = getComp();
    const obj = comp.objects.find((o) => o.id === id);
    const comps = obj.components.map((co) =>
      co.type === "solid"
        ? { ...co, props: { ...co.props, color: sp(c), size: sp(v3(800, 600)) } }
        : co,
    );
    store.getState().updateObject(
      id,
      {
        transform: { ...obj.transform, position: sp(pos) },
        opacity: sp(opacity),
        components: comps,
        ...(effects !== undefined ? { effects } : {}),
      },
      "setup",
    );
  };

  patchSolid(bottomId, v3(W / 2, H / 2), color(1, 0, 0), 1, []);
  patchSolid(topId, v3(W / 2, H / 2), color(0, 0, 1), 1, []);

  const fxId = store.getState().addEffect(topId, "ditherDissolve");
  const topObj = getComp().objects.find((o) => o.id === topId);
  const fx = topObj.effects?.find((e) => e.id === fxId);
  if (!fx) return { error: "ditherDissolve effect not added", fxId, W, H };

  patchSolid(topId, v3(W / 2, H / 2), color(0, 0, 1), 0.5, [{ ...fx, props: { completion: sp(0) } }]);

  await new Promise((r) => setTimeout(r, 1200));

  const topEl = document.querySelector(`[data-object-id="${topId}"]`);
  const filter = topEl ? getComputedStyle(topEl).filter : "";
  const opacity = topEl ? getComputedStyle(topEl).opacity : "";

  return { bottomId, topId, filter, opacity, error: null, W, H, cx: W / 2, cy: H / 2 };
});

if (setup.error) {
  console.log("setup failed:", setup);
  await browser.close();
  process.exit(1);
}

console.log("setup:", { ...setup, W: setup.W, H: setup.H });

const { W, H, cx, cy } = setup;
const halfW = 200;
const halfH = 150;

await page.waitForTimeout(300);
const ditherData = await samplePreviewScreenshot(W, H);
const dither = analyzeOverlap(ditherData, W, H, cx, cy, halfW, halfH);
console.log("dither:", { ...dither, filter: setup.filter, opacity: setup.opacity });

await page.evaluate((topId) => {
  const store = window.__mafterEditorStore;
  const sp = (v) => ({ value: v, keyframes: [] });
  store.getState().updateObject(topId, { opacity: sp(0.5), effects: undefined }, "control");
}, setup.topId);

await page.waitForTimeout(1200);
const smoothData = await samplePreviewScreenshot(W, H);
const smooth = analyzeOverlap(smoothData, W, H, cx, cy, halfW, halfH);
console.log("smooth control:", smooth);

await page.evaluate((topId) => {
  const store = window.__mafterEditorStore;
  const sp = (v) => ({ value: v, keyframes: [] });
  const fxId = store.getState().addEffect(topId, "ditherDissolve");
  const comp = store.getState().project.compositions.find((c) => c.id === store.getState().currentCompId);
  const obj = comp.objects.find((o) => o.id === topId);
  const fx = obj.effects?.find((e) => e.id === fxId);
  store.getState().updateObject(
    topId,
    {
      opacity: sp(1),
      effects: fx ? [{ ...fx, props: { completion: sp(0.5) } }] : undefined,
    },
    "completion",
  );
}, setup.topId);

await page.waitForTimeout(1200);
const completionData = await samplePreviewScreenshot(W, H);
const completion = analyzeOverlap(completionData, W, H, cx, cy, halfW, halfH);
console.log("completion 0.5:", completion);

await page.screenshot({ path: "verify-dither-dissolve.png" });

const ditherChroma = dither.pureRed + dither.pureBlue;
const smoothChroma = smooth.pureRed + smooth.pureBlue;
const completionChroma = completion.pureRed + completion.pureBlue;

const ok =
  setup.filter.includes("url(") &&
  setup.opacity === "1" &&
  ditherChroma > 4000 &&
  ditherChroma > smoothChroma + 2000 &&
  smooth.blended > ditherChroma &&
  dither.blended < smooth.blended &&
  completionChroma > 4000 &&
  completion.blueShare > 0.35 &&
  completion.blueShare < 0.65 &&
  errors.length === 0;

console.log(ok ? "PASS" : "FAIL", errors.length ? errors : "");

await browser.close();
process.exit(ok ? 0 : 1);
