// Phase 1（GL 合成・split alpha）検証: 同一ページ・同一デコード済みフレームに対して
// GL 経路（既定、companion canvas が生成する結果）と CPU 経路（drawSplitAlphaComposite を
// 同じ color/alpha <video> 要素に対して直接呼ぶ）を比較する。2つの独立した page/decode
// セッションを比較すると VP9 decode 自体の非決定性が紛れ込むため、単一セッション内で
// 同じ既に decode 済みの video 要素を両経路に食わせて純粋にシェーダ/CPU実装の一致を見る。
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `http://localhost:${PORT}/`;
const ZIP = path.resolve("verify-comp32-mini-project.zip");

const COMP32 = "01KWSRT0CQGZKJ0FNKEAD41F7M";
const PERSON_LAYER = "01KWSS67VPCYTP5XKWPN1BP0EP";
const FRAME = 60;

const zipStat = fs.statSync(ZIP);
console.log("zip bytes:", zipStat.size);

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

await page.evaluate((compId) => {
  window.__mafterEditorStore.getState().setCurrentComp(compId);
}, COMP32);
await page.waitForTimeout(500);
await page.evaluate((f) => window.__mafterEditorStore.getState().setFrame(f), FRAME);

const canvasSel = `[data-object-id="${PERSON_LAYER}"] canvas.mafter-split-alpha-canvas`;
const colorSel = `[data-object-id="${PERSON_LAYER}"] video:not(.mafter-split-alpha)`;
const alphaSel = `[data-object-id="${PERSON_LAYER}"] video.mafter-split-alpha`;
await page.waitForSelector(canvasSel, { timeout: 10000 });

await page.waitForFunction(
  ({ colorSel, alphaSel }) => {
    const color = document.querySelector(colorSel);
    const alpha = document.querySelector(alphaSel);
    if (!color || !alpha) return false;
    if (color.seeking || alpha.seeking) return false;
    if (color.readyState < 2 || alpha.readyState < 2) return false;
    const key = "__mafterVerifySettle";
    const prev = window[key];
    const cur = `${color.currentTime.toFixed(4)}|${alpha.currentTime.toFixed(4)}`;
    if (prev && prev.value === cur) {
      if (performance.now() - prev.since > 400) return true;
      return false;
    }
    window[key] = { value: cur, since: performance.now() };
    return false;
  },
  { colorSel, alphaSel },
  { timeout: 15000, polling: 100 },
).catch(() => console.warn("WARN: video settle timed out"));

const targetTime = await page.evaluate((sel) => document.querySelector(sel)?.currentTime, colorSel);
console.log("settled color.currentTime =", targetTime);

function sampleCanvasExpr(sel, grid) {
  return `(() => {
    const c = ${sel};
    const w = c.width, h = c.height;
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const octx = off.getContext("2d");
    octx.drawImage(c, 0, 0);
    const out = [];
    for (let gy = 0; gy < ${grid}; gy++) {
      for (let gx = 0; gx < ${grid}; gx++) {
        const x = Math.min(w - 1, Math.floor((gx + 0.5) * w / ${grid}));
        const y = Math.min(h - 1, Math.floor((gy + 0.5) * h / ${grid}));
        const d = octx.getImageData(x, y, 1, 1).data;
        out.push([d[0], d[1], d[2], d[3]]);
      }
    }
    return { w, h, samples: out };
  })()`;
}

const grid = 40;

async function sampleCanvas(sel, gridSize) {
  return page.evaluate(({ sel, gridSize }) => {
    const c = document.querySelector(sel);
    const w = c.width, h = c.height;
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const octx = off.getContext("2d");
    octx.drawImage(c, 0, 0);
    const out = [];
    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const x = Math.min(w - 1, Math.floor((gx + 0.5) * w / gridSize));
        const y = Math.min(h - 1, Math.floor((gy + 0.5) * h / gridSize));
        const d = octx.getImageData(x, y, 1, 1).data;
        out.push([d[0], d[1], d[2], d[3]]);
      }
    }
    return { w, h, samples: out };
  }, { sel, gridSize });
}

const glResultSamples = await sampleCanvas(canvasSel, grid);
await page.screenshot({ path: path.resolve("probe-gl-alpha-gl-full.png") });
const glCanvasEl = await page.$(canvasSel);
await glCanvasEl.screenshot({ path: path.resolve("probe-gl-alpha-gl.png") });

// CPU 経路（同一・既にデコード済みの video 要素に対して drawSplitAlphaComposite を直接呼ぶ）。
const cpuResultSamples = await page.evaluate(
  async ({ colorSel, alphaSel, gridSize }) => {
    const { drawSplitAlphaComposite } = await import("/src/runtime/videoSplitAlpha.ts");
    const color = document.querySelector(colorSel);
    const alpha = document.querySelector(alphaSel);
    const canvas = document.createElement("canvas");
    const maskScratch = document.createElement("canvas");
    document.body.appendChild(canvas);
    document.body.appendChild(maskScratch);
    const drew = drawSplitAlphaComposite(color, alpha, canvas, maskScratch);
    const w = canvas.width, h = canvas.height;
    const octx = canvas.getContext("2d");
    const out = [];
    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const x = Math.min(w - 1, Math.floor((gx + 0.5) * w / gridSize));
        const y = Math.min(h - 1, Math.floor((gy + 0.5) * h / gridSize));
        const d = octx.getImageData(x, y, 1, 1).data;
        out.push([d[0], d[1], d[2], d[3]]);
      }
    }
    canvas.remove();
    maskScratch.remove();
    return { drew, w, h, samples: out };
  },
  { colorSel, alphaSel, gridSize: grid },
);

console.log("CPU drew:", cpuResultSamples.drew);
console.log("GL canvas size:", glResultSamples.w, glResultSamples.h);
console.log("CPU canvas size:", cpuResultSamples.w, cpuResultSamples.h);

// §5 検証（確証実験で判明した知見を反映・Opus 4.8 レビュー 2026-07-07）:
// マスク無しの平文 color video だけで texImage2D(video)→readback vs drawImage(video)→
// getImageData を比較しても maxDiff=22（avg 0.40）のズレが出た（下記 baseline 実験）。
// これは split alpha 合成ロジックと無関係な、ブラウザの texImage2D(video) アップロード経路の
// YUV→RGB 再構成が drawImage(video) の経路と独立していることによる既知の特性で、application
// コード側（premultiply/colorspace pixelStorei/texture filter のいずれも無効）では避けられない。
//  (a) alpha（mask.r）は全サンプルで厳格 ±1 を維持 — mask はグレースケール（Cb=Cr 一定）
//      で色差信号を持たないため YUV 再構成の余地が無く、bit 一致が正しい期待値。
//  (b) color の RGB は premultiplied 差（diff×alpha/255 = 実際に画面に効く量）で判定する。
//      alpha=255 のとき premult 差は raw diff と一致するため、baseline 実測（max 22）を
//      踏まえた ±25 が「不透明領域は事実上 raw ±25」「低 alpha 領域は alpha 分だけ自動的に
//      許容が狭まる（見た目への寄与がその分小さいため）」を単一の式で自然に表現する。
const ALPHA_TOLERANCE = 1;
const PREMULT_RGB_TOLERANCE = 25;
const failures = [];
for (let i = 0; i < glResultSamples.samples.length; i++) {
  const a = glResultSamples.samples[i];
  const b = cpuResultSamples.samples[i];
  const alphaDiff = Math.abs(a[3] - b[3]);
  if (alphaDiff > ALPHA_TOLERANCE) {
    failures.push({ i, reason: "alpha", diff: alphaDiff, gl: a, cpu: b });
    continue;
  }
  const alpha = Math.min(a[3], b[3]);
  for (let c = 0; c < 3; c++) {
    const raw = Math.abs(a[c] - b[c]);
    const premult = raw * (alpha / 255);
    if (premult > PREMULT_RGB_TOLERANCE) {
      failures.push({ i, c, reason: "rgb-premult", diff: +premult.toFixed(2), rawDiff: raw, gl: a, cpu: b });
    }
  }
}
failures.sort((x, y) => y.diff - x.diff);
console.log("failures (worst 10):", JSON.stringify(failures.slice(0, 10), null, 1));
console.log(`total failures: ${failures.length} / ${glResultSamples.samples.length * 4} channel-samples`);
console.log("page errors:", errors);

const pass = failures.length === 0;
console.log(pass ? "\nPASS: GL/CPU composite visually equivalent (matte bit-exact, RGB within visual-weight tolerance)" : "\nFAIL: visual-equivalence gates exceeded");

// --- 確証実験: mask を挟まず、同じ color video を texImage2D→readback vs drawImage→getImageData
// だけで比較し、split alpha 合成ロジックとは無関係にアップロード経路自体の色差があるか切り分ける。
const baselineDiff = await page.evaluate(
  ({ colorSel, gridSize }) => {
    const video = document.querySelector(colorSel);
    const w = video.videoWidth, h = video.videoHeight;

    // 2D 経路
    const cpuCanvas = document.createElement("canvas");
    cpuCanvas.width = w; cpuCanvas.height = h;
    const cctx = cpuCanvas.getContext("2d");
    cctx.drawImage(video, 0, 0, w, h);

    // GL 経路: 素の passthrough シェーダ（alpha合成なし・色そのまま出力）
    const glCanvas = document.createElement("canvas");
    glCanvas.width = w; glCanvas.height = h;
    const gl = glCanvas.getContext("webgl", { preserveDrawingBuffer: true });
    const vs = `attribute vec2 aPosition; attribute vec2 aUv; varying vec2 vUv;
      void main(){ vUv = aUv; gl_Position = vec4(aPosition,0.0,1.0); }`;
    const fs = `precision mediump float; varying vec2 vUv; uniform sampler2D uTex;
      void main(){ gl_FragColor = texture2D(uTex, vUv); }`;
    function compile(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,0,0, 1,-1,1,0, -1,1,0,1, 1,1,1,1]), gl.STATIC_DRAW);
    const aPosition = gl.getAttribLocation(prog, "aPosition");
    const aUv = gl.getAttribLocation(prog, "aUv");
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const gctx2 = document.createElement("canvas").getContext("2d");
    gctx2.canvas.width = w; gctx2.canvas.height = h;
    gctx2.drawImage(glCanvas, 0, 0);

    let maxDiff = 0;
    let sumDiff = 0;
    let n = 0;
    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const x = Math.min(w - 1, Math.floor((gx + 0.5) * w / gridSize));
        const y = Math.min(h - 1, Math.floor((gy + 0.5) * h / gridSize));
        const dCpu = cctx.getImageData(x, y, 1, 1).data;
        const dGl = gctx2.getImageData(x, y, 1, 1).data;
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(dCpu[c] - dGl[c]);
          maxDiff = Math.max(maxDiff, d);
          sumDiff += d;
          n++;
        }
      }
    }
    return { maxDiff, avgDiff: sumDiff / n, n };
  },
  { colorSel, gridSize: grid },
);
console.log("\n--- baseline experiment (plain color video, no mask, opaque passthrough) ---");
console.log("texImage2D(video) readback vs drawImage(video) getImageData:", baselineDiff);

await browser.close();
process.exit(pass ? 0 : 1);
