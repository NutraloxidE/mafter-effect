import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5174";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.evaluate(async () => {
  indexedDB.deleteDatabase("mafter-effect-fs");
  localStorage.clear();
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

const out = await page.evaluate(async () => {
  const S = () => window.__mafterEditorStore.getState();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && !(S().project && S().currentCompId); i++) await sleep(250);
  const sp = (v) => ({ value: v, keyframes: [] });
  const v3 = (x, y, z = 0) => ({ x, y, z });
  const comp = () => S().project.compositions.find((c) => c.id === S().currentCompId);
  const tId = S().addText("Big3D");
  let o = comp().objects.find((x) => x.id === tId);
  S().updateObject(tId, {
    threeD: true,
    transform: { ...o.transform, position: sp(v3(960, 540)), rotation: sp(v3(-30, 20, 0)) },
    components: o.components.map((c) =>
      c.type === "text" ? { ...c, props: { ...c.props, text: sp("HELLO"), fontSize: sp(200), color: sp({ r: 1, g: 1, b: 1, a: 1 }) } } : c),
  }, "setup");
  S().addCamera("Cam");
  await sleep(400);
  S().addCamera("Cam");
  await sleep(400);
  const captureInk = async (label, compId) => {
    const { createCompFrameCaptureContext, captureCompFramePng } = await import("/src/runtime/compFrameCapture.ts");
    const { resolve } = await import("/src/runtime/resolve.ts");
    const c = S().project.compositions.find((x) => x.id === compId);
    const ctx = await createCompFrameCaptureContext(S().project, c.id, S().getFs(), {
      textQuality: "draft", proxyScale: 1, proxyMaxDim: Math.max(c.width, c.height),
    });
    ctx.renderer.renderFrame(resolve(c, 10, { expressions: ctx.evaluator }), 10);
    const flags = {
      threeD: ctx.renderer.hasThreeDContent(),
      layers: ctx.renderer.getExportLayers().length,
    };
    const png = await captureCompFramePng(ctx, c, 10);
    const im = new Image();
    im.src = URL.createObjectURL(new Blob([png], { type: "image/png" }));
    await new Promise((r) => { im.onload = r; im.onerror = r; });
    const cv = document.createElement("canvas");
    cv.width = im.naturalWidth; cv.height = im.naturalHeight;
    cv.getContext("2d").drawImage(im, 0, 0);
    const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 16) {
      if (d[i + 3] > 10 && d[i] + d[i + 1] + d[i + 2] > 60) ink++;
    }
    ctx.dispose();
    return { label, flags, inkRatio: +(ink / (d.length / 16)).toFixed(4) };
  };
  const withCam = await captureInk("withCam", comp().id);
  // 2D text only（カメラ無し）— capture が正常なら 3D 経路が真因
  const t2 = S().addText("Flat");
  const o2 = comp().objects.find((x) => x.id === t2);
  S().updateObject(t2, {
    transform: { ...o2.transform, position: sp(v3(960, 540)) },
    components: o2.components.map((c) =>
      c.type === "text" ? { ...c, props: { ...c.props, text: sp("FLAT"), fontSize: sp(200), color: sp({ r: 1, g: 0, b: 0, a: 1 }) } } : c),
  }, "setup");
  await sleep(300);
  const flat2d = await captureInk("flat2d", comp().id);
  return { withCam, flat2d };
});

console.log("PROBE_3D_PATH", JSON.stringify(out, null, 2));
await browser.close();
