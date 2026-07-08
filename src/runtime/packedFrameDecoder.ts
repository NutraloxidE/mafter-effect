/**
 * videoDecoder-compiled-leaf plan Phase 2 — packed alpha 動画の preview 再生専用、frameIndex 指定で
 * `VideoFrame` を返す明示デコーダ。scrub/export は触らない（既存 `<video>`-seek のまま、INV-2 非干渉）。
 *
 * INV-2 の錨: `EncodedVideoChunk` へ渡す timestamp は demux が復元した container 由来の値ではなく
 * `index * Math.round(1e6/fps)` を自前で再構成する（`packedDemux.ts` 冒頭コメント参照 — webm は
 * ms 丸め、mp4 も timescale=fps の整数丸めでどちらも container 往復では厳密値に戻らないため）。
 * これにより出力 `VideoFrame.timestamp` から `frameIndex = round(timestamp / frameDurationUs)` が
 * 常に厳密に一致し、frameIndex 基準の cache key が container 精度に左右されない。
 */

import type { PackedEncodedStream } from "./packedDemux";

export interface PackedFrameDecoder {
  /** 即座に使える VideoFrame があれば返す（無ければ null + 内部で decode 予約）。呼び出し側は
   * 返された VideoFrame を同期的に使い切ること（次の getFrame/prefetch 呼び出しを跨いで保持しない）。 */
  getFrame(frameIndex: number): VideoFrame | null;
  /** fromIndex から count 枚を先読み（再生方向）。 */
  prefetch(fromIndex: number, count: number): void;
  /** context lost / decode error 等で使用不能になったら true。呼び出し側は `<video>` フォールバックへ。 */
  readonly broken: boolean;
  /** 全 VideoFrame.close() + decoder.close()。 */
  dispose(): void;
}

export function isPackedDecoderSupported(): boolean {
  if (typeof VideoDecoder === "undefined") return false;
  if (typeof isSecureContext !== "undefined" && !isSecureContext) return false;
  return true;
}

// ============================================================================
// LRU フレームキャッシュ（純ロジック・VideoDecoder 非依存・unit test 対象）
// ============================================================================

export interface Closable {
  close(): void;
}

/** frameIndex → VideoFrame の LRU キャッシュ。evict 時は必ず close() する（メモリ漏れ厳禁）。 */
export class PackedFrameLruCache<T extends Closable> {
  private readonly map = new Map<number, T>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.map.size;
  }

  has(key: number): boolean {
    return this.map.has(key);
  }

  /** 取得時に最近使用として並べ替える（LRU touch）。 */
  get(key: number): T | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** 既存キーへの上書きは古い値を close() してから差し替える。容量超過分は最も古いものから evict + close()。 */
  set(key: number, value: T): void {
    const existing = this.map.get(key);
    if (existing !== undefined) {
      existing.close();
      this.map.delete(key);
    }
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.map.get(oldestKey)!;
      oldest.close();
      this.map.delete(oldestKey);
    }
  }

  clear(): void {
    for (const value of this.map.values()) value.close();
    this.map.clear();
  }
}

// ============================================================================
// keyframe 逆引き（純ロジック・GOP=30 を仮定せず実フラグから求める）
// ============================================================================

/**
 * `targetIndex` 以下で最大の keyframe index を返す（GOP-back の起点）。エンコーダは要求した
 * GOP=30 の位置以外にも自発的に keyframe を打つことがある（実測・packedDemux.test.ts 参照）ため、
 * `floor(idx/30)*30` という仮定式ではなく実際の keyframe 位置列から二分探索する。
 * `keyframeIndices` は昇順ソート済み・`keyframeIndices[0] === 0` を前提とする。
 */
export function keyframeIndexFor(keyframeIndices: readonly number[], targetIndex: number): number {
  let lo = 0;
  let hi = keyframeIndices.length - 1;
  let ans = keyframeIndices[0] ?? 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = keyframeIndices[mid]!;
    if (candidate <= targetIndex) {
      ans = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** `fromKeyframe` より大きい最小の keyframe index。無ければ `Infinity`（呼び出し側で総フレーム数に clamp）。 */
export function nextKeyframeBoundary(keyframeIndices: readonly number[], fromKeyframe: number): number {
  for (const k of keyframeIndices) {
    if (k > fromKeyframe) return k;
  }
  return Infinity;
}

// ============================================================================
// 予算・キルスイッチ（純ロジック、videoAlphaGl.ts の compositor 予算と同型）
// ============================================================================

export function shouldCreatePackedFrameDecoder(params: {
  alreadyHasDecoder: boolean;
  activeCount: number;
  maxDecoders: number;
  killSwitchActive: boolean;
}): boolean {
  if (params.alreadyHasDecoder) return false;
  if (params.killSwitchActive) return false;
  return params.activeCount < params.maxDecoders;
}

const MAX_PACKED_DECODERS = 4;
const MAX_CACHED_FRAMES_PER_DECODER = 16;
const PACKED_DECODER_KILL_SWITCH_KEY = "mafterDisablePackedDecoder";

function packedDecoderKillSwitchActive(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(PACKED_DECODER_KILL_SWITCH_KEY) === "1";
  } catch {
    return false;
  }
}

// ============================================================================
// VideoDecoder ラッパ本体
// ============================================================================

async function negotiateDecoderConfig(base: VideoDecoderConfig): Promise<VideoDecoderConfig | null> {
  const withHwHint: VideoDecoderConfig = { ...base, hardwareAcceleration: "prefer-hardware", optimizeForLatency: true };
  try {
    const support = await VideoDecoder.isConfigSupported(withHwHint);
    if (support.supported) return withHwHint;
  } catch {
    /* fall through to no-hint negotiation */
  }
  try {
    const support = await VideoDecoder.isConfigSupported(base);
    if (support.supported) return base;
  } catch {
    /* unsupported */
  }
  return null;
}

export async function createPackedFrameDecoder(
  stream: PackedEncodedStream,
  fps: number,
): Promise<PackedFrameDecoder | null> {
  if (!isPackedDecoderSupported()) return null;
  if (stream.chunks.length === 0) return null;

  const keyframeIndices = stream.chunks.reduce<number[]>((acc, c, i) => {
    if (c.keyFrame) acc.push(i);
    return acc;
  }, []);
  if (keyframeIndices[0] !== 0) return null; // 先頭に keyframe が無いと decode 不能

  const baseConfig: VideoDecoderConfig = {
    codec: stream.codec,
    codedWidth: stream.codedWidth,
    codedHeight: stream.codedHeight,
    ...(stream.description ? { description: stream.description } : {}),
  };
  const negotiatedOrNull = await negotiateDecoderConfig(baseConfig);
  if (!negotiatedOrNull) return null;
  const negotiated: VideoDecoderConfig = negotiatedOrNull;

  const frameDurationUs = Math.round(1_000_000 / fps);
  const cache = new PackedFrameLruCache<VideoFrame>(MAX_CACHED_FRAMES_PER_DECODER);

  let broken = false;
  let session: { keyframeStart: number; sessionEnd: number } | null = null;

  const decoder = new VideoDecoder({
    output(frame) {
      const idx = Math.round(frame.timestamp / frameDurationUs);
      // eslint-disable-next-line no-console
      console.log("packedFrameDecoder DEBUG output", { rawTs: frame.timestamp, idx });
      cache.set(idx, frame);
    },
    error(e) {
      // eslint-disable-next-line no-console
      console.error("packedFrameDecoder: decoder error callback", e);
      broken = true;
    },
  });

  try {
    decoder.configure(negotiated);
  } catch {
    return null;
  }

  function feedSession(keyframeStart: number, sessionEnd: number): void {
    session = { keyframeStart, sessionEnd };
    try {
      for (let i = keyframeStart; i <= sessionEnd; i++) {
        const c = stream.chunks[i]!;
        const chunk = new EncodedVideoChunk({
          type: c.keyFrame ? "key" : "delta",
          timestamp: i * frameDurationUs,
          duration: frameDurationUs,
          data: c.data,
        });
        decoder.decode(chunk);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("packedFrameDecoder: feedSession failed", keyframeStart, sessionEnd, e);
      broken = true;
    }
  }

  function ensureDecoding(targetIndex: number): void {
    if (broken || cache.has(targetIndex)) return;
    const keyframeStart = keyframeIndexFor(keyframeIndices, targetIndex);
    if (session && session.keyframeStart === keyframeStart && targetIndex <= session.sessionEnd) return;
    if (session) {
      // 現行セッションの計画範囲外への大ジャンプ: 未処理のデコードキューを破棄して作り直す。
      try {
        decoder.reset();
        decoder.configure(negotiated);
      } catch {
        broken = true;
        return;
      }
    }
    const boundary = nextKeyframeBoundary(keyframeIndices, keyframeStart);
    const sessionEnd = Math.min(boundary - 1, stream.chunks.length - 1);
    feedSession(keyframeStart, sessionEnd);
  }

  return {
    getFrame(frameIndex) {
      if (broken || frameIndex < 0 || frameIndex >= stream.chunks.length) return null;
      const cached = cache.get(frameIndex);
      if (cached) return cached;
      ensureDecoding(frameIndex);
      return null;
    },
    prefetch(fromIndex, count) {
      if (broken || count <= 0) return;
      const clampedFrom = Math.max(0, Math.min(fromIndex, stream.chunks.length - 1));
      const target = Math.max(0, Math.min(fromIndex + count - 1, stream.chunks.length - 1));
      if (!cache.has(clampedFrom)) ensureDecoding(clampedFrom);
      if (!cache.has(target)) ensureDecoding(target);
    },
    get broken() {
      return broken;
    },
    dispose() {
      cache.clear();
      try {
        decoder.close();
      } catch {
        /* already closed */
      }
    },
  };
}

// ============================================================================
// レイヤー単位の遅延生成・予算レジストリ（videoAlphaGl.ts の compositorsByCanvas と同型）
// ============================================================================

const decodersByKey = new WeakMap<object, PackedFrameDecoder>();
let activePackedDecoderCount = 0;

/**
 * `key`（DomRenderer 側では packed alpha 合成用 canvas を想定）に紐づく decoder を遅延生成・
 * キャッシュする。予算超過・キルスイッチ・環境非対応・config 非対応のいずれかで null を返す
 * （呼び出し側は `<video>` フォールバックへ）。
 */
export async function ensurePackedFrameDecoder(
  key: object,
  stream: PackedEncodedStream,
  fps: number,
): Promise<PackedFrameDecoder | null> {
  const existing = decodersByKey.get(key);
  if (existing) return existing.broken ? null : existing;
  if (
    !shouldCreatePackedFrameDecoder({
      alreadyHasDecoder: false,
      activeCount: activePackedDecoderCount,
      maxDecoders: MAX_PACKED_DECODERS,
      killSwitchActive: packedDecoderKillSwitchActive(),
    })
  ) {
    return null;
  }
  const decoder = await createPackedFrameDecoder(stream, fps);
  if (!decoder) return null;
  decodersByKey.set(key, decoder);
  activePackedDecoderCount += 1;
  return decoder;
}

/** 明示解放（レイヤー非表示化/削除/asset・quality 変更時に必ず呼ぶ）。 */
export function releasePackedFrameDecoder(key: object): void {
  const existing = decodersByKey.get(key);
  if (!existing) return;
  existing.dispose();
  decodersByKey.delete(key);
  activePackedDecoderCount = Math.max(0, activePackedDecoderCount - 1);
}

/** `key` に紐づく decoder が既にあれば返す（生成はしない、読み取り専用アクセサ）。 */
export function getPackedFrameDecoder(key: object): PackedFrameDecoder | undefined {
  return decodersByKey.get(key);
}
