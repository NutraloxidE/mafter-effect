// Phase 2（videoDecoder-compiled-leaf plan）— PackedFrameDecoder が任意 frameIndex で正しい
// VideoFrame を返すこと、GOP-back（実 keyframe 位置ベース）が正しく動くこと、そして decoder-path の
// ピクセルが同一ファイル・同一 frameIndex の <video>-seek path と一致することを実ブラウザで確認する。
// mp4/H.264・webm/VP9 の両方の実 fixture（test/fixtures/packedDemuxFixture-*）を対象にする。
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const mp4Meta = JSON.parse(fs.readFileSync(path.resolve("test/fixtures/packedDemuxFixture-mp4.meta.json"), "utf-8"));
const webmMeta = JSON.parse(fs.readFileSync(path.resolve("test/fixtures/packedDemuxFixture-webm.meta.json"), "utf-8"));

const PORT = process.env.VERIFY_PORT ?? "5175";
const URL = `http://localhost:${PORT}/`;

const browser = await chromium.launch({ headless: false, channel: "chrome" }).catch(() =>
  chromium.launch({ headless: false }),
);
const page = await browser.newPage();
const pageErrors = [];
page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.route("**/__fixture-mp4", (route) =>
  route.fulfill({ path: path.resolve("test/fixtures/packedDemuxFixture-mp4.mp4"), contentType: "video/mp4" }),
);
await page.route("**/__fixture-webm", (route) =>
  route.fulfill({ path: path.resolve("test/fixtures/packedDemuxFixture-webm.webm"), contentType: "video/webm" }),
);

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });

async function runFixture(routeUrl, mime, fps, layout) {
  return await page.evaluate(
    async ({ routeUrl, mime, fps, layout }) => {
      const { demuxPackedVideo } = await import("/src/runtime/packedDemux.ts");
      const { createPackedFrameDecoder } = await import("/src/runtime/packedFrameDecoder.ts");
      const { videoSeekTargetSec, waitForVideoFrame } = await import("/src/runtime/videoElementSync.ts");

      const resp = await fetch(routeUrl);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));

      const stream = await demuxPackedVideo(bytes, mime);
      const decoder = await createPackedFrameDecoder(stream, fps);
      if (!decoder) return { error: "createPackedFrameDecoder returned null (isConfigSupported failed?)" };

      const keyframeIndices = stream.chunks.map((c, i) => (c.keyFrame ? i : -1)).filter((i) => i >= 0);

      async function pollFrame(idx, timeoutMs = 5000) {
        const start = performance.now();
        while (performance.now() - start < timeoutMs) {
          const frame = decoder.getFrame(idx);
          if (frame) return frame;
          await new Promise((r) => setTimeout(r, 16));
        }
        return null;
      }

      // packed layout（color/mask 帯）の source rect。videoPackedAlpha.computePackedAlphaRects と同型。
      // PackedEncodedStream は layout を持たない（demux はコンテナ形式のみ関知）ため、
      // fixture 生成時に記録した layout（asset.meta 相当）を呼び出し側から渡す。
      const contentWidth = stream.codedWidth;
      const contentHeight = layout.contentHeight;
      const gutterPx = layout.gutterPx;

      function samplePixel(source, sx, sy, sw, sh) {
        const canvas = document.createElement("canvas");
        canvas.width = 4;
        canvas.height = 4;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(source, sx, sy, sw, sh, 0, 0, 4, 4);
        return Array.from(ctx.getImageData(1, 1, 1, 1).data);
      }

      function sampleBands(source) {
        return {
          color: samplePixel(source, 0, 0, contentWidth, contentHeight),
          mask: samplePixel(source, 0, contentHeight + gutterPx, contentWidth, contentHeight),
        };
      }

      // <video>-seek 経路（既存 INV-2 の正）で同一 frameIndex を取得。
      // waitForVideoFrame（既存 export/motion-track 共有ヘルパ）で decode 完了 + present 待ちまで行う
      // ——`seeked` イベント直後は canvas へ present される前のことがあり、素朴な onseeked 待ちだと
      // 稀に旧フレーム（またはブランク）を drawImage してしまう（実測で発覚）。
      async function videoSeekBands(idx) {
        const video = document.createElement("video");
        video.muted = true;
        video.src = blobUrl;
        await new Promise((resolve, reject) => {
          video.onloadedmetadata = resolve;
          video.onerror = () => reject(new Error("video load error"));
        });
        const targetSec = videoSeekTargetSec(idx / fps, fps);
        video.pause();
        try {
          video.currentTime = targetSec;
        } catch {
          /* best-effort */
        }
        await waitForVideoFrame(video, targetSec);
        const bands = sampleBands(video);
        video.remove();
        return bands;
      }

      function maxChannelDiff(a, b) {
        let max = 0;
        for (let i = 0; i < 3; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
        return max;
      }

      const results = [];
      // GOP境界(0)・GOP末尾付近(29)・次GOP先頭(30,31)・実keyframe列に含まれる非グリッド位置(あれば)を対象。
      const targets = [0, 15, 29, 30, 31].filter((i) => i < stream.frameCount);
      for (const idx of targets) {
        const frame = await pollFrame(idx);
        if (!frame) {
          results.push({ idx, error: "timed out waiting for decoded frame" });
          continue;
        }
        const decoderBands = sampleBands(frame);
        const videoBands = await videoSeekBands(idx);
        results.push({
          idx,
          decoderColor: decoderBands.color,
          decoderMask: decoderBands.mask,
          videoColor: videoBands.color,
          videoMask: videoBands.mask,
          colorDiff: maxChannelDiff(decoderBands.color, videoBands.color),
          maskDiff: maxChannelDiff(decoderBands.mask, videoBands.mask),
        });
      }

      // GOP-back の乱ジャンプ: 先に idx=25 を要求(未visitなfeed)、次にidx=2へ大ジャンプ(reset+reconfigure)。
      const jumpForward = await pollFrame(25);
      const jumpBackward = await pollFrame(2);
      const jumpOk = jumpForward !== null && jumpBackward !== null && !decoder.broken;

      decoder.dispose();
      URL.revokeObjectURL(blobUrl);

      return {
        container: mime,
        keyframeIndices,
        frameCount: stream.frameCount,
        results,
        jumpOk,
        decoderBrokenAfterDispose: decoder.broken,
      };
    },
    { routeUrl, mime, fps, layout },
  );
}

console.log("=== mp4/H.264 fixture ===");
const mp4Result = await runFixture("/__fixture-mp4", "video/mp4", mp4Meta.fps, mp4Meta.layout);
console.log(JSON.stringify(mp4Result, null, 2));

console.log("\n=== webm/VP9 fixture ===");
const webmResult = await runFixture("/__fixture-webm", "video/webm", webmMeta.fps, webmMeta.layout);
console.log(JSON.stringify(webmResult, null, 2));

const COLOR_TOLERANCE = 25; // 既存 GL/CPU parity 基準（premultiplied 差, videoAlphaGl.ts 参照）と同一
const MASK_TOLERANCE = 25;

function assertResult(label, result) {
  const failures = [];
  if (result.error) {
    failures.push(`${label}: ${result.error}`);
    return failures;
  }
  if (!result.jumpOk) failures.push(`${label}: GOP-back jump (25 -> 2) failed or decoder became broken`);
  if (result.decoderBrokenAfterDispose) failures.push(`${label}: decoder reports broken after dispose (unexpected)`);
  for (const r of result.results) {
    if (r.error) {
      failures.push(`${label} frame ${r.idx}: ${r.error}`);
      continue;
    }
    if (r.colorDiff > COLOR_TOLERANCE) {
      failures.push(`${label} frame ${r.idx}: color band diff ${r.colorDiff} > ${COLOR_TOLERANCE} (decoder=${r.decoderColor} video=${r.videoColor})`);
    }
    if (r.maskDiff > MASK_TOLERANCE) {
      failures.push(`${label} frame ${r.idx}: mask band diff ${r.maskDiff} > ${MASK_TOLERANCE} (decoder=${r.decoderMask} video=${r.videoMask})`);
    }
  }
  return failures;
}

const allFailures = [...assertResult("mp4", mp4Result), ...assertResult("webm", webmResult)];

console.log("\npage errors:", pageErrors.length ? pageErrors : "(none)");

if (allFailures.length || pageErrors.length) {
  console.error("\nFAIL:");
  for (const f of allFailures) console.error(" -", f);
  await browser.close();
  process.exit(1);
}

console.log("\nPASS: decoder-path pixels match <video>-seek path within tolerance for both containers; GOP-back jump handled; no console errors.");
await browser.close();
