// §11.5.1 — タイムライン波形表示用のピーク抽出 + DSP。
// 表示専用の派生物（resolve / project.json には一切影響しない）。
// decodeAudioData 以外はすべて純関数（WebAudio 非依存）にして node でユニットテスト可能にする。

export type WaveformMode = "raw" | "donshari" | "transient";

export const WAVEFORM_MODES: readonly WaveformMode[] = ["raw", "donshari", "transient"];

/** 表示幅に依存しない正準バケット数。描画側で間引く。 */
export const WAVEFORM_BUCKETS = 4096;

/**
 * ピーク列。長さ = bucketCount * 2、`[min0, max0, min1, max1, ...]`。
 * 値は各モード内の最大振幅で正規化済み（-1..1）。
 */
export type WaveformPeaks = Float32Array;

/** 複数チャンネルをモノラルへ平均畳み込み。 */
export function mixToMono(channels: Float32Array[], length: number): Float32Array {
  const mono = new Float32Array(length);
  if (channels.length === 0) return mono;
  for (const ch of channels) {
    const n = Math.min(length, ch.length);
    for (let i = 0; i < n; i++) mono[i] = (mono[i] ?? 0) + (ch[i] ?? 0);
  }
  const inv = 1 / channels.length;
  for (let i = 0; i < length; i++) mono[i] = (mono[i] ?? 0) * inv;
  return mono;
}

interface BiquadCoeffs {
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

/** RBJ cookbook lowShelf / highShelf を a0 正規化して返す。 */
function shelfCoeffs(kind: "low" | "high", f0: number, sampleRate: number, dbGain: number, q: number): BiquadCoeffs {
  const A = Math.pow(10, dbGain / 40);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const sqA2a = 2 * Math.sqrt(A) * alpha;
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (kind === "low") {
    b0 = A * ((A + 1) - (A - 1) * cw + sqA2a);
    b1 = 2 * A * ((A - 1) - (A + 1) * cw);
    b2 = A * ((A + 1) - (A - 1) * cw - sqA2a);
    a0 = (A + 1) + (A - 1) * cw + sqA2a;
    a1 = -2 * ((A - 1) + (A + 1) * cw);
    a2 = (A + 1) + (A - 1) * cw - sqA2a;
  } else {
    b0 = A * ((A + 1) + (A - 1) * cw + sqA2a);
    b1 = -2 * A * ((A - 1) + (A + 1) * cw);
    b2 = A * ((A + 1) + (A - 1) * cw - sqA2a);
    a0 = (A + 1) - (A - 1) * cw + sqA2a;
    a1 = 2 * ((A - 1) - (A + 1) * cw);
    a2 = (A + 1) - (A - 1) * cw - sqA2a;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Direct-Form I の biquad を in-place ではなく新配列に適用。 */
function applyBiquad(sig: Float32Array, c: BiquadCoeffs): Float32Array {
  const out = new Float32Array(sig.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < sig.length; i++) {
    const x0 = sig[i] ?? 0;
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

/** ドンシャリ EQ: 低域(~80Hz) + 高域(~6kHz) をブーストしてキック/ハイのアタックを立てる。 */
function applyDonshari(mono: Float32Array, sampleRate: number): Float32Array {
  const low = applyBiquad(mono, shelfCoeffs("low", 80, sampleRate, 9, 0.7));
  return applyBiquad(low, shelfCoeffs("high", 6000, sampleRate, 9, 0.7));
}

function envCoef(timeSec: number, sampleRate: number): number {
  return Math.exp(-1 / Math.max(1, sampleRate * timeSec));
}

/**
 * トランジェント強調: fast/slow エンベロープの差分。
 * 海苔波形でもアタックが視認できるよう、立ち上がりを過剰強調した単極エンベロープを返す。
 */
function applyTransient(mono: Float32Array, sampleRate: number): Float32Array {
  const fAtk = envCoef(0.001, sampleRate);
  const fRel = envCoef(0.030, sampleRate);
  const sAtk = envCoef(0.010, sampleRate);
  const sRel = envCoef(0.250, sampleRate);
  const out = new Float32Array(mono.length);
  let fast = 0, slow = 0;
  for (let i = 0; i < mono.length; i++) {
    const x = Math.abs(mono[i] ?? 0);
    fast = x > fast ? fAtk * fast + (1 - fAtk) * x : fRel * fast + (1 - fRel) * x;
    slow = x > slow ? sAtk * slow + (1 - sAtk) * x : sRel * slow + (1 - sRel) * x;
    const t = fast - slow;
    out[i] = t > 0 ? t : 0;
  }
  return out;
}

/** バケットごとの min/max を取り、全体の最大絶対値で正規化する。 */
function bucketPeaks(sig: Float32Array, bucketCount: number, symmetric: boolean): WaveformPeaks {
  const peaks = new Float32Array(bucketCount * 2);
  const len = sig.length;
  if (len === 0) return peaks;
  let globalMax = 0;
  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor((b * len) / bucketCount);
    const end = Math.max(start + 1, Math.floor(((b + 1) * len) / bucketCount));
    let mn = Infinity, mx = -Infinity;
    for (let i = start; i < end && i < len; i++) {
      const v = sig[i] ?? 0;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!isFinite(mn)) { mn = 0; mx = 0; }
    if (symmetric) {
      const a = Math.max(Math.abs(mn), Math.abs(mx));
      mn = -a; mx = a;
    }
    peaks[b * 2] = mn;
    peaks[b * 2 + 1] = mx;
    globalMax = Math.max(globalMax, Math.abs(mn), Math.abs(mx));
  }
  if (globalMax > 0) {
    const inv = 1 / globalMax;
    for (let i = 0; i < peaks.length; i++) peaks[i] = (peaks[i] ?? 0) * inv;
  }
  return peaks;
}

function processMode(mono: Float32Array, sampleRate: number, mode: WaveformMode): Float32Array {
  if (mode === "raw") return mono;
  if (mode === "donshari") return applyDonshari(mono, sampleRate);
  return applyTransient(mono, sampleRate);
}

function sliceChannels(channels: Float32Array[], start: number, end: number): Float32Array[] {
  return channels.map((ch) => ch.subarray(start, Math.min(end, ch.length)));
}

/**
 * チャンネルデータ + sampleRate からモード別ピークを計算する純関数。
 * decodeAudioData 結果（AudioBuffer の getChannelData 群）を渡す想定。
 */
export function computePeaks(
  channels: Float32Array[],
  sampleRate: number,
  mode: WaveformMode,
  bucketCount: number = WAVEFORM_BUCKETS,
): WaveformPeaks {
  const length = channels.reduce((m, c) => Math.max(m, c.length), 0);
  const mono = mixToMono(channels, length);
  return bucketPeaks(processMode(mono, sampleRate, mode), bucketCount, mode === "transient");
}

/**
 * ソースの [startSample, endSample) を bucketCount 本の min/max ピークに変換する。
 * タイムラインの可視区間をピクセル幅で直接サンプリングし、ズーム時の解像度を保つ。
 */
export function computePeaksForSampleRange(
  channels: Float32Array[],
  sampleRate: number,
  mode: WaveformMode,
  startSample: number,
  endSample: number,
  bucketCount: number,
): WaveformPeaks {
  const length = channels.reduce((m, c) => Math.max(m, c.length), 0);
  const start = Math.max(0, Math.floor(startSample));
  const end = Math.min(length, Math.ceil(endSample));
  if (end <= start || bucketCount <= 0) return new Float32Array(0);
  const sliced = sliceChannels(channels, start, end);
  const mono = mixToMono(sliced, end - start);
  return bucketPeaks(processMode(mono, sampleRate, mode), bucketCount, mode === "transient");
}

/** comp フレーム区間 [startFrame, endFrame) を bucketCount 本のピークへ変換する。 */
export function computePeaksForFrameRange(
  channels: Float32Array[],
  sampleRate: number,
  fps: number,
  mode: WaveformMode,
  startFrame: number,
  endFrame: number,
  bucketCount: number,
): WaveformPeaks {
  const spf = sampleRate / Math.max(1, fps);
  return computePeaksForSampleRange(
    channels,
    sampleRate,
    mode,
    startFrame * spf,
    endFrame * spf,
    bucketCount,
  );
}
