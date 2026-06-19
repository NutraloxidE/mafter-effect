import type { PngEncodeRequest, PngEncodeResponse } from "./workers/pngEncode.worker";

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (v: Uint8Array) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./workers/pngEncode.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent<PngEncodeResponse>) => {
      const { id, png, error } = ev.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error || !png) p.reject(new Error(error ?? "png encode failed"));
      else p.resolve(png);
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

function canvasToPngBytesMainThread(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error("toBlob failed"));
        return;
      }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png");
  });
}

/** Canvas → PNG。Worker が使えればオフロード（§28 UX 最適化）。 */
export async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const w = ensureWorker();
  if (!w) return canvasToPngBytesMainThread(canvas);

  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) return canvasToPngBytesMainThread(canvas);
  const imageData = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
  const rgba = new Uint8ClampedArray(imageData.data);
  const id = nextId++;
  return new Promise<Uint8Array>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const req: PngEncodeRequest = { id, width: canvas.width, height: canvas.height, rgba };
    w.postMessage(req, [rgba.buffer]);
  });
}

/** テスト用: Worker 状態をリセット。 */
export function disposePngEncodeWorker(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
}
