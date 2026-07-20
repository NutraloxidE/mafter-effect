import type { WorkerVideoInit, WorkerVideoRequest, WorkerVideoResponse } from "./workerVideoExportProtocol";

const MAX_IN_FLIGHT_FRAMES = 3;

export function isWorkerVideoExportEnabled(): boolean {
  const g = globalThis as { __mafterWorkerVideoExport?: unknown };
  return g.__mafterWorkerVideoExport === true && typeof Worker !== "undefined";
}

export interface WorkerVideoExportSession {
  encode(frame: VideoFrame, id: number, keyFrame: boolean, signal?: AbortSignal): Promise<void>;
  finish(signal?: AbortSignal): Promise<{ buffer: ArrayBuffer; mimeType: string }>;
  abort(): void;
}

export async function createWorkerVideoExportSession(
  init: Omit<WorkerVideoInit, "type">,
  signal?: AbortSignal,
): Promise<WorkerVideoExportSession> {
  const worker = new Worker(new URL("./workers/videoExport.worker.ts", import.meta.url), { type: "module" });
  let terminalError: Error | null = null;
  let closed = false;
  let inFlight = 0;
  const capacityWaiters: Array<() => void> = [];
  const frameWaiters = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let finishResolve!: (result: { buffer: ArrayBuffer; mimeType: string }) => void;
  let finishReject!: (error: Error) => void;
  const finished = new Promise<{ buffer: ArrayBuffer; mimeType: string }>((resolve, reject) => {
    finishResolve = resolve;
    finishReject = reject;
  });
  void finished.catch(() => { /* consumed by finish when initialization succeeds */ });

  const wakeCapacity = () => {
    while (inFlight < MAX_IN_FLIGHT_FRAMES && capacityWaiters.length > 0) capacityWaiters.shift()?.();
  };
  const fail = (error: Error) => {
    if (terminalError) return;
    terminalError = error;
    readyReject(error);
    finishReject(error);
    for (const waiter of frameWaiters.values()) waiter.reject(error);
    frameWaiters.clear();
    inFlight = 0;
    wakeCapacity();
  };
  worker.onmessage = (event: MessageEvent<WorkerVideoResponse>) => {
    const message = event.data;
    if (message.type === "ready") readyResolve();
    else if (message.type === "frame-done") {
      const waiter = frameWaiters.get(message.id);
      if (waiter) {
        frameWaiters.delete(message.id);
        inFlight = Math.max(0, inFlight - 1);
        waiter.resolve();
        wakeCapacity();
      }
    } else if (message.type === "complete") {
      closed = true;
      finishResolve({ buffer: message.buffer, mimeType: message.mimeType });
      worker.terminate();
    } else if (message.type === "error") fail(new Error(message.message));
  };
  worker.onerror = (event) => fail(new Error(event.message || "Video export worker failed"));
  worker.postMessage({ type: "init", ...init } satisfies WorkerVideoRequest);

  const abort = () => {
    if (closed) return;
    closed = true;
    try { worker.postMessage({ type: "abort" } satisfies WorkerVideoRequest); } catch { /* worker may already be gone */ }
    worker.terminate();
    fail(new DOMException("Export aborted", "AbortError"));
  };
  if (signal?.aborted) abort();
  await ready;

  return {
    async encode(frame, id, keyFrame, encodeSignal) {
      if (terminalError) { frame.close(); throw terminalError; }
      if (closed) { frame.close(); throw new Error("Video export worker is closed"); }
      while (inFlight >= MAX_IN_FLIGHT_FRAMES) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new DOMException("Export aborted", "AbortError"));
          encodeSignal?.addEventListener("abort", onAbort, { once: true });
          capacityWaiters.push(() => {
            encodeSignal?.removeEventListener("abort", onAbort);
            resolve();
          });
        });
      }
      if (encodeSignal?.aborted) { frame.close(); abort(); throw new DOMException("Export aborted", "AbortError"); }
      const acknowledged = new Promise<void>((resolve, reject) => frameWaiters.set(id, { resolve, reject }));
      inFlight++;
      try {
        worker.postMessage({ type: "frame", id, frame, keyFrame } satisfies WorkerVideoRequest, [frame]);
      } catch (error) {
        frame.close();
        frameWaiters.delete(id);
        inFlight--;
        wakeCapacity();
        throw error;
      }
      // Keep the producer bounded, but allow capture N+1 while the worker encodes N.
      if (inFlight >= MAX_IN_FLIGHT_FRAMES) await acknowledged;
    },
    async finish(finishSignal) {
      if (finishSignal?.aborted) abort();
      await Promise.all(Array.from(frameWaiters.values(), (waiter) => new Promise<void>((resolve, reject) => {
        const originalResolve = waiter.resolve;
        const originalReject = waiter.reject;
        waiter.resolve = () => { originalResolve(); resolve(); };
        waiter.reject = (error: Error) => { originalReject(error); reject(error); };
      })));
      if (terminalError) throw terminalError;
      worker.postMessage({ type: "finish" } satisfies WorkerVideoRequest);
      return await finished;
    },
    abort,
  };
}
