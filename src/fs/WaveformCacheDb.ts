// §11.5.1 — 波形ピークの IndexedDB キャッシュ（project FS とは別 DB・非直列化）。
// PreviewCacheDb と同じ最小 IndexedDB パターン。値は Float32Array（min/max インターリーブ）。

import { computePeaks, WAVEFORM_BUCKETS, type WaveformMode, type WaveformPeaks } from "../audio/waveform";
import { loadAudioBuffer } from "../editor/audioBufferCache";

const DB_NAME = "mafter-effect-waveform-cache";
const STORE = "peaks";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function cacheKey(assetId: string, mode: WaveformMode, buckets: number): string {
  return `${assetId}:${mode}:${buckets}`;
}

/**
 * 波形ピークのキャッシュサービス。
 * - L1: in-memory Map（同セッション内の再描画用）。
 * - L2: IndexedDB（セッション跨ぎ）。
 * - decode はアセット単位で 1 回だけ行い、3 モードを派生する。
 */
export class WaveformCache {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly mem = new Map<string, WaveformPeaks>();
  /** decode 結果（チャンネルデータ）をアセット単位でメモ化。 */
  private readonly decoded = new Map<string, { channels: Float32Array[]; sampleRate: number } | null>();
  private readonly inflight = new Map<string, Promise<WaveformPeaks | null>>();

  private getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDb();
    return this.dbPromise;
  }

  /** メモリ即時取得（同期）。描画ループから cache hit を安く確認するため。 */
  peek(assetId: string, mode: WaveformMode, buckets = WAVEFORM_BUCKETS): WaveformPeaks | undefined {
    return this.mem.get(cacheKey(assetId, mode, buckets));
  }

  /**
   * ピークを取得（なければ IndexedDB → decode/compute して保存）。
   * readBytes は cache miss 時のみ呼ばれる。
   */
  async get(
    assetId: string,
    mode: WaveformMode,
    readBytes: () => Promise<Uint8Array>,
    buckets = WAVEFORM_BUCKETS,
  ): Promise<WaveformPeaks | null> {
    const key = cacheKey(assetId, mode, buckets);
    const hit = this.mem.get(key);
    if (hit) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const task = this.load(assetId, mode, buckets, key, readBytes).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, task);
    return task;
  }

  private async load(
    assetId: string,
    mode: WaveformMode,
    buckets: number,
    key: string,
    readBytes: () => Promise<Uint8Array>,
  ): Promise<WaveformPeaks | null> {
    // L2: IndexedDB
    try {
      const db = await this.getDb();
      const row = (await promisify(
        db.transaction(STORE, "readonly").objectStore(STORE).get(key),
      )) as Float32Array | undefined;
      if (row && row.length > 0) {
        const peaks = row instanceof Float32Array ? row : new Float32Array(row);
        this.mem.set(key, peaks);
        return peaks;
      }
    } catch {
      /* IndexedDB 不可環境では compute にフォールバック */
    }

    // decode（アセット単位で 1 回・再生用バッファと共有）
    let dec = this.decoded.get(assetId);
    if (dec === undefined) {
      dec = await this.decode(assetId, readBytes);
      this.decoded.set(assetId, dec);
    }
    if (!dec) return null;

    const peaks = computePeaks(dec.channels, dec.sampleRate, mode, buckets);
    this.mem.set(key, peaks);
    try {
      const db = await this.getDb();
      db.transaction(STORE, "readwrite").objectStore(STORE).put(peaks, key);
    } catch {
      /* 保存失敗は致命的でない */
    }
    return peaks;
  }

  private async decode(assetId: string, readBytes: () => Promise<Uint8Array>): Promise<{ channels: Float32Array[]; sampleRate: number } | null> {
    // 再生・プリロードと同じ共有バッファを使い、66MB 級ファイルの多重 decode を避ける。
    const buffer = await loadAudioBuffer(assetId, readBytes);
    if (!buffer) return null;
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) channels.push(buffer.getChannelData(ch));
    return { channels, sampleRate: buffer.sampleRate };
  }

  /** アセット削除時に L1 / decode メモ化を破棄する（L2 IDB は best-effort で残る）。 */
  evict(assetId: string): void {
    const prefix = `${assetId}:`;
    for (const key of this.mem.keys()) {
      if (key.startsWith(prefix)) this.mem.delete(key);
    }
    this.decoded.delete(assetId);
  }

  dispose(): void {
    this.mem.clear();
    this.decoded.clear();
  }
}

/** エディタ全体で共有する単一インスタンス。 */
export const globalWaveformCache = new WaveformCache();
