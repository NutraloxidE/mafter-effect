// D-2 spike — liquidChrome（feTurbulence displace + feSpecularLighting + gradientMap chrome）INV-2 検証。
// 実アプリの登録経路（globalPluginRegistry → DomRenderer.applyEffects → createSvgFilterElement）で
// 生成された filter を、同一 DomRenderer インスタンス上で
//   (a) 実際にブラウザが画面へ合成した pixel（on-screen mount + page.screenshot）
//   (b) 既存 export 経路（captureElementToCanvas の foreignObject キャプチャ）
// の両方に通し、画素が一致するかを見る（プロパティ変更ゼロで同一フレームを二重取得）。
// go: 一致 → liquidChrome を live として票化。no-go: lighting 段を捨て
// turbulentDisplace + gradientMap(chrome) + hyperGlow の 3 スタックへ後退。
import { chromium } from "playwright";
import fs from "node:fs";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `https://localhost:${PORT}/`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 500, height: 400 }, ignoreHTTPSErrors: true });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

async function runVariant(primitivesBuilder, filterId) {
  const setup = await page.evaluate(async ({ filterId, primitivesSrc }) => {
    const { DomRenderer } = await import("/src/runtime/DomRenderer.ts");
    const { resolve } = await import("/src/runtime/resolve.ts");
    const { globalPluginRegistry } = await import("/src/runtime/pluginRegistry.ts");
    const effectSvg = await import("/src/runtime/effectSvg.ts");

    // eslint-disable-next-line no-new-func
    const buildPrimitives = new Function("effectSvg", "ctx", `return (${primitivesSrc})(effectSvg, ctx);`);

    globalPluginRegistry.registerEffect({
      type: filterId,
      label: filterId,
      category: "スタイライズ",
      previewBakeRequired: false,
      executionPath: "live",
      params: [],
      apply: (_props, ctx) => ({ kind: "svg", primitives: buildPrimitives(effectSvg, ctx) }),
    });

    // 最小 in-memory composition（store を経由せず resolve() に渡す純粋な構造）を自前で組む。
    const W = 300, H = 200;
    const comp = {
      id: "spikeComp", kind: "timeline", name: "spike", width: W, height: H, fps: 30, duration: 30,
      backgroundColor: { r: 0, g: 0, b: 0, a: 1 },
      objects: [{
        id: "spikeObj", name: "spike", parent: null, zOrder: 0, enabled: true,
        inPoint: 0, outPoint: 30,
        transform: {
          anchor: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
          position: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
          rotation: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
          scale: { value: { x: 1, y: 1, z: 1 }, keyframes: [] },
        },
        opacity: { value: 1, keyframes: [] },
        isNull: false,
        components: [{ type: "solid", props: {
          color: { value: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, keyframes: [] },
          size: { value: { x: W, y: H, z: 0 }, keyframes: [] },
        } }],
        effects: [{ id: "fx1", type: filterId, enabled: true, props: {} }],
      }],
    };

    const container = document.createElement("div");
    container.style.cssText = `position:fixed;left:20px;top:20px;width:${W}px;height:${H}px;overflow:hidden;background:#000;`;
    document.body.appendChild(container);

    const renderer = new DomRenderer();
    renderer.mount(container, comp);
    renderer.resize(comp.width, comp.height);
    renderer.renderFrame(resolve(comp, 0), 0);
    await renderer.flushRasterEffects();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const { captureElementToCanvas } = await import("/src/runtime/rasterCapture.ts");
    const exportCanvas = await captureElementToCanvas(renderer.getRoot(), W, H, "#000000");
    const exportData = exportCanvas.getContext("2d").getImageData(0, 0, W, H).data;
    let exportNonBg = 0;
    for (let i = 0; i < exportData.length; i += 4) if (exportData[i] > 5 || exportData[i + 1] > 5 || exportData[i + 2] > 5) exportNonBg++;

    window.__spikeRenderer = renderer;
    window.__spikeContainer = container;
    return {
      W, H,
      exportPng: exportCanvas.toDataURL("image/png"),
      exportNonBgFrac: exportNonBg / (exportData.length / 4),
    };
  }, { filterId, primitivesSrc: primitivesBuilder.toString() });

  const rect = { x: 20, y: 20, width: setup.W, height: setup.H };
  const previewShot = await page.screenshot({ clip: rect });

  const previewStats = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await new Promise((res) => { img.onload = res; });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBg = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 5 || d[i + 1] > 5 || d[i + 2] > 5) nonBg++;
    return { nonBgFrac: nonBg / (d.length / 4) };
  }, previewShot.toString("base64"));

  // 画素 diff は preview(screenshot) vs export(captureElementToCanvas) の両 PNG を
  // browser 側でデコードして比較する。
  const diff = await page.evaluate(async ({ exportPng, previewB64 }) => {
    async function decode(dataUrl) {
      const img = new Image();
      img.src = dataUrl;
      await new Promise((res) => { img.onload = res; });
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height).data;
    }
    const a = await decode(`data:image/png;base64,${previewB64}`);
    const b = await decode(exportPng);
    let maxDiff = 0, sum = 0, n = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i += 4) {
      for (let c2 = 0; c2 < 3; c2++) {
        const d = Math.abs(a[i + c2] - b[i + c2]);
        maxDiff = Math.max(maxDiff, d);
        sum += d; n++;
      }
    }
    return { maxDiff, meanDiff: sum / n };
  }, { exportPng: setup.exportPng, previewB64: previewShot.toString("base64") });

  await page.evaluate(() => {
    window.__spikeRenderer.dispose();
    window.__spikeContainer.remove();
  });

  return { ...diff, previewNonBgFrac: previewStats.nonBgFrac, exportNonBgFrac: setup.exportNonBgFrac, exportPng: setup.exportPng };
}

const variants = {
  v1_identity: (effectSvg, ctx) => `<feOffset in="SourceGraphic" dx="0" dy="0"/>`,
  v2_displaceOnly: (effectSvg, ctx) => {
    const w = Math.max(1, ctx.width), h = Math.max(1, ctx.height);
    const scale = 18;
    const dispRaw = effectSvg.turbulenceDisplace({
      scale, baseFrequencyX: 0.015, baseFrequencyY: 0.015, seed: 7, numOctaves: 2,
      type: "fractalNoise", w, h, skipBias: false, stitch: true,
    });
    return dispRaw;
  },
  v3_full: (effectSvg, ctx) => {
    const w = Math.max(1, ctx.width), h = Math.max(1, ctx.height);
    const scale = 18;
    const dispRaw = effectSvg.turbulenceDisplace({
      scale, baseFrequencyX: 0.015, baseFrequencyY: 0.015, seed: 7, numOctaves: 2,
      type: "fractalNoise", w, h, skipBias: false, stitch: true,
    });
    const disp = dispRaw.replace(
      `<feDisplacementMap in="SourceGraphic" in2="noiseBalanced" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>`,
      `<feDisplacementMap in="SourceGraphic" in2="noiseBalanced" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="displaced"/>`,
    );
    const specular =
      '<feGaussianBlur in="noiseRaw" stdDeviation="2" result="bump"/>' +
      '<feSpecularLighting in="bump" surfaceScale="6" specularConstant="1.2" specularExponent="12" lighting-color="#ffffff" result="spec">' +
      '<feDistantLight azimuth="235" elevation="55"/>' +
      '</feSpecularLighting>' +
      '<feComposite in="spec" in2="displaced" operator="in" result="specClamped"/>' +
      '<feComposite in="displaced" in2="specClamped" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="lit"/>';
    const { r, g, b } = effectSvg.gradientMapTable("chrome", 0, { r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 });
    const gradientMap =
      `<feComponentTransfer in="lit" result="graded">` +
      `<feFuncR type="table" tableValues="${r}"/><feFuncG type="table" tableValues="${g}"/><feFuncB type="table" tableValues="${b}"/>` +
      `</feComponentTransfer>`;
    return disp + specular + gradientMap;
  },
};

for (const [name, fn] of Object.entries(variants)) {
  const r = await runVariant(fn, `filter_${name}`);
  fs.writeFileSync(`verify-liquidchrome-${name}-export.png`, Buffer.from(r.exportPng.split(",")[1], "base64"));
  console.log(`[${name}] maxDiff=${r.maxDiff} meanDiff=${r.meanDiff.toFixed(2)} previewNonBg=${(r.previewNonBgFrac * 100).toFixed(1)}% exportNonBg=${(r.exportNonBgFrac * 100).toFixed(1)}%`);
}
console.log("errors:", errors.length ? errors.slice(0, 10) : "none");
await browser.close();
