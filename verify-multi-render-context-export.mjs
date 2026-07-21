// §11.2 Phase 6（実験）— multi-render-context の parity + wall A/B 検証。
//
// gate:
//   1) PNG 連番を single-context / multi-context(2) で書き出し、**各フレームの PNG バイトが完全一致**
//      すること（INV-2: どの context が描いても resolve は純関数で同一結果）。
//   2) mp4 を single / multi で複数 pair 走らせ wall median を比較（PLAN Phase 6: ≥20% 改善時のみ採用）。
//      mp4 は metadata decode / 中点サンプルの近似一致も確認する。
//
// 使い方: `npm run dev` 起動後 `node verify-multi-render-context-export.mjs`
//   任意: VERIFY_PORT / VERIFY_PAIRS(mp4 pair 数, 既定 3) / VERIFY_FRAMES(既定 24) / VERIFY_CTX(既定 2)

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5173";
const APP_URL = `https://localhost:${PORT}/`;
const FRAMES = Number(process.env.VERIFY_FRAMES ?? "24");
const PAIRS = Number(process.env.VERIFY_PAIRS ?? "3");
const CTX = Number(process.env.VERIFY_CTX ?? "2");
const OUT = join(dirname(fileURLToPath(import.meta.url)), process.env.VERIFY_OUT ?? "verify-multi-render-context-export.json");

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(),
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.goto(APP_URL, { waitUntil: "networkidle" });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

const ev = (fn, ...a) => page.evaluate(fn, ...a);

// ─── fixture: HTML-heavy / frame 独立 / video なし（capture-bound・multi-context 適格） ───
const built = await ev(async () => {
  const s = window.__mafterEditorStore.getState();
  const objectById = (id) => window.__mafterEditorStore.getState().project.compositions
    .flatMap((c) => c.objects ?? []).find((o) => o.id === id);
  const W = 1280, H = 720, DUR = 60;
  const mainId = s.addTimelineComp("MRC-Main", { width: W, height: H, fps: 30, duration: DUR });
  s.setCurrentComp(mainId);
  const solid = (name, color, size, z) => {
    const id = s.addSolid(name);
    s.updateObject(id, { zOrder: z, components: [{ type: "solid", props: { color: { value: color, keyframes: [] }, size: { value: size, keyframes: [] } } }] });
    return id;
  };
  const animate = (id, from, to) => {
    const t = objectById(id).transform;
    s.updateObject(id, { transform: { ...t, position: { value: { x: 0, y: 0, z: 0 }, keyframes: [
      { frame: 0, value: from, easing: { type: "linear" } },
      { frame: 24, value: to, easing: { type: "linear" } },
    ] } } });
  };
  solid("BG", { r: 0.05, g: 0.05, b: 0.08, a: 1 }, { x: W, y: H, z: 0 }, 0);
  const b1 = solid("Mul", { r: 0.8, g: 0.6, b: 0.2, a: 1 }, { x: 420, y: 300, z: 0 }, 1); s.setBlendMode(b1, "multiply"); animate(b1, { x: 60, y: 40, z: 0 }, { x: 520, y: 260, z: 0 });
  const b2 = solid("Ovl", { r: 0.2, g: 0.7, b: 0.9, a: 1 }, { x: 380, y: 280, z: 0 }, 2); s.setBlendMode(b2, "overlay"); animate(b2, { x: 500, y: 90, z: 0 }, { x: 120, y: 420, z: 0 });
  const b3 = solid("Scr", { r: 0.9, g: 0.2, b: 0.5, a: 1 }, { x: 340, y: 240, z: 0 }, 3); s.setBlendMode(b3, "screen"); animate(b3, { x: 200, y: 380, z: 0 }, { x: 760, y: 120, z: 0 });
  const s4 = solid("S4", { r: 0.3, g: 0.9, b: 0.4, a: 1 }, { x: 300, y: 200, z: 0 }, 4); animate(s4, { x: 700, y: 300, z: 0 }, { x: 260, y: 60, z: 0 });
  for (let i = 0; i < 3; i++) {
    const tId = s.addText(`Txt${i}`);
    s.updateObject(tId, { zOrder: 5 + i });
    animate(tId, { x: 80 + i * 120, y: 500 - i * 60, z: 0 }, { x: 900 - i * 120, y: 200 + i * 80, z: 0 });
  }
  s.setCurrentComp(mainId); s.setFrame(0);
  return { mainId, size: [W, H] };
});
console.log("built:", JSON.stringify(built));
await ev(async () => { await window.__mafterEditorStore.getState().saveToFs(); });

// ─── PNG 連番の per-frame バイト parity ───
async function pngHashes(multiCtx, ctxCount) {
  return ev(async (opts) => {
    const s = window.__mafterEditorStore.getState();
    const mod = await import("/src/runtime/exporter.ts");
    if (!window.JSZip) {
      await import("/node_modules/jszip/dist/jszip.min.js");
    }
    const JSZip = window.JSZip;
    globalThis.__mafterMultiRenderContext = opts.multi;
    globalThis.__mafterMultiRenderContextCount = opts.ctx;
    globalThis.__mafterMultiRenderContextFrames = 0;
    globalThis.__mafterMultiRenderContextDist = null;
    const cfg = { range: [0, opts.n], fps: 30, scale: 1, format: "png-seq", alpha: false, textRenderMode: "precise" };
    const t0 = performance.now();
    const res = await mod.exportComposition(s.project, opts.mainId, s.getFs(), cfg, () => {});
    const totalMs = performance.now() - t0;
    const zip = await JSZip.loadAsync(await res.blob.arrayBuffer());
    const names = Object.keys(zip.files).filter((n) => n.endsWith(".png")).sort();
    const hashes = [];
    for (const name of names) {
      const bytes = await zip.files[name].async("uint8array");
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      hashes.push([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""));
    }
    return {
      totalMs: +totalMs.toFixed(1),
      frameCount: names.length,
      hashes,
      mcFrames: globalThis.__mafterMultiRenderContextFrames ?? 0,
      dist: globalThis.__mafterMultiRenderContextDist ?? null,
    };
  }, { mainId: built.mainId, n: FRAMES, multi: multiCtx, ctx: ctxCount });
}

const single = await pngHashes(false, CTX);
const multi = await pngHashes(true, CTX);
let mismatches = 0;
const firstMismatch = [];
for (let i = 0; i < Math.max(single.hashes.length, multi.hashes.length); i++) {
  if (single.hashes[i] !== multi.hashes[i]) { mismatches++; if (firstMismatch.length < 5) firstMismatch.push(i); }
}
const parityOk = mismatches === 0
  && single.frameCount === FRAMES && multi.frameCount === FRAMES
  && multi.mcFrames === FRAMES && single.mcFrames === 0;
console.log(`\nPNG parity: single=${single.frameCount}f multi=${multi.frameCount}f mismatches=${mismatches} dist=${JSON.stringify(multi.dist)}`);
console.log(`PNG wall: single=${single.totalMs}ms multi=${multi.totalMs}ms`);

// ─── mp4 wall A/B（PLAN Phase 6 gate: ≥20% 改善で採用検討） ───
async function mp4Run(multiCtx, ctxCount) {
  return ev(async (opts) => {
    const s = window.__mafterEditorStore.getState();
    const mod = await import("/src/runtime/exporter.ts");
    globalThis.__mafterMultiRenderContext = opts.multi;
    globalThis.__mafterMultiRenderContextCount = opts.ctx;
    // multi-context は GPU/direct と排他。single 側も既定 flag のまま（本番既定を反映）。
    const cfg = { range: [0, opts.n], fps: 30, scale: 1, format: "mp4", alpha: false, textRenderMode: "precise" };
    const t0 = performance.now();
    let ok = false, err = null, meta = null, sample = null;
    try {
      const res = await mod.exportComposition(s.project, opts.mainId, s.getFs(), cfg, () => {});
      ok = !!res?.blob && res.format === "mp4";
      if (res?.blob) {
        const url = URL.createObjectURL(res.blob);
        try {
          const v = document.createElement("video"); v.preload = "metadata"; v.src = url;
          await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = () => j(new Error("decode fail")); });
          v.currentTime = Math.max(0, v.duration / 2);
          await new Promise((r, j) => { v.onseeked = r; v.onerror = () => j(new Error("seek fail")); });
          await new Promise((r) => setTimeout(r, 40));
          const c = document.createElement("canvas"); c.width = 64; c.height = 36;
          const cx = c.getContext("2d", { willReadFrequently: true });
          cx.drawImage(v, 0, 0, 64, 36);
          sample = Array.from(cx.getImageData(0, 0, 64, 36).data);
          meta = { bytes: res.blob.size, w: v.videoWidth, h: v.videoHeight, dur: +v.duration.toFixed(3) };
        } finally { URL.revokeObjectURL(url); }
      }
    } catch (e) { err = String(e); }
    return { ok, err, totalMs: +(performance.now() - t0).toFixed(1), meta, sample };
  }, { mainId: built.mainId, n: FRAMES, multi: multiCtx, ctx: ctxCount });
}

const singleWalls = [], multiWalls = [];
let sampleDiff = null, mp4Ok = true;
for (let p = 0; p < PAIRS; p++) {
  const a = await mp4Run(false, CTX);
  const b = await mp4Run(true, CTX);
  singleWalls.push(a.totalMs); multiWalls.push(b.totalMs);
  mp4Ok = mp4Ok && a.ok && b.ok;
  if (a.sample && b.sample) {
    let maxAbs = 0, sum = 0;
    for (let i = 0; i < a.sample.length; i++) { const d = Math.abs(a.sample[i] - b.sample[i]); maxAbs = Math.max(maxAbs, d); sum += d; }
    const mae = sum / a.sample.length;
    if (!sampleDiff || maxAbs > sampleDiff.maxAbs) sampleDiff = { maxAbs, mae: +mae.toFixed(3) };
  }
  console.log(`mp4 pair ${p + 1}: single=${a.totalMs}ms multi=${b.totalMs}ms ok=${a.ok && b.ok}`);
}
const median = (arr) => { const x = [...arr].sort((m, n) => m - n); return x[Math.floor(x.length / 2)]; };
const sMed = median(singleWalls), mMed = median(multiWalls);
const improvePct = +(((sMed - mMed) / sMed) * 100).toFixed(1);

const result = {
  when: new Date().toISOString(),
  note: "Phase 6 multi-render-context — PNG per-frame parity + mp4 wall A/B",
  frames: FRAMES, contextCount: CTX, pairs: PAIRS,
  pngParity: { ok: parityOk, mismatches, firstMismatch, dist: multi.dist, singleWallMs: single.totalMs, multiWallMs: multi.totalMs },
  mp4: { ok: mp4Ok, singleWalls, multiWalls, singleMedianMs: sMed, multiMedianMs: mMed, improvePct, sampleDiff },
  pageErrors: pageErrors.slice(0, 5),
};
writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log("\n=== SUMMARY ===");
console.log(`PNG per-frame parity: ${parityOk ? "PASS" : "FAIL"} (mismatches=${mismatches})`);
console.log(`mp4 wall: single median ${sMed}ms → multi median ${mMed}ms (${improvePct >= 0 ? "-" : "+"}${Math.abs(improvePct)}%)`);
console.log(`mp4 sample diff (single vs multi): ${JSON.stringify(sampleDiff)}`);
console.log(`mp4 encode ok (headless では WebCodecs mp4 は png-seq へフォールバックし false になりうる): ${mp4Ok}`);
console.log(`pageErrors: ${pageErrors.length}`);
console.log("wrote", OUT);
await browser.close();
// 正準ゲートは PNG per-frame parity（INV-2）と pageErrors。mp4 encode は headless で
// フォールバックしうるため exit code には含めない（wall は情報として記録）。
process.exit(parityOk && pageErrors.length === 0 ? 0 : 1);
