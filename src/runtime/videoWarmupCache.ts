// §11.4 — preview / HTML bundle player の動画 warm-up 状態キャッシュ。
// 目的（音声プリロード §11.5 = audioBufferCache.ts と同型）:
//  1) 再生レイテンシ削減 — 編集 idle 中に <video> を decode 済みフレームまで seek し、
//     Play ボタンで decode 待ちなく即描画できるようにする。
//  2) 多重 prime の排除 — 同一 (assetId, フレーム) への idle warm-up と play gate が
//     同時に走っても seek を 1 回に去重する（inflight dedup）。
//
// 実 <video> の prime は呼び出し側（DomRenderer.primeMountedVideos）が primeVideoElement で行う。
// このモジュールは DOM に触れず、primed 状態（assetId@frame）と inflight だけを管理する。
// hidden プールは作らない（デコーダ二重化を避ける・既存マウント済み <video> を再利用）。

const primedKeys = new Set<string>();
const inflight = new Map<string, Promise<boolean>>();

/** primed キーはフレーム粒度（assetId + "@" + round(targetSec * fps)）。 */
function keyFor(assetId: string, targetSec: number, fps: number): string {
  return `${assetId}@${Math.round(targetSec * Math.max(1, fps))}`;
}

/** 同期: この assetId / 時刻帯（フレーム）が prime 済みか。 */
export function peekVideoPrimed(assetId: string, targetSec: number, fps: number): boolean {
  return primedKeys.has(keyFor(assetId, targetSec, fps));
}

/** Footage 削除時に primed 状態と inflight を破棄する（evictAudioBuffer と同位置で呼ぶ）。 */
export function evictVideoPrimed(assetId: string): void {
  const prefix = `${assetId}@`;
  for (const k of [...primedKeys]) if (k.startsWith(prefix)) primedKeys.delete(k);
  for (const k of [...inflight.keys()]) if (k.startsWith(prefix)) inflight.delete(k);
}

export interface VideoPrimeTarget {
  assetId: string;
  targetSec: number;
  fps: number;
  /** 実 <video> を decode 済みフレームまで進める（primeVideoElement 等）。成功=true。 */
  prime: () => Promise<boolean>;
}

function primeOne(t: VideoPrimeTarget): Promise<boolean> {
  const key = keyFor(t.assetId, t.targetSec, t.fps);
  if (primedKeys.has(key)) return Promise.resolve(true);
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = (async (): Promise<boolean> => {
    try {
      const ok = await t.prime();
      if (ok) primedKeys.add(key); // 成功時のみ記録（失敗は再生時に再試行）
      return ok;
    } catch {
      return false;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

/** 複数レイヤーを並列 prime（key 単位で inflight 去重・成功時のみ primed 記録）。全成功で true。 */
export function ensureVideosPrimed(targets: VideoPrimeTarget[]): Promise<boolean> {
  if (targets.length === 0) return Promise.resolve(true);
  return Promise.all(targets.map(primeOne)).then((rs) => rs.every(Boolean));
}

/** test 専用: warm-up 状態をリセットする。 */
export function _resetVideoWarmupCacheForTest(): void {
  primedKeys.clear();
  inflight.clear();
}
