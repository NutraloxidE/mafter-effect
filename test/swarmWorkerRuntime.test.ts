import { describe, expect, it, vi } from "vitest";
import { WorkerRuntime } from "../src/swarm/worker/WorkerRuntime";
import { createSwarmMessage, type SwarmMessageEnvelope } from "../src/swarm/core/protocol";
import { splitAssetIntoChunks } from "../src/swarm/transport/assetChunks";
import type { WorkerRenderExecutor } from "../src/swarm/worker/workerRenderExecutor";

function runtimeWithProtocol(cacheAsset: (transfer: unknown) => Promise<boolean>) {
  const sent: SwarmMessageEnvelope[] = [];
  const runtime = new WorkerRuntime({
    backend: {} as never,
    label: "test worker",
    executor: { cacheAsset } as unknown as WorkerRenderExecutor,
  });
  const protocol = { send: vi.fn(async (message: SwarmMessageEnvelope) => { sent.push(message); }) };
  (runtime as unknown as { peer: { protocol: typeof protocol } }).peer = { protocol };
  const handleMessage = (runtime as unknown as {
    handleMessage: (message: SwarmMessageEnvelope) => Promise<void>;
  }).handleMessage.bind(runtime);
  return { runtime, sent, protocol, handleMessage };
}

describe("swarm worker asset readiness", () => {
  it("shares one in-flight cache promise for duplicate asset delivery", async () => {
    let release!: (ok: boolean) => void;
    const cache = new Promise<boolean>((resolve) => { release = resolve; });
    const cacheAsset = vi.fn(() => cache);
    const { sent, handleMessage } = runtimeWithProtocol(cacheAsset);
    const transfer = { path: "assets/a.bin", contentHash: "hash-a", bytesBase64: "payload" };
    const chunk = splitAssetIntoChunks(transfer)[0]!;
    const message = createSwarmMessage("asset-chunk", chunk);

    const first = handleMessage(message);
    const second = handleMessage(message);
    await Promise.resolve();
    expect(cacheAsset).toHaveBeenCalledTimes(1);

    release(true);
    await Promise.all([first, second]);
    const assetReady = sent.filter((item): item is SwarmMessageEnvelope<"asset-ready"> => item.type === "asset-ready");
    expect(assetReady).toHaveLength(2);
    expect(assetReady.every((item) => item.payload.ok)).toBe(true);
  });

  it("does not report READY until the host closes the asset sync phase", async () => {
    const { runtime, handleMessage } = runtimeWithProtocol(async () => true);
    const setState = (runtime as unknown as { setState: (state: "syncing") => void }).setState.bind(runtime);
    setState("syncing");
    expect(runtime.getSnapshot().state).toBe("syncing");
    await handleMessage(createSwarmMessage("asset-sync-complete", {}));
    expect(runtime.getSnapshot().state).toBe("ready");
  });
});
