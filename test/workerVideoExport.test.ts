import { afterEach, describe, expect, it, vi } from "vitest";
import { isWorkerVideoExportEnabled } from "../src/runtime/workerVideoExport";

describe("worker video export feature gate", () => {
  const originalWorker = globalThis.Worker;

  afterEach(() => {
    delete (globalThis as { __mafterWorkerVideoExport?: unknown }).__mafterWorkerVideoExport;
    vi.stubGlobal("Worker", originalWorker);
  });

  it("stays off by default after a regressive A/B result", () => {
    vi.stubGlobal("Worker", class {});
    expect(isWorkerVideoExportEnabled()).toBe(false);
  });

  it("requires both explicit opt-in and Worker support", () => {
    (globalThis as { __mafterWorkerVideoExport?: unknown }).__mafterWorkerVideoExport = true;
    vi.stubGlobal("Worker", class {});
    expect(isWorkerVideoExportEnabled()).toBe(true);
    vi.stubGlobal("Worker", undefined);
    expect(isWorkerVideoExportEnabled()).toBe(false);
  });
});
