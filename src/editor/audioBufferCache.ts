// §11.5 — デコード済み AudioBuffer の共有プリロードキャッシュ。
// 目的:
//  1) 再生レイテンシ削減 — 編集中レイヤーの音声を事前 decode してメモリ常駐させ、再生ボタンで即発音する。
//  2) duration メタ取得 — import 時に 1 回だけ decode して秒数を asset.meta に焼く（波形マッピング用）。
//  3) 多重 decode の排除 — 波形抽出 / 再生 / メタが同一バッファを共有する（66MB wav を 1 回だけ decode）。
//
// AudioBuffer は仕様上どの AudioContext の createBufferSource でも再生できるため、
// decode は単一の共有 context で行い、再生側は別 context でもこのバッファを使える。

let sharedCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  if (!sharedCtx) sharedCtx = new AudioContext();
  return sharedCtx;
}

const buffers = new Map<string, AudioBuffer>();
const inflight = new Map<string, Promise<AudioBuffer | null>>();

/** メモリ常駐済みバッファを同期取得（無ければ undefined）。 */
export function peekAudioBuffer(assetId: string): AudioBuffer | undefined {
  return buffers.get(assetId);
}

/**
 * assetId のバッファを取得（無ければ decode してメモリ常駐）。
 * readBytes は cache miss / 非 in-flight のときだけ呼ばれる。
 */
export function loadAudioBuffer(
  assetId: string,
  readBytes: () => Promise<Uint8Array>,
): Promise<AudioBuffer | null> {
  const hit = buffers.get(assetId);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(assetId);
  if (pending) return pending;
  const task = (async (): Promise<AudioBuffer | null> => {
    const ctx = getCtx();
    if (!ctx) return null;
    try {
      const bytes = await readBytes();
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const buf = await ctx.decodeAudioData(ab);
      buffers.set(assetId, buf);
      return buf;
    } catch {
      return null;
    } finally {
      inflight.delete(assetId);
    }
  })();
  inflight.set(assetId, task);
  return task;
}

/** アセット削除時にメモリ常駐バッファを破棄する。 */
export function evictAudioBuffer(assetId: string): void {
  buffers.delete(assetId);
  inflight.delete(assetId);
}

/** asset.meta 用の秒数等を返す。プリロードも兼ねる（バッファをキャッシュに残す）。 */
export async function probeAudioMeta(
  assetId: string,
  readBytes: () => Promise<Uint8Array>,
): Promise<{ duration: number; sampleRate: number; channels: number } | null> {
  const buf = await loadAudioBuffer(assetId, readBytes);
  if (!buf) return null;
  return { duration: buf.duration, sampleRate: buf.sampleRate, channels: buf.numberOfChannels };
}
