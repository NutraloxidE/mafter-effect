import { phaseToSeed } from "./effectSvg";
import { parsePixelSortParams } from "./pixelSortParams";
import { processPixelSort } from "./pixelSort";
import type { RasterBuffer } from "./plugin";
import type { RasterProcessRequest, RasterProcessResponse } from "./workers/rasterProcess.worker";

function defaultPoolSize(): number {
  if (typeof navigator === "undefined") return 1;
  const cores = navigator.hardwareConcurrency ?? 2;
  return Math.max(1, Math.min(4, cores - 1));
}

interface PendingJob {
  resolve: (v: RasterBuffer) => void;
  reject: (e: Error) => void;
}

class RasterWorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private pending = new Map<number, PendingJob>();
  private jobQueue: Array<{ worker: Worker | null; req: RasterProcessRequest }> = [];
  private nextId = 0;
  private enabled = true;

  constructor(poolSize: number) {
    if (typeof Worker === "undefined") {
      this.enabled = false;
      return;
    }
    try {
      for (let i = 0; i < poolSize; i++) {
        const w = new Worker(new URL("./workers/rasterProcess.worker.ts", import.meta.url), { type: "module" });
        w.onmessage = (ev: MessageEvent<RasterProcessResponse>) => this.onResult(w, ev.data);
        w.onerror = () => this.onWorkerError(w);
        this.workers.push(w);
        this.idle.push(w);
      }
    } catch {
      this.dispose();
      this.enabled = false;
    }
  }

  get isAvailable(): boolean {
    return this.enabled && this.workers.length > 0;
  }

  async processPixelSort(
    input: RasterBuffer,
    props: Record<string, unknown>,
    frame: number,
  ): Promise<RasterBuffer> {
    const params = parsePixelSortParams(props);
    const seed = phaseToSeed(frame);
    if (!this.isAvailable) {
      return processPixelSort(input, params, seed);
    }
    const id = this.nextId++;
    const data = new Uint8ClampedArray(input.data);
    const req: RasterProcessRequest = {
      id,
      input: { data, width: input.width, height: input.height },
      params,
      seed,
    };
    return new Promise<RasterBuffer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.jobQueue.push({ worker: null, req });
      this.dispatch();
    });
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
    for (const p of this.pending.values()) p.reject(new Error("pool disposed"));
    this.pending.clear();
    this.jobQueue = [];
    this.enabled = false;
  }

  private dispatch(): void {
    while (this.jobQueue.length > 0 && this.idle.length > 0) {
      const job = this.jobQueue.shift()!;
      const worker = this.idle.pop()!;
      job.worker = worker;
      worker.postMessage(job.req, [job.req.input.data.buffer]);
    }
  }

  private onResult(worker: Worker, msg: RasterProcessResponse): void {
    this.idle.push(worker);
    const p = this.pending.get(msg.id);
    if (!p) {
      this.dispatch();
      return;
    }
    this.pending.delete(msg.id);
    if (msg.error || !msg.output) p.reject(new Error(msg.error ?? "raster worker failed"));
    else p.resolve(msg.output);
    this.dispatch();
  }

  private onWorkerError(worker: Worker): void {
    this.workers = this.workers.filter((w) => w !== worker);
    this.idle = this.idle.filter((w) => w !== worker);
    worker.terminate();
    this.dispatch();
  }
}

export const globalRasterWorkerPool = new RasterWorkerPool(defaultPoolSize());

export function disposeRasterWorkerPool(): void {
  globalRasterWorkerPool.dispose();
}
