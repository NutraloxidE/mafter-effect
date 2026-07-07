// Phase 2.5 e2e 検証: 実データ（Comp 32 の Person split alpha アセット）を
// convertSplitAssetToPacked() で実際に変換し、
// (1) 変換後 asset.meta が正しい packed 形式であること
// (2) 元の split ファイル（color/alpha webm）が FS に残っている（非破壊）こと
// (3) 変換後レイヤーが split 版と視覚的に一致する（Phase1/2 と同じ較正済み許容差）こと
// (4) fps 解決に失敗するケース（参照レイヤー無し）で変換がスキップされること
// (5) メモリ上限超過時に変換が拒否されること
// を headed 実 Chrome（WebCodecs encode のため）で確認する。
import { chromium } from "playwright";
import path from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `http://localhost:${PORT}/`;
const ZIP = path.resolve("verify-comp32-mini-project.zip");

const COMP32 = "01KWSRT0CQGZKJ0FNKEAD41F7M";
const PERSON_LAYER = "01KWSS67VPCYTP5XKWPN1BP0EP";
const PERSON_ASSET = "01KWSS67VPRA5KE4HWC42D5AKG";
const FRAME = 60;

const browser = await chromium.launch({ headless: false, channel: "chrome" }).catch(() =>
  chromium.launch({ headless: false }),
);
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

await page.evaluate((compId) => window.__mafterEditorStore.getState().setCurrentComp(compId), COMP32);
await page.waitForTimeout(500);

console.log("--- (4) fps resolution failure for an unreferenced asset ---");
const fpsForOrphan = await page.evaluate(async () => {
  const { resolveConversionFps } = await import("/src/editor/subjectExtract/convertSplitToPacked.ts");
  const st = window.__mafterEditorStore.getState();
  return resolveConversionFps(st.project, "no-such-asset-id");
});
console.log("resolveConversionFps(orphan) =", fpsForOrphan, "(expect null)");

console.log("--- (4b) fps resolution success for the real Person asset ---");
const fpsForPerson = await page.evaluate(
  async (assetId) => {
    const { resolveConversionFps } = await import("/src/editor/subjectExtract/convertSplitToPacked.ts");
    const st = window.__mafterEditorStore.getState();
    return resolveConversionFps(st.project, assetId);
  },
  PERSON_ASSET,
);
console.log("resolveConversionFps(person) =", fpsForPerson, "(expect 30)");

console.log("--- (5) memory cap rejects an oversized synthetic asset ---");
const capResult = await page.evaluate(async () => {
  const { estimatePackedConversionBytes, MAX_PACKED_CONVERT_BYTES } = await import(
    "/src/editor/subjectExtract/convertSplitToPacked.ts"
  );
  // 30fps x 60s x 1080p 相当（Opus review の OOM 例）
  const bytes = estimatePackedConversionBytes(1800, 1920, 1080, 8);
  return { bytes, max: MAX_PACKED_CONVERT_BYTES, exceeds: bytes > MAX_PACKED_CONVERT_BYTES };
});
console.log("cap check:", capResult, "(expect exceeds=true)");

console.log("--- record original split file bytes (non-destructive check baseline) ---");
const before = await page.evaluate(async (assetId) => {
  const st = window.__mafterEditorStore.getState();
  const asset = st.project.assets.find((a) => a.id === assetId);
  const fs = st.getFs();
  const colorBytes = (await fs.read(asset.path)).length;
  const alphaBytes = (await fs.read(asset.meta.alphaPath)).length;
  return { path: asset.path, alphaPath: asset.meta.alphaPath, colorBytes, alphaBytes };
}, PERSON_ASSET);
console.log("original split files:", before);

console.log("--- (1)(2) running convertSplitAssetToPacked on the real Person asset ---");
const conv = await page.evaluate(
  async ({ assetId, fps }) => {
    const { convertSplitAssetToPacked, isConvertError } = await import(
      "/src/editor/subjectExtract/convertSplitToPacked.ts"
    );
    const st = window.__mafterEditorStore.getState();
    const result = await convertSplitAssetToPacked(st.project, st.getFs(), assetId, fps);
    if (isConvertError(result)) return { error: result.error };
    return { asset: result.asset };
  },
  { assetId: PERSON_ASSET, fps: fpsForPerson },
);
console.log("conversion result:", JSON.stringify(conv, null, 1));

if (conv.error) {
  console.error("FAIL: conversion errored:", conv.error);
  await browser.close();
  process.exit(1);
}

console.log("--- (2) non-destructive check: original split files must still be readable/unchanged ---");
const after = await page.evaluate(
  async ({ path: p, alphaPath }) => {
    const st = window.__mafterEditorStore.getState();
    const fs = st.getFs();
    const colorBytes = (await fs.read(p)).length;
    const alphaBytes = (await fs.read(alphaPath)).length;
    return { colorBytes, alphaBytes };
  },
  before,
);
console.log("original split files after conversion:", after);
const nonDestructive = after.colorBytes === before.colorBytes && after.alphaBytes === before.alphaBytes;
console.log("non-destructive:", nonDestructive, "(expect true)");

console.log("--- (1) meta field check ---");
const metaOk =
  conv.asset.meta.alphaMode === "packed" &&
  conv.asset.meta.packedLayout === "topBottom" &&
  typeof conv.asset.meta.contentHeight === "number" &&
  typeof conv.asset.meta.gutterPx === "number" &&
  conv.asset.meta.convertedFrom === PERSON_ASSET;
console.log("packed meta valid:", metaOk);

console.log("--- (3) mount converted layer + compare against split original ---");
const setup = await page.evaluate(
  async ({ compId, sourceLayerId, newAssetId, newAsset }) => {
    const st = window.__mafterEditorStore.getState();
    const before2 = st.project;
    const comp = before2.compositions.find((c) => c.id === compId);
    const sourceLayer = comp.objects.find((o) => o.id === sourceLayerId);
    const clonedId = crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();
    const cloned = {
      ...sourceLayer,
      id: clonedId,
      name: "packed-converted-test",
      zOrder: comp.objects.reduce((m, o) => Math.max(m, o.zOrder), 0) + 1,
      components: sourceLayer.components.map((c) =>
        c.type === "video" ? { ...c, props: { ...c.props, asset: newAssetId } } : c,
      ),
    };
    const after2 = {
      ...before2,
      assets: before2.assets.some((a) => a.id === newAssetId) ? before2.assets : [...before2.assets, newAsset],
      compositions: before2.compositions.map((c) =>
        c.id === compId ? { ...c, objects: [...c.objects, cloned] } : c,
      ),
    };
    st.applyCommand({ label: "verify: mount converted packed layer", before: before2, after: after2 });
    return { clonedId };
  },
  { compId: COMP32, sourceLayerId: PERSON_LAYER, newAssetId: conv.asset.id, newAsset: conv.asset },
);

// ImageAssetCache は project 変更を検知する React effect（PreviewPanel）で非同期に
// loadFromProject() し直す。新規追加した packed asset の blob URL が video.src に載るまで待つ。
await page.waitForFunction(
  (objId) => {
    const v = document.querySelector(`[data-object-id="${objId}"] video`);
    return !!v && v.getAttribute("src") && v.getAttribute("src") !== "";
  },
  setup.clonedId,
  { timeout: 15000, polling: 200 },
).catch(() => console.warn("WARN: video src did not populate in time"));

await page.waitForTimeout(500);
await page.evaluate((f) => window.__mafterEditorStore.getState().setFrame(f), FRAME);

async function settleAndSampleCanvas(objId, canvasClass) {
  const sel = `[data-object-id="${objId}"] canvas.${canvasClass}`;
  try {
    await page.waitForSelector(sel, { timeout: 10000 });
  } catch (e) {
    console.error("DEBUG page errors:", errors);
    const html = await page.evaluate((s) => document.querySelector(s)?.outerHTML ?? "NOT FOUND", `[data-object-id="${objId}"]`);
    console.error("DEBUG object outerHTML:", html);
    throw e;
  }
  await page.waitForFunction(
    (s) => {
      const c = document.querySelector(s);
      if (!c || c.width === 0) return false;
      const off = document.createElement("canvas");
      off.width = c.width; off.height = c.height;
      const octx = off.getContext("2d");
      octx.drawImage(c, 0, 0);
      const d = octx.getImageData(Math.floor(c.width / 2), Math.floor(c.height * 0.7), 1, 1).data;
      return d[3] !== undefined;
    },
    sel,
    { timeout: 15000, polling: 100 },
  ).catch(() => {});
  await page.waitForTimeout(500);
  return page.evaluate((s) => {
    const c = document.querySelector(s);
    const w = c.width, h = c.height;
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const octx = off.getContext("2d");
    octx.drawImage(c, 0, 0);
    const grid = 24;
    const out = [];
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const x = Math.min(w - 1, Math.floor((gx + 0.5) * w / grid));
        const y = Math.min(h - 1, Math.floor((gy + 0.5) * h / grid));
        out.push([...octx.getImageData(x, y, 1, 1).data]);
      }
    }
    return { w, h, samples: out };
  }, sel);
}

const splitSamples = await settleAndSampleCanvas(PERSON_LAYER, "mafter-split-alpha-canvas");
const packedSamples = await settleAndSampleCanvas(setup.clonedId, "mafter-packed-alpha-canvas");
console.log("split canvas size:", splitSamples.w, splitSamples.h);
console.log("packed canvas size:", packedSamples.w, packedSamples.h);

// §2.4 の代償として明記済み: 変換は元の色/マスクをもう1回 lossy 再エンコードする（世代劣化1回）。
// Phase1/2 の較正値（alpha ±1）は「同一ファイルを decode 経路違いで比較」用で、ここは
// 「別ファイル（元split vs 再エンコードpacked）を比較」なので、再圧縮由来の数LSBを許容する
// ±6 を使う（実測: 再エンコード後の diff は最大3/255 だった）。
const ALPHA_TOLERANCE = 6;
const PREMULT_RGB_TOLERANCE = 25;
const failureDetails = [];
const n = Math.min(splitSamples.samples.length, packedSamples.samples.length);
for (let i = 0; i < n; i++) {
  const a = splitSamples.samples[i];
  const b = packedSamples.samples[i];
  const alphaDiff = Math.abs(a[3] - b[3]);
  if (alphaDiff > ALPHA_TOLERANCE) {
    failureDetails.push({ i, reason: "alpha", diff: alphaDiff, split: a, packed: b });
    continue;
  }
  const alpha = Math.min(a[3], b[3]);
  for (let c = 0; c < 3; c++) {
    const premult = Math.abs(a[c] - b[c]) * (alpha / 255);
    if (premult > PREMULT_RGB_TOLERANCE) {
      failureDetails.push({ i, c, reason: "rgb-premult", diff: +premult.toFixed(2), split: a, packed: b });
    }
  }
}
const failures = failureDetails.length;
console.log(`visual parity failures: ${failures} / ${n * 4}`);
console.log("failure details:", JSON.stringify(failureDetails, null, 1));

const canvasEl = await page.$(`[data-object-id="${setup.clonedId}"] canvas.mafter-packed-alpha-canvas`);
await canvasEl.screenshot({ path: path.resolve("probe-convert-split-to-packed.png") });

console.log("page errors:", errors);

const pass =
  fpsForOrphan === null &&
  fpsForPerson === 30 &&
  capResult.exceeds === true &&
  !conv.error &&
  nonDestructive &&
  metaOk &&
  failures === 0;

console.log(pass ? "\nPASS: split→packed conversion e2e" : "\nFAIL: see details above");

await browser.close();
process.exit(pass ? 0 : 1);
