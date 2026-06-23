import { describe, expect, it } from "vitest";
import { computePeaks, computePeaksForFrameRange, mixToMono, WAVEFORM_BUCKETS, type WaveformMode } from "../src/audio/waveform";

const SR = 44100;

/** sampleRate 秒の長さの正弦波（freq Hz, amp）を生成。 */
function sine(freq: number, durSec: number, amp = 1, sampleRate = SR): Float32Array {
  const n = Math.floor(durSec * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

/** ノリ波形: フルスケール持続 + 先頭にだけ大きなトランジェント（キック様）。 */
function noriWithTransient(durSec: number, sampleRate = SR): Float32Array {
  const sig = sine(220, durSec, 0.95, sampleRate);
  // 先頭 5ms に鋭いアタックを足す（既にフルスケールに近い＝海苔）。
  const atkN = Math.floor(0.005 * sampleRate);
  for (let i = 0; i < atkN && i < sig.length; i++) {
    sig[i] = Math.max(-1, Math.min(1, (sig[i] ?? 0) + (1 - i / atkN)));
  }
  return sig;
}

describe("waveform DSP", () => {
  it("mixToMono averages channels", () => {
    const a = new Float32Array([1, 1, 1]);
    const b = new Float32Array([-1, 0, 1]);
    const mono = mixToMono([a, b], 3);
    expect(Array.from(mono)).toEqual([0, 0.5, 1]);
  });

  it("computePeaks は決定論（同入力→同出力, INV-1 方針）", () => {
    const ch = [sine(440, 0.5)];
    for (const mode of ["raw", "donshari", "transient"] as WaveformMode[]) {
      const a = computePeaks(ch, SR, mode, 256);
      const b = computePeaks(ch, SR, mode, 256);
      expect(Array.from(a)).toEqual(Array.from(b));
    }
  });

  it("ピーク列の長さは bucketCount*2、値は -1..1 に正規化", () => {
    const peaks = computePeaks([sine(440, 0.5, 0.3)], SR, "raw", 512);
    expect(peaks.length).toBe(512 * 2);
    let max = 0;
    for (const v of peaks) { expect(v).toBeGreaterThanOrEqual(-1.0001); expect(v).toBeLessThanOrEqual(1.0001); max = Math.max(max, Math.abs(v)); }
    // 正規化されているので最大絶対値はほぼ 1。
    expect(max).toBeGreaterThan(0.9);
  });

  it("transient モードは海苔波形でも先頭アタックを後続より強調する", () => {
    const buckets = 512;
    const sig = noriWithTransient(1.0);
    const raw = computePeaks([sig], SR, "raw", buckets);
    const trn = computePeaks([sig], SR, "transient", buckets);

    const bucketPeak = (p: Float32Array, b: number) => Math.max(Math.abs(p[b * 2] ?? 0), Math.abs(p[b * 2 + 1] ?? 0));
    // 先頭バケットと中盤バケットの比を比較。raw はほぼ平坦（海苔）、transient は先頭が突出。
    const rawRatio = bucketPeak(raw, 0) / Math.max(1e-6, bucketPeak(raw, Math.floor(buckets / 2)));
    const trnRatio = bucketPeak(trn, 0) / Math.max(1e-6, bucketPeak(trn, Math.floor(buckets / 2)));
    expect(trnRatio).toBeGreaterThan(rawRatio * 2);
  });

  it("computePeaksForFrameRange は可視区間だけを高解像度でピーク化する", () => {
    const sig = new Float32Array(SR * 10);
    const pulseN = Math.floor(SR * 0.05);
    for (let i = 0; i < pulseN; i++) sig[i] = 1;
    const full = computePeaks([sig], SR, "raw", 100);
    const zoomed = computePeaksForFrameRange([sig], SR, 30, "raw", 0, 30, 100);
    const significantBuckets = (p: Float32Array, threshold = 0.5) => {
      const n = p.length / 2;
      let count = 0;
      for (let b = 0; b < n; b++) {
        const peak = Math.max(Math.abs(p[b * 2] ?? 0), Math.abs(p[b * 2 + 1] ?? 0));
        if (peak > threshold) count++;
      }
      return count;
    };
    // 全曲 100 バケットでは短いパルスは 1 バケットに潰れる。1 秒区間を 100 バケットなら複数バケットに分散。
    expect(significantBuckets(zoomed)).toBeGreaterThan(significantBuckets(full));
  });

  it("デフォルト bucketCount は WAVEFORM_BUCKETS", () => {
    const peaks = computePeaks([sine(100, 0.2)], SR, "raw");
    expect(peaks.length).toBe(WAVEFORM_BUCKETS * 2);
  });
});
