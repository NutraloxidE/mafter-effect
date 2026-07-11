// Phase 検証: packed proxy 生成後の再生ドリフト実機計測（Comp 32・修正後の効果確認）
// PreviewPanel の idle-trigger（Phase 6）が自動で packed proxy を生成するのを待ってから再生する
// ＝ 実際のユーザー操作（comp を開く→少し待つ→Play）に忠実なエンドツーエンド検証。
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
const PACKED_ASSET_ID = "01KWYFTPG6730SSPJXD2RAPVAM";
const SAMPLE_MS = 8000;

const browser = await chromium.launch({
  headless: true,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--ignore-certificate-errors",
    "--disable-dev-shm-usage",
    // WebCodecs VideoEncoder は既定 GL backend だと headless で即クラッシュする（memory: runtime-verify-harness）。
    "--use-gl=angle",
    "--use-angle=swiftshader",
  ],
});
const page = await browser.newPage({ ignoreHTTPSErrors: true });
page.setDefaultTimeout(120000);
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
page.on("crash", () => console.log("[PAGE CRASHED]"));
page.on("close", () => console.log("[PAGE CLOSED]"));
browser.on("disconnected", () => console.log("[BROWSER DISCONNECTED]"));
page.on("console", (m) => {
  const t = m.text();
  if (!t.includes("mafter") && m.type() !== "error") return;
  Promise.all(m.args().map((a) => a.jsonValue().catch(() => "<unserializable>"))).then((vals) => {
    console.log("[console]", m.type(), ...vals);
  });
});

await page.route("**/__fixture_project.json", (route) => route.fulfill({ path: PROJECT_JSON_PATH }));
await page.route("**/__fixture_video.mp4", (route) => route.fulfill({ path: VIDEO_MP4_PATH }));
await page.route("**/__fixture_packed.webm", (route) => route.fulfill({ path: PACKED_WEBM_PATH }));

await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => window.__mafterEditorStore?.getState().getFs, { timeout: 20000 });

console.log("Writing lean fixture into FS + loading project...");
const loadResult = await page.evaluate(async () => {
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
  const p = window.__mafterEditorStore.getState().project;
  return { ok: !!p, hasComp32: p?.compositions.some((c) => c.id === "01KWSRT0CQGZKJ0FNKEAD41F7M") ?? false };
});
console.log(JSON.stringify(loadResult, null, 2));
if (!loadResult.ok || !loadResult.hasComp32) {
  console.log("FAILED to load project / find Comp32");
  await browser.close();
  process.exit(1);
}

console.log("Switching to Comp 32 (this should trigger the PreviewPanel idle packed-proxy effect)...");
await page.evaluate((compId) => {
  const st = window.__mafterEditorStore.getState();
  st.setCurrentComp(compId);
  st.setFrame(0);
}, COMP32_ID);

await page.waitForFunction(
  (objId) => !!document.querySelector(`[data-object-id="${objId}"]`),
  PACKED_OBJ_ID,
  { timeout: 15000 },
);

console.log("Waiting for automatic packed proxy generation (idle-trigger, Phase 6)...");
const proxyWaitStart = Date.now();
await page.waitForFunction(
  (assetId) => {
    const p = window.__mafterEditorStore.getState().project;
    const asset = p?.assets.find((a) => a.id === assetId);
    const proxies = asset?.meta?.proxies;
    return !!proxies && typeof proxies === "object" && "low" in proxies;
  },
  PACKED_ASSET_ID,
  { timeout: 90000, polling: 500 },
);
console.log(`auto proxy generation observed after ${((Date.now() - proxyWaitStart) / 1000).toFixed(1)}s`);

const proxyMeta = await page.evaluate((assetId) => {
  const asset = window.__mafterEditorStore.getState().project?.assets.find((a) => a.id === assetId);
  return asset?.meta?.proxies ?? null;
}, PACKED_ASSET_ID);
console.log("meta.proxies:", JSON.stringify(proxyMeta, null, 2));

console.log("Nudging frame (0->1->0) to force a fresh render pass (diagnostic)...");
await page.evaluate(() => {
  const st = window.__mafterEditorStore.getState();
  st.setFrame(1);
});
await page.waitForTimeout(200);
await page.evaluate(() => {
  window.__mafterEditorStore.getState().setFrame(0);
});
await page.waitForTimeout(500);
const afterNudge = await page.evaluate((objId) => {
  const host = document.querySelector(`[data-object-id="${objId}"]`);
  const v = host?.querySelector("video");
  return v ? { src: v.currentSrc || v.src, w: v.videoWidth, h: v.videoHeight } : null;
}, PACKED_OBJ_ID);
console.log("after frame nudge:", JSON.stringify(afterNudge));

// video の src が proxy blob に差し替わる（videoHeight が原本の 2284 未満に落ちる）まで待つ。
// 30秒、2秒間隔でスナップショットを取りながら待つ（切り替わりのタイミング/有無を診断する）。
let switched = false;
for (let i = 0; i < 15; i++) {
  const snap = await page.evaluate((objId) => {
    const host = document.querySelector(`[data-object-id="${objId}"]`);
    const v = host?.querySelector("video");
    return v ? { src: v.currentSrc || v.src, w: v.videoWidth, h: v.videoHeight, rs: v.readyState } : null;
  }, PACKED_OBJ_ID);
  console.log(`  t+${i * 2}s snapshot:`, JSON.stringify(snap));
  if (snap && snap.h > 0 && snap.h < 2000) {
    switched = true;
    console.log("proxy video mounted (videoHeight < 2000) — cache picked up the new proxy");
    break;
  }
  await page.waitForTimeout(2000);
}
if (!switched) {
  console.log("WARNING: video did not switch to a smaller (proxy) resolution within 30s");
}
await page.waitForTimeout(300);

const videoDims = await page.evaluate((objId) => {
  const host = document.querySelector(`[data-object-id="${objId}"]`);
  const video = host?.querySelector("video");
  return video
    ? { src: video.currentSrc || video.src, videoWidth: video.videoWidth, videoHeight: video.videoHeight }
    : null;
}, PACKED_OBJ_ID);
console.log("mounted packed <video> before playback:", JSON.stringify(videoDims, null, 2));

console.log("Starting playback + sampling...");
const samples = await page.evaluate(
  async ({ objId, sampleMs }) => {
    const out = [];
    const t0 = performance.now();
    function findPackedVideo() {
      const host = document.querySelector(`[data-object-id="${objId}"]`);
      if (!host) return null;
      return host.querySelector("video");
    }
    window.__mafterEditorStore.getState().setPlaying(true);
    return await new Promise((resolve) => {
      function tick() {
        const now = performance.now();
        const video = findPackedVideo();
        const liveFrame = window.__mafterEditorStore.getState().currentFrame;
        if (video) {
          const q = typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
          out.push({
            wallMs: Math.round(now - t0),
            frame: liveFrame,
            currentTime: video.currentTime,
            targetSec: video.dataset.mafterTargetSec ? Number(video.dataset.mafterTargetSec) : null,
            readyState: video.readyState,
            dropped: q ? q.droppedVideoFrames : null,
            total: q ? q.totalVideoFrames : null,
          });
        } else {
          out.push({ wallMs: Math.round(now - t0), frame: liveFrame, missing: true });
        }
        if (now - t0 < sampleMs) requestAnimationFrame(tick);
        else resolve(out);
      }
      requestAnimationFrame(tick);
    });
  },
  { objId: PACKED_OBJ_ID, sampleMs: SAMPLE_MS },
);

await browser.close();

const withTarget = samples.filter((s) => s.targetSec !== null && s.targetSec !== undefined);
console.log(`total samples: ${samples.length}, with target: ${withTarget.length}`);

const lagSeries = withTarget.map((s) => ({
  wallMs: s.wallMs,
  frame: s.frame,
  lag: s.targetSec - s.currentTime,
  dropped: s.dropped,
  total: s.total,
}));

console.log("\n-- lag series (every 15th sample) --");
lagSeries.forEach((s, i) => {
  if (i % 15 === 0) {
    console.log(`t=${s.wallMs}ms frame=${s.frame} lag=${(s.lag * 1000).toFixed(1)}ms dropped=${s.dropped}/${s.total}`);
  }
});

const maxLag = lagSeries.length ? Math.max(...lagSeries.map((s) => s.lag)) : NaN;
const lastFrame = lagSeries.at(-1)?.frame ?? 0;
const lastWallMs = lagSeries.at(-1)?.wallMs ?? 0;
const lastDropped = lagSeries.at(-1)?.dropped ?? null;
const lastTotal = lagSeries.at(-1)?.total ?? null;
const late = lagSeries.filter((s) => s.wallMs > 3500);
const lateAvgLag = late.length ? late.reduce((a, s) => a + s.lag, 0) / late.length : null;

console.log("\n-- summary (AFTER packed proxy fix, via auto idle-trigger) --");
console.log("max lag (s):", maxLag.toFixed(3));
console.log("avg lag after 3.5s wall time (s):", lateAvgLag?.toFixed(3));
console.log("dropped/total frames (getVideoPlaybackQuality):", lastDropped, "/", lastTotal);
console.log(`timeline progress: frame=${lastFrame} (${(lastFrame / 30).toFixed(2)}s of content) in ${(lastWallMs / 1000).toFixed(2)}s wall time`);
console.log(
  "verdict:",
  lastFrame / 30 >= (lastWallMs / 1000) * 0.85
    ? "REAL-TIME PLAYBACK RESTORED (timeline keeps pace with wall clock)"
    : "STILL DECODE-BOUND (timeline lags wall clock significantly)",
);
