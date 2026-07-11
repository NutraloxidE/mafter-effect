// 実機検証: WebCodecs (VideoEncoder) が無い環境で packed alpha レイヤーが
// (a) Inspector に警告バナーを出す、(b) 透明にならず原本のまま表示され続ける、
// (c) idle トリガの evict-before-generate バグが直っていること（video の src が空にならない）
// を確認する。
import { chromium } from "playwright";
import path from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5173";
const APP_URL = `https://localhost:${PORT}/`;
const LEAN_DIR =
  "C:/Users/resis/AppData/Local/Temp/claude/c--Workspace-mafter-effect/1eeddf04-70a7-4e59-bdaa-3026ed2331ea/scratchpad";
const PROJECT_JSON_PATH = path.join(LEAN_DIR, "pj22", "project.json");
const VIDEO_MP4_PATH = path.join(LEAN_DIR, "pj22-lean", "01KWR47Y1AJ3GNX9Q7XK7KT8K7.mp4");
const PACKED_WEBM_PATH = path.join(LEAN_DIR, "pj22-lean", "01KWYFTPG6730SSPJXD2RAPVAM.webm");

const COMP32_ID = "01KWSRT0CQGZKJ0FNKEAD41F7M";
const PACKED_OBJ_ID = "01KWSS67VPCYTP5XKWPN1BP0EP";

const browser = await chromium.launch({
  headless: true,
  args: ["--ignore-certificate-errors", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage({ ignoreHTTPSErrors: true });
page.setDefaultTimeout(60000);
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));

// WebCodecs を「無い」環境として振る舞わせる — アプリの全スクリプト評価前に VideoEncoder を消す。
await page.addInitScript(() => {
  // @ts-ignore
  delete window.VideoEncoder;
  // @ts-ignore
  delete window.VideoFrame;
});

await page.route("**/__fixture_project.json", (route) => route.fulfill({ path: PROJECT_JSON_PATH }));
await page.route("**/__fixture_video.mp4", (route) => route.fulfill({ path: VIDEO_MP4_PATH }));
await page.route("**/__fixture_packed.webm", (route) => route.fulfill({ path: PACKED_WEBM_PATH }));

await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => window.__mafterEditorStore?.getState().getFs, { timeout: 20000 });

const hasVideoEncoder = await page.evaluate(() => typeof window.VideoEncoder !== "undefined");
console.log("VideoEncoder present (should be false):", hasVideoEncoder);

await page.evaluate(async () => {
  const st = window.__mafterEditorStore.getState();
  const fsInst = st.getFs();
  const [projectText, mp4Buf, webmBuf] = await Promise.all([
    fetch("/__fixture_project.json").then((r) => r.text()),
    fetch("/__fixture_video.mp4").then((r) => r.arrayBuffer()),
    fetch("/__fixture_packed.webm").then((r) => r.arrayBuffer()),
  ]);
  await fsInst.write("project.json", projectText);
  await fsInst.write("assets/01KWR47Y1AJ3GNX9Q7XK7KT8K7.mp4", new Uint8Array(mp4Buf));
  await fsInst.write("assets/01KWYFTPG6730SSPJXD2RAPVAM.webm", new Uint8Array(webmBuf));
  await window.__mafterEditorStore.getState().loadFromFs();
});

await page.evaluate((compId) => {
  const st = window.__mafterEditorStore.getState();
  st.setCurrentComp(compId);
  st.setFrame(30);
}, COMP32_ID);

await page.waitForFunction(
  (objId) => !!document.querySelector(`[data-object-id="${objId}"]`),
  PACKED_OBJ_ID,
  { timeout: 15000 },
);

// idle トリガ（requestIdleCallback ~200ms fallback）が発火するのを待つ。
await page.waitForTimeout(3000);

// 修正確認 (b)(c): video の src が空になっていない = 透明になっていないこと。
const videoState = await page.evaluate((objId) => {
  const el = document.querySelector(`[data-object-id="${objId}"] video`);
  if (!el) return { found: false };
  return {
    found: true,
    hasSrc: !!el.getAttribute("src") && el.getAttribute("src") !== "",
    readyState: el.readyState,
    videoWidth: el.videoWidth,
    videoHeight: el.videoHeight,
  };
}, PACKED_OBJ_ID);
console.log("packed <video> element state (should have non-empty src):", JSON.stringify(videoState, null, 2));

// select the packed layer in the store so Inspector shows it.
await page.evaluate((objId) => {
  window.__mafterEditorStore.getState().setSelection?.([objId]) ??
    window.__mafterEditorStore.setState({ selectedObjectIds: [objId] });
}, PACKED_OBJ_ID);
await page.waitForTimeout(500);

const foldoutClicked = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll("button")];
  const btn = buttons.find((b) => b.textContent?.trim().startsWith("Video") || b.textContent?.includes("▶ Video") || b.textContent?.includes("▼ Video"));
  if (btn) { btn.click(); return true; }
  return false;
});
console.log("video foldout button clicked:", foldoutClicked);
await page.waitForTimeout(300);

// 修正確認 (a): 警告バナーが出ていること。
const domCheck = await page.evaluate(() => {
  const body = document.body.innerText;
  return {
    hasWebCodecsWarning: body.includes("WebCodecs"),
    hasPreviewQualityLabel: body.includes("Preview Quality"),
    hasExportQualityLabel: body.includes("Export Quality"),
    hasExportNote: body.includes("mp4 / webm / PNG"),
  };
});
console.log("DOM check:", JSON.stringify(domCheck, null, 2));

// スクリーンショットでレイヤーが実際に見えている（真っ黒/透明でない）ことを目視確認できるよう保存。
await page.screenshot({ path: path.join(LEAN_DIR, "probe-nowebcodecs-preview.png") });
console.log("screenshot saved");

await browser.close();
