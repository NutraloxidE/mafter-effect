// master-nested-composite-performance-plan — Phase 2/3 実機パリティ + op-count 検証。
//
// 目的: __mafterPreparedGeomCache（Phase 2）/ __mafterGpuMeshCache（Phase 3）を ON にしても、
//   3D-extrude text の描画ピクセルが flag OFF と一致すること（非破壊）、かつ
//   - Phase 2: transform-only な連続フレームで outline build が 1 回に収束
//   - Phase 3: warm フレームで bufferData（GPU upload）が 0
//   を実 WebGL（swiftshader）で確認する。外部 ZIP 不要（public/fonts のアウトラインフォントを使う）。
//
// 実行: dev サーバ起動後 `VERIFY_PORT=5173 node verify-master-nested-cache.mjs`。
import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `http://localhost:${PORT}/`;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(500);

const result = await page.evaluate(async () => {
  const { applyGeom3DText } = await import("/src/runtime/geom3d/geom3dDomApply.ts");
  const {
    clearPreparedGeom3DCache,
    clearGeom3DMeshCache,
    geom3DPreparedBuildCount,
    resetGeom3DPreparedBuildCount,
  } = await import("/src/runtime/geom3d/geom3dMeshCache.ts");
  const { releaseGeom3DGl, geom3DGlBufferUploadCount, resetGeom3DGlBufferUploadCount } = await import(
    "/src/runtime/geom3d/geom3dGl.ts"
  );
  const { translation } = await import("/src/runtime/mat4.ts");
  const { FontOutlineCache } = await import("/src/runtime/fontOutlineCache.ts");

  const fontCache = new FontOutlineCache();
  const buf = await (await fetch("/fonts/NotoSans-Medium.ttf")).arrayBuffer();
  const font = fontCache.parseBuffer("Noto Sans", buf, 500);

  const COMP_W = 480;
  const COMP_H = 270;
  const geom = {
    enabled: true,
    depth: 20,
    bevelSize: 2,
    bevelStyle: "round",
    bevelSegments: 3,
    curveQuality: "medium",
    shading: "lambert",
    lightDir: { x: 0.3, y: -0.5, z: 0.8 },
    ambient: 0.35,
    shareCanvas: false,
  };
  const props = { text: "AB", size: 96, tracking: 0, leading: 0, align: "left" };

  // transform-only アニメを模す world 群（geometry は不変・位置だけ変わる）。
  const worlds = [];
  for (let f = 0; f < 10; f++) worlds.push(translation(40 + f * 6, 60, 0));

  function makeEl() {
    const el = document.createElement("div");
    el.style.cssText = "position:absolute;left:0;top:0";
    document.body.appendChild(el);
    return el;
  }

  function capture(el) {
    const canvas = el.querySelector("canvas.mafter-geom3d-canvas");
    if (!canvas || !canvas.width) return null;
    const off = document.createElement("canvas");
    off.width = canvas.width;
    off.height = canvas.height;
    const ctx = off.getContext("2d");
    ctx.drawImage(canvas, 0, 0);
    return ctx.getImageData(0, 0, off.width, off.height).data;
  }

  function runPass(preparedOn, gpuOn) {
    globalThis.__mafterPreparedGeomCache = preparedOn;
    globalThis.__mafterGpuMeshCache = gpuOn;
    clearPreparedGeom3DCache();
    clearGeom3DMeshCache();
    resetGeom3DPreparedBuildCount();
    resetGeom3DGlBufferUploadCount();

    const el = makeEl();
    const frames = [];
    let uploadsAfterWarm = null;
    for (let f = 0; f < worlds.length; f++) {
      const camera = { cameraPre: null, fov: null, world: worlds[f], compW: COMP_W, compH: COMP_H };
      const ok = applyGeom3DText(el, props, font, geom, camera);
      frames.push({ ok, px: capture(el) });
      if (f === 0) uploadsAfterWarm = geom3DGlBufferUploadCount(); // warm 後の基準
    }
    const res = {
      allOk: frames.every((x) => x.ok),
      preparedBuilds: geom3DPreparedBuildCount(),
      uploadsTotal: geom3DGlBufferUploadCount(),
      uploadsAfterWarm: geom3DGlBufferUploadCount() - uploadsAfterWarm, // frame1..9 の追加 upload
      frames,
    };
    const canvas = el.querySelector("canvas.mafter-geom3d-canvas");
    if (canvas) releaseGeom3DGl(canvas);
    el.remove();
    return res;
  }

  // 基準（両 flag OFF）。
  const off = runPass(false, false);
  // Phase 2 のみ ON。
  const prepared = runPass(true, false);
  // Phase 2 + 3 ON。
  const both = runPass(true, true);

  // ピクセル一致判定（同一 frame index = 同一 world → OFF と ON で一致すべき）。
  function maxAbsDiff(a, b) {
    if (!a || !b || a.length !== b.length) return 255;
    let m = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > m) m = d;
    }
    return m;
  }
  let preparedMaxDiff = 0;
  let bothMaxDiff = 0;
  let inkFrames = 0;
  for (let f = 0; f < worlds.length; f++) {
    preparedMaxDiff = Math.max(preparedMaxDiff, maxAbsDiff(off.frames[f].px, prepared.frames[f].px));
    bothMaxDiff = Math.max(bothMaxDiff, maxAbsDiff(off.frames[f].px, both.frames[f].px));
    // 実際にインクが出ているか（0 だと空比較で誤 PASS になる）。
    const px = off.frames[f].px;
    if (px) for (let i = 3; i < px.length; i += 4) if (px[i] > 16) { inkFrames++; break; }
  }

  return {
    off: { allOk: off.allOk, preparedBuilds: off.preparedBuilds, uploadsTotal: off.uploadsTotal },
    prepared: { allOk: prepared.allOk, preparedBuilds: prepared.preparedBuilds, uploadsTotal: prepared.uploadsTotal },
    both: { allOk: both.allOk, preparedBuilds: both.preparedBuilds, uploadsAfterWarm: both.uploadsAfterWarm, uploadsTotal: both.uploadsTotal },
    preparedMaxDiff,
    bothMaxDiff,
    inkFrames,
    frameCount: worlds.length,
  };
});

await browser.close();

console.log(JSON.stringify(result, null, 2));

const nonFavErrors = errors.filter((e) => !/favicon/i.test(e));
const checks = [];
checks.push(["all frames rendered (OFF)", result.off.allOk === true]);
checks.push(["all frames rendered (prepared ON)", result.prepared.allOk === true]);
checks.push(["all frames rendered (both ON)", result.both.allOk === true]);
checks.push(["ink present in frames", result.inkFrames === result.frameCount]);
checks.push(["Phase2: outline build == 1 across 10 transform-only frames", result.prepared.preparedBuilds === 1]);
checks.push(["Phase3: 0 GPU uploads after warm frame", result.both.uploadsAfterWarm === 0]);
checks.push(["Phase2 pixel parity vs OFF (maxAbs<=2)", result.preparedMaxDiff <= 2]);
checks.push(["Phase2+3 pixel parity vs OFF (maxAbs<=2)", result.bothMaxDiff <= 2]);
checks.push(["no page errors", nonFavErrors.length === 0]);

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (!pass) ok = false;
}
if (nonFavErrors.length) console.log("errors:", nonFavErrors);
console.log(ok ? "\nVERIFY PASS" : "\nVERIFY FAIL");
process.exit(ok ? 0 : 1);
