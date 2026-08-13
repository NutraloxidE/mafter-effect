import { describe, expect, it, vi } from "vitest";
import { WorkerRuntime } from "../src/swarm/worker/WorkerRuntime";
import { createSwarmMessage, type SwarmMessageEnvelope } from "../src/swarm/core/protocol";
import { splitAssetIntoChunks } from "../src/swarm/transport/assetChunks";
import type { WorkerRenderExecutor } from "../src/swarm/worker/workerRenderExecutor";
import { BoundedWorkerAssetCache } from "../src/swarm/worker/workerCache";
import { sha256Hex } from "../src/swarm/core/assetManifest";

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
    const { runtime, sent, handleMessage } = runtimeWithProtocol(async () => true);
    const setState = (runtime as unknown as { setState: (state: "syncing") => void }).setState.bind(runtime);
    setState("syncing");
    expect(runtime.getSnapshot().state).toBe("syncing");
    await handleMessage(createSwarmMessage("asset-manifest", {
      generation: "generation-1",
      assets: [],
    }));
    expect(sent.some((item) => item.type === "asset-manifest-state")).toBe(true);
    await handleMessage(createSwarmMessage("asset-sync-complete", { generation: "generation-1" }));
    const ready = sent.find((item): item is SwarmMessageEnvelope<"asset-manifest-ready"> => item.type === "asset-manifest-ready");
    expect(ready?.payload.ok).toBe(true);
    expect(runtime.getSnapshot().state).toBe("ready");
  });

  it("keeps the worker syncing when the manifest is larger than its cache", async () => {
    const { runtime, sent, handleMessage } = runtimeWithProtocol(async () => true);
    const setState = (runtime as unknown as { setState: (state: "syncing") => void }).setState.bind(runtime);
    setState("syncing");
    await handleMessage(createSwarmMessage("asset-manifest", {
      generation: "generation-too-large",
      assets: [{ contentHash: "not-in-cache", byteLength: 1 }],
    }));
    await handleMessage(createSwarmMessage("asset-sync-complete", { generation: "generation-too-large" }));
    const ready = sent.find((item): item is SwarmMessageEnvelope<"asset-manifest-ready"> => item.type === "asset-manifest-ready");
    expect(ready?.payload.ok).toBe(false);
    expect(runtime.getSnapshot().state).toBe("syncing");
  });
});

describe("worker asset LRU manifest", () => {
  it("reports the exact post-eviction hash set", async () => {
    const encode = (bytes: Uint8Array): string => {
      let text = "";
      for (const byte of bytes) text += String.fromCharCode(byte);
      return btoa(text);
    };
    const transfer = async (path: string, bytes: Uint8Array) => ({
      path,
      contentHash: await sha256Hex(bytes),
      bytesBase64: encode(bytes),
    });
    const cache = new BoundedWorkerAssetCache(4);
    const a = await transfer("assets/a", Uint8Array.from([1, 2]));
    const b = await transfer("assets/b", Uint8Array.from([3, 4]));
    const c = await transfer("assets/c", Uint8Array.from([5, 6]));
    await expect(cache.put(a)).resolves.toBe(true);
    await expect(cache.put(b)).resolves.toBe(true);
    expect(cache.hashes()).toEqual([a.contentHash, b.contentHash]);
    expect(cache.get(a.contentHash)).not.toBeNull();
    await expect(cache.put(c)).resolves.toBe(true);
    expect(cache.hashes()).toEqual([a.contentHash, c.contentHash]);
    expect(cache.get(b.contentHash)).toBeNull();
  });
});
