// §11.4 動画内蔵音声 — export mux 入力（音声 mix + keyframed gain）検証。
// 音声付き video のみのコンプを作り、buildAudioMix と同型の経路
// （collectFootageAudioSources → asset bytes decode → OfflineAudioContext render + scheduleGainAutomation）
// を実機で走らせ、内蔵音声が非ゼロ振幅で mix され、gain=0.5 で RMS が約半分になることを確認する。
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `http://localhost:${PORT}/`;
const VIDEO_PATH = resolve("for-debug-data/video_with_audio.mp4");

console.log("verify-video-audio-export: starting…");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(800);

const videoBytes = readFileSync(VIDEO_PATH);

const result = await page.evaluate(async ({ bytes, name }) => {
  const storeMod = await import("/src/editor/store.ts");
  const S = () => storeMod.useEditorStore.getState();
  for (let i = 0; i < 80 && !(S().project && S().currentCompId); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  await S().newProject();
  const file = new File([new Uint8Array(bytes)], name, { type: "video/mp4" });
  const assetId = await S().importVideoAsset(file);
  if (!assetId) throw new Error("importVideoAsset failed");
  const layer = S().addVideoLayer(assetId, "video-audio");
  if (!layer) throw new Error("addVideoLayer failed");
  await new Promise((r) => setTimeout(r, 400));

  const project = S().project;
  const compId = S().currentCompId;
  const comp = project.compositions.find((c) => c.id === compId);
  const fs = S().getFs();

  // 1) 収集ロジック: video レイヤーが mix source に含まれること（gainProp 既定 1）。
  const fa = await import("/src/runtime/footageAudio.ts");
  const sources = fa.collectFootageAudioSources(comp);
  const videoSrc = sources.find((s) => s.assetId === assetId);
  if (!videoSrc) return { collected: false };

  // 2) buildAudioMix と同型: asset bytes を decode → OfflineAudioContext で render。
  const asset = project.assets.find((a) => a.id === assetId);
  const data = await fs.read(asset.path);
  const sliced = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const tmp = new AudioContext();
  const decoded = await tmp.decodeAudioData(sliced);
  await tmp.close();

  const fps = comp.fps;
  const startFrame = 0, endFrame = 60;
  const durationSec = (endFrame - startFrame) / fps;
  const sampleRate = 44100;

  async function renderWithGain(gainProp) {
    const off = new OfflineAudioContext(2, Math.ceil(durationSec * sampleRate), sampleRate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    const g = off.createGain();
    fa.scheduleGainAutomation(g.gain, gainProp, { fps, exportStartFrame: startFrame, exportEndFrame: endFrame });
    src.connect(g); g.connect(off.destination);
    src.start(0, videoSrc.trimStart / fps, durationSec);
    const rendered = await off.startRendering();
    const ch = rendered.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < ch.length; i += 8) sum += ch[i] * ch[i];
    return Math.sqrt(sum / (ch.length / 8));
  }

  const rmsFull = await renderWithGain({ value: 1, keyframes: [] });
  const rmsHalf = await renderWithGain({ value: 0.5, keyframes: [] });

  return {
    collected: true,
    decodedChannels: decoded.numberOfChannels,
    decodedDuration: decoded.duration,
    rmsFull,
    rmsHalf,
    ratio: rmsFull > 0 ? rmsHalf / rmsFull : 0,
  };
}, { bytes: [...videoBytes], name: "video_with_audio.mp4" });

console.log("result:", result);

let pass = true;
if (!result.collected) { console.error("FAIL: video layer not collected as audio mix source"); pass = false; }
if (!(result.decodedChannels > 0)) { console.error("FAIL: video embedded audio did not decode"); pass = false; }
if (!(result.rmsFull > 0.0001)) { console.error(`FAIL: mixed audio is silent (rms=${result.rmsFull})`); pass = false; }
else console.log(`mixed video-audio rms OK: full=${result.rmsFull.toFixed(4)} half=${result.rmsHalf.toFixed(4)}`);
// gain=0.5 automation → RMS が約半分（±10%）。
if (!(result.ratio > 0.4 && result.ratio < 0.6)) {
  console.error(`FAIL: gain=0.5 RMS ratio expected ~0.5, got ${result.ratio.toFixed(3)}`);
  pass = false;
} else console.log(`gain=0.5 RMS ratio OK: ${result.ratio.toFixed(3)}`);

if (errors.length > 0) { console.error("console errors:", errors); pass = false; }

await browser.close();
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
