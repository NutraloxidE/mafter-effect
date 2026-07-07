import type { VideoBlobRequest, VideoBlobResponse } from "./workers/videoBlob.worker";

// Phase 2b（preview-rendering-pipeline-optimization-plan）:
// Worker 内で `URL.createObjectURL` した blob: URL は、生成した実行コンテキスト（agent）に
// スコープされ Worker 破棄時に失効するため、メインスレッドの <video src> から参照できない
// （実装前に確認済みの罠）。Worker には重いコピー（slice 相当）+ Blob 構築だけをやらせ、
// `URL.createObjectURL` は必ずメインスレッドで呼ぶ。

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (v: Blob) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./workers/videoBlob.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent<VideoBlobResponse>) => {
      const { id, blob, error } = ev.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error || !blob) p.reject(new Error(error ?? "video blob decode failed"));
      else p.resolve(blob);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  } catch {
    return null;
  }
}

function decodeVideoBlobUrlMainThread(buf: Uint8Array, mime: string): string {
  return URL.createObjectURL(new Blob([buf as Uint8Array<ArrayBuffer>], { type: mime }));
}

/** 動画バイナリ → blob: URL。Worker が使えれば Blob 構築をオフロードする（§28 UX 最適化・Phase 2b）。 */
export async function decodeVideoBlobUrl(buf: Uint8Array, mime: string): Promise<string> {
  const w = ensureWorker();
  if (!w) return decodeVideoBlobUrlMainThread(buf, mime);

  // buf のビューが underlying buffer 全体を覆っていない場合（fs.read() の実装上は通常起きないが
  // 念のため）、transfer で他の参照が巻き添えにならないよう独立 ArrayBuffer を切り出す。
  const ab: ArrayBuffer =
    buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
      ? (buf.buffer as ArrayBuffer)
      : (buf.slice().buffer as ArrayBuffer);

  const id = nextId++;
  const blob = await new Promise<Blob>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const req: VideoBlobRequest = { id, buffer: ab, mime };
    w.postMessage(req, [ab]);
  });
  // URL 発行は必ずメインスレッドで（Worker 発行の blob: URL は <video> から参照できない）。
  return URL.createObjectURL(blob);
}

/** テスト用: Worker 状態をリセット。 */
export function disposeVideoBlobWorker(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
}
