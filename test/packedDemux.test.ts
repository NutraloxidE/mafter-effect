import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { demuxPackedVideo } from "../src/runtime/packedDemux";

const FIXTURES_DIR = path.resolve(__dirname, "fixtures");

interface FixtureMeta {
  container: "mp4" | "webm";
  layout: { contentHeight: number; gutterPx: number };
  fps: number;
  frameCount: number;
}

function loadFixture(name: string, ext: string): { bytes: Uint8Array; meta: FixtureMeta } {
  const bytes = new Uint8Array(readFileSync(path.join(FIXTURES_DIR, `${name}.${ext}`)));
  const meta = JSON.parse(readFileSync(path.join(FIXTURES_DIR, `${name}.meta.json`), "utf-8")) as FixtureMeta;
  return { bytes, meta };
}

// エンコーダは要求した index（0・30の倍数）以外でも、内容次第（本テストの合成フレームは毎回
// 色が飛ぶため scene-change 相当）で自発的に追加の keyframe を打つことがある（VP9 実測で確認済み）。
// これは仕様上許容される（GOP-back の起点を早めに取るだけで正しさは保たれる）ため、
// 「要求した位置は必ず keyframe である」ことだけを固定し、それ以外を「keyframe でない」とは断定しない。
function expectRequestedKeyframesPresent(chunks: { keyFrame: boolean }[]): void {
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0 || i % 30 === 0) expect(chunks[i]!.keyFrame).toBe(true);
  }
}

// フレームは頭出しの decode 順（= array index）が正であって、demux が復元する timestamp は
// container 依存の丸め誤差を持ちうる（webm は ms 丸め、mp4 も timescale=fps の整数丸め）ため、
// 「index i の chunk のおおよその時刻」であることだけを確認し、byte-exact 一致は要求しない。
function expectMonotonicApproxTimestamps(chunks: { timestamp: number }[], fps: number): void {
  const nominalDuration = Math.round(1_000_000 / fps);
  let prev = -Infinity;
  for (let i = 0; i < chunks.length; i++) {
    const t = chunks[i]!.timestamp;
    expect(t).toBeGreaterThan(prev);
    expect(Math.abs(t - i * nominalDuration)).toBeLessThan(nominalDuration);
    prev = t;
  }
}

describe("packedDemux", () => {
  it("demuxes an mp4/H.264 packed fixture (real encoder output)", async () => {
    const { bytes, meta } = loadFixture("packedDemuxFixture-mp4", "mp4");
    expect(meta.container).toBe("mp4");
    const stream = await demuxPackedVideo(bytes, "video/mp4");

    expect(stream.frameCount).toBe(meta.frameCount);
    expect(stream.chunks).toHaveLength(meta.frameCount);
    expectRequestedKeyframesPresent(stream.chunks);
    expectMonotonicApproxTimestamps(stream.chunks, meta.fps);

    expect(stream.codec).toMatch(/^avc1\./);
    expect(stream.description).toBeInstanceOf(Uint8Array);
    expect(stream.description!.length).toBeGreaterThan(0);
    expect(stream.codedHeight).toBe(2 * meta.layout.contentHeight + meta.layout.gutterPx);
  });

  it("demuxes a webm/VP9 packed fixture (real encoder output, fallback path)", async () => {
    const { bytes, meta } = loadFixture("packedDemuxFixture-webm", "webm");
    expect(meta.container).toBe("webm");
    const stream = await demuxPackedVideo(bytes, "video/webm");

    expect(stream.frameCount).toBe(meta.frameCount);
    expect(stream.chunks).toHaveLength(meta.frameCount);
    expectRequestedKeyframesPresent(stream.chunks);
    expectMonotonicApproxTimestamps(stream.chunks, meta.fps);

    expect(stream.codec).toBe("vp09.00.10.08");
    expect(stream.description).toBeUndefined();
    expect(stream.codedHeight).toBe(2 * meta.layout.contentHeight + meta.layout.gutterPx);
  });

  it("rejects an unsupported mime", async () => {
    await expect(demuxPackedVideo(new Uint8Array(4), "text/plain")).rejects.toThrow(/unsupported mime/);
  });
});
