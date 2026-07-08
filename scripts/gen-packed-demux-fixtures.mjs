// One-off fixture generator (not a verify script) for test/fixtures/packedDemux*.
// Encodes short synthetic packed-alpha videos with the app's real encoder
// (encodeRgbaFramesToPackedVideo) in a real headed Chrome, then writes the raw
// bytes to disk so vitest (plain Node env, no WebCodecs) can demux them statically.
// Run once when regenerating fixtures; not part of the normal test/build pipeline.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5175";
const URL = `http://localhost:${PORT}/`;
const FIXTURES_DIR = path.resolve("test/fixtures");
fs.mkdirSync(FIXTURES_DIR, { recursive: true });

const browser = await chromium.launch({ headless: false, channel: "chrome" }).catch(() =>
  chromium.launch({ headless: false }),
);
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("page error:", m.text()); });
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });

async function encodeFixture({ width, height, fps, frameCount }) {
  return await page.evaluate(async ({ width, height, fps, frameCount }) => {
    const { encodeRgbaFramesToPackedVideo } = await import("/src/editor/subjectExtract/encodeAlphaWebm.ts");
    const frames = [];
    for (let i = 0; i < frameCount; i++) {
      const rgba = new Uint8ClampedArray(width * height * 4);
      // 各フレームで一意な color+alpha パターン（frame index を復元できるようにする）。
      const r = (i * 7) % 256;
      const g = (i * 13) % 256;
      const b = (i * 29) % 256;
      const a = 32 + ((i * 5) % 200);
      for (let p = 0; p < width * height; p++) {
        rgba[p * 4] = r;
        rgba[p * 4 + 1] = g;
        rgba[p * 4 + 2] = b;
        rgba[p * 4 + 3] = a;
      }
      frames.push({ width, height, rgba });
    }
    const result = await encodeRgbaFramesToPackedVideo(frames, fps, null);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < result.bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...result.bytes.subarray(i, i + chunkSize));
    }
    return {
      bytesBase64: btoa(binary),
      container: result.container,
      layout: result.layout,
    };
  }, { width, height, fps, frameCount });
}

// GOP=30 の keyframe パターン（index 0 と 30 の倍数）を1つ超えて確認できる最小限のフレーム数。
const FRAME_COUNT = 33;

// 小さい解像度: この機の VideoEncoder が H.264 を通しやすい（mp4 経路の fixture 用）。
const small = await encodeFixture({ width: 16, height: 16, fps: 30, frameCount: FRAME_COUNT });
console.log("small fixture container:", small.container, "layout:", JSON.stringify(small.layout));

// 大きい解像度（実データと同様 640x1138 相当）: この機では H.264 config が unsupported になり
// VP9/webm へフォールバックする（Phase 0 実測と同じ環境事象）ため webm 経路の fixture として使う。
const large = await encodeFixture({ width: 640, height: 1138, fps: 30, frameCount: FRAME_COUNT });
console.log("large fixture container:", large.container, "layout:", JSON.stringify(large.layout));

function writeFixture(name, result) {
  const bytes = Buffer.from(result.bytesBase64, "base64");
  const ext = result.container === "mp4" ? "mp4" : "webm";
  const filePath = path.join(FIXTURES_DIR, `${name}.${ext}`);
  fs.writeFileSync(filePath, bytes);
  fs.writeFileSync(
    path.join(FIXTURES_DIR, `${name}.meta.json`),
    JSON.stringify({ container: result.container, layout: result.layout, fps: 30, frameCount: FRAME_COUNT }, null, 2),
  );
  console.log("wrote", filePath, bytes.length, "bytes");
}

if (small.container !== "mp4") {
  console.warn("WARN: small fixture did not encode to mp4 (H.264 unsupported on this machine) — writing as", small.container);
}
writeFixture(small.container === "mp4" ? "packedDemuxFixture-mp4" : "packedDemuxFixture-mp4-fallback", small);
writeFixture("packedDemuxFixture-webm", large);

await browser.close();
