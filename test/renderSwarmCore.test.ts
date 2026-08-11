import {
  createDeviceIdentity,
  signChallenge,
  verifyChallenge,
} from "../src/swarm/core/identity";
import {
  createSwarmMessage,
  parseSwarmMessage,
  serializeSwarmMessage,
} from "../src/swarm/core/protocol";
import { createBenchmarkJob, normalizedBenchmarkScore } from "../src/swarm/core/benchmark";
import { collectJobFilePaths, isSwarmJobSelfContained } from "../src/swarm/core/jobFiles";
import { buildExportSwarmJob, createRemoteFrameProducer, spotCheckFrames } from "../src/swarm/core/remoteFrameProducer";
import { meanAbsoluteDifference, pixelSpread, SWARM_FRAME_TOLERANCE } from "../src/swarm/core/frameVerification";
import { AssetChunkAssembler, ResultChunkAssembler, splitAssetIntoChunks, splitResultBytes } from "../src/swarm/transport/assetChunks";
import { buildSwarmRenderCacheKey, validateSwarmRenderResult } from "../src/swarm/core/cacheKey";
import { SwarmScheduler } from "../src/swarm/core/scheduler";
import { InMemorySwarmSignalingBackend } from "../src/swarm/signaling/inMemory";
import { DEFAULT_SWARM_SIGNALING_URL, defaultSignalingEndpoint, VercelSignalingBackend } from "../src/swarm/signaling/vercel";
import type { SwarmRenderJob } from "../src/swarm/core/types";
import { extractBuildTag, isWorkerOutdated } from "../src/swarm/worker/workerUpdateCheck";
import swarmHandler from "../api/swarm/[action]";
import { DurableSwarmSession, joinCodeFromSessionId, SWARM_SESSION_TTL_MS } from "../src/swarm/signaling/durableSessionCore";

function job(id: string, frame: number, priority: SwarmRenderJob["priority"] = "background"): SwarmRenderJob {
  return {
    id,
    kind: "preview-frame",
    renderRevision: "rev-1",
    compositionId: "comp-1",
    frameStart: frame,
    frameEnd: frame + 1,
    priority,
    profile: { quality: "draft", proxy: "half", width: 320, height: 180 },
    runtimeVersion: "runtime-1",
    project: { schemaVersion: 1, meta: { name: "test", createdAt: "", updatedAt: "" }, assets: [], compositions: [], rootComposition: "", pluginRefs: [] },
    createdAt: frame,
  };
}

describe("Render Swarm core", () => {
  it("validates versioned messages and rejects malformed or unknown versions", () => {
    const message = createSwarmMessage("ping", { at: 1 });
    const encoded = serializeSwarmMessage(message);
    expect(parseSwarmMessage(encoded)?.type).toBe("ping");
    expect(parseSwarmMessage("not json")).toBeNull();
    expect(parseSwarmMessage(JSON.stringify({ ...message, protocolVersion: 2 }))).toBeNull();
    expect(parseSwarmMessage(JSON.stringify({ ...message, payload: null }))).toBeNull();
    expect(parseSwarmMessage(JSON.stringify({ ...createSwarmMessage("job-offer", { job: job("job", 0) }), payload: {} }))).toBeNull();
  });

  it("creates a stable cryptographic identity and verifies only the matching challenge", async () => {
    const identity = await createDeviceIdentity();
    const signature = await signChallenge(identity, "nonce-a");
    await expect(verifyChallenge(identity.publicKeyJwk, "nonce-a", signature)).resolves.toBe(true);
    await expect(verifyChallenge(identity.publicKeyJwk, "nonce-b", signature)).resolves.toBe(false);
  });

  it("pull-schedules priority work and requeues a disconnected lease", () => {
    const scheduler = new SwarmScheduler();
    scheduler.registerWorker({ slotId: "fast", score: 2, reliability: 1, connected: true });
    scheduler.registerWorker({ slotId: "slow", score: 1, reliability: 1, connected: true });
    scheduler.enqueue(job("background", 1));
    scheduler.enqueue(job("playhead", 2, "playhead"));
    expect(scheduler.requestJob("fast", 0)?.id).toBe("playhead");
    expect(scheduler.requestJob("slow", 0)?.id).toBe("background");
    scheduler.removeWorker("fast");
    expect(scheduler.get("playhead")?.state).toBe("pending");
    expect(scheduler.getSnapshot().requeued).toBe(1);
  });

  it("expires leases and rejects stale render results", () => {
    const scheduler = new SwarmScheduler();
    scheduler.registerWorker({ slotId: "worker", score: 1, reliability: 1, connected: true });
    scheduler.enqueue(job("job-1", 4));
    const leased = scheduler.requestJob("worker", 100, 10);
    expect(leased?.state).toBe("leased");
    scheduler.reclaimExpired(110);
    expect(scheduler.get("job-1")?.state).toBe("pending");
    const key = buildSwarmRenderCacheKey({ renderRevision: "rev-1", compositionId: "comp-1", frame: 4, profile: job("x", 4).profile, runtimeVersion: "runtime-1" });
    expect(key).toContain("rev-1");
    expect(validateSwarmRenderResult({
      jobId: "job-1", renderRevision: "old", compositionId: "comp-1", frameStart: 4, frameEnd: 5,
      width: 320, height: 180, format: "png", bytesBase64: "AQ==", byteLength: 1, runtimeVersion: "runtime-1",
    }, { jobId: "job-1", renderRevision: "rev-1", compositionId: "comp-1", frame: 4, profile: job("x", 4).profile, runtimeVersion: "runtime-1" })).toBe(false);
  });

  it("keeps signaling lifecycle event-driven", async () => {
    const backend = new InMemorySwarmSignalingBackend();
    const hostEvents: string[] = [];
    const host = await backend.createSession({ hostPeerId: "host", hostDeviceId: "host-device", hostLabel: "Host" });
    await backend.subscribe(host.sessionId, "host", (event) => hostEvents.push(event.type));
    const peer = { peerId: "peer", deviceId: "device", label: "Phone", publicKeyJwk: {}, requestedAt: 0 };
    await backend.joinSession({ joinCode: host.joinCode, peer });
    expect(hostEvents).toEqual(["peer-join-request"]);
    await backend.approveJoin(host.sessionId, "host", "peer", true);
    expect(hostEvents).toEqual(["peer-join-request"]);
  });

  it("falls back to local rendering whenever the swarm cannot supply an export frame", async () => {
    const comp = { id: "comp-1", name: "Main", kind: "timeline" as const, width: 320, height: 180, fps: 30, duration: 10, objects: [] } as never;
    const project = { schemaVersion: 1, meta: { name: "t", createdAt: "", updatedAt: "" }, assets: [], compositions: [comp], rootComposition: "comp-1", pluginRefs: [] } as never;
    const remoteCanvas = {} as HTMLCanvasElement;
    const localCanvas = {} as HTMLCanvasElement;
    const base = {
      project, comp, renderRevision: "rev-1",
      profile: { quality: "draft" as const, proxy: "full", width: 320, height: 180 },
      renderLocally: async () => localCanvas,
      decodePng: async () => remoteCanvas,
      decodeZip: async () => new Map<number, HTMLCanvasElement>(),
      timeoutMs: 30_000,
    };
    const result = (frame: number, renderRevision = "rev-1") => ({
      jobId: "j", renderRevision, compositionId: "comp-1", frameStart: frame, frameEnd: frame + 1,
      width: 320, height: 180, format: "png" as const, bytesBase64: "AQ==", byteLength: 1, runtimeVersion: "runtime-1",
    });

    expect(await createRemoteFrameProducer({ ...base, submit: async () => result(7) })(7)).toBe(remoteCanvas);
    // Declined, wrong frame, stale revision and a throwing transport all render locally.
    expect(await createRemoteFrameProducer({ ...base, submit: async () => null })(7)).toBe(localCanvas);
    expect(await createRemoteFrameProducer({ ...base, submit: async () => result(8) })(7)).toBe(localCanvas);
    expect(await createRemoteFrameProducer({ ...base, submit: async () => result(7, "old") })(7)).toBe(localCanvas);
    expect(await createRemoteFrameProducer({ ...base, submit: async () => { throw new Error("gone"); } })(7)).toBe(localCanvas);

    const job = buildExportSwarmJob(base, 4);
    expect([job.frameStart, job.frameEnd, job.compositionId]).toEqual([4, 5, "comp-1"]);
  });

  it("accepts rasterizer-level noise but rejects a frame with missing content", () => {
    const size = 64 * 64 * 4;
    const base = new Uint8ClampedArray(size).fill(128);

    // Same pixels.
    expect(meanAbsoluteDifference(base, base)).toBe(0);

    // A different GPU / font rasterizer nudges channels slightly: still the same frame.
    const noisy = new Uint8ClampedArray(base);
    for (let i = 0; i < noisy.length; i += 1) noisy[i] = 128 + (i % 3);
    expect(meanAbsoluteDifference(base, noisy)).toBeLessThan(SWARM_FRAME_TOLERANCE);

    // A missing font or asset leaves whole regions blank.
    const missing = new Uint8ClampedArray(base);
    missing.fill(0, 0, Math.floor(size / 4));
    expect(meanAbsoluteDifference(base, missing)).toBeGreaterThan(SWARM_FRAME_TOLERANCE);

    // Different dimensions are never acceptable.
    expect(meanAbsoluteDifference(base, new Uint8ClampedArray(size / 2).fill(128))).toBe(Infinity);
    expect(meanAbsoluteDifference(new Uint8ClampedArray(0), new Uint8ClampedArray(0))).toBe(Infinity);
  });

  it("spot-checks a sample of frames including the first", () => {
    expect(spotCheckFrames(0)).toEqual([]);
    expect(spotCheckFrames(150)).toContain(0);
    expect(spotCheckFrames(150).length).toBeGreaterThanOrEqual(7);
    expect(spotCheckFrames(150).every((f) => f >= 0 && f < 150)).toBe(true);
    // A short export must not collapse to a single checked frame: 5% of 24 rounds to 1.
    expect(spotCheckFrames(24).length).toBeGreaterThanOrEqual(4);
    expect(spotCheckFrames(3).length).toBe(3);

    // A frame that lost its footage is nearly flat compared with a real one.
    const real = new Uint8ClampedArray(64 * 64 * 4);
    for (let i = 0; i < real.length; i += 1) real[i] = (i * 37) % 256;
    const blank = new Uint8ClampedArray(64 * 64 * 4).fill(16);
    expect(pixelSpread(blank)).toBeLessThan(pixelSpread(real) * 0.2);
  });

  it("reloads a worker only when the deployment actually changed", async () => {
    const page = (tag: string) => `<!doctype html><script type="module" crossorigin src="${tag}"></script>`;
    expect(extractBuildTag(page("/assets/index-AzvKVu_0.js"))).toBe("/assets/index-AzvKVu_0.js");
    expect(extractBuildTag("<html><body>no bundle</body></html>")).toBeNull();

    // Minimal stand-in for the running document: only the script src matters.
    const doc = {
      querySelectorAll: () => [{ getAttribute: () => "/assets/index-OLD00000.js" }],
    } as unknown as Document;
    const check = (body: string, ok = true) => isWorkerOutdated({
      doc,
      fetchImpl: async () => new Response(body, { status: ok ? 200 : 500 }),
    });
    await expect(check(page("/assets/index-NEW11111.js"))).resolves.toBe(true);
    await expect(check(page("/assets/index-OLD00000.js"))).resolves.toBe(false);
    // A failed or unparsable check must never take a working worker offline.
    await expect(check(page("/assets/index-NEW11111.js"), false)).resolves.toBe(false);
    await expect(check("<html>proxy error</html>")).resolves.toBe(false);
    await expect(isWorkerOutdated({ doc, fetchImpl: async () => { throw new Error("offline"); } })).resolves.toBe(false);
  });

  it("round-trips the worker availability message", () => {
    const message = createSwarmMessage("worker-availability", { available: false, reason: "page-visibility" });
    const parsed = parseSwarmMessage(serializeSwarmMessage(message));
    expect(parsed?.type).toBe("worker-availability");
    expect((parsed?.payload as { available: boolean }).available).toBe(false);
    // A missing flag must not be read as "available".
    expect(parseSwarmMessage(JSON.stringify({ ...message, payload: {} }))).toBeNull();
  });

  it("carries a rendered frame as chunks and accepts a result whose pixels travelled separately", () => {
    const chunks = splitResultBytes("job-1", "ABCDEFGHIJ", 4);
    expect(chunks.map((c) => c.bytesBase64)).toEqual(["ABCD", "EFGH", "IJ"]);

    const assembler = new ResultChunkAssembler();
    expect(assembler.take("job-1")).toBeNull();
    for (const chunk of [chunks[2]!, chunks[0]!, chunks[1]!]) assembler.accept(chunk);
    expect(assembler.take("job-1")).toBe("ABCDEFGHIJ");
    expect(assembler.take("job-1")).toBeNull();

    // A frame this size cannot ride in one message, so the result message carries no pixels and
    // must still parse — requiring a non-empty string here silently dropped every result.
    const result = {
      jobId: "job-1", renderRevision: "rev-1", compositionId: "comp-1", frameStart: 0, frameEnd: 1,
      width: 960, height: 540, format: "png" as const, bytesBase64: "", byteLength: 350_000,
      runtimeVersion: "runtime-1",
    };
    expect(parseSwarmMessage(serializeSwarmMessage(createSwarmMessage("job-result", result)))?.type).toBe("job-result");
  });

  it("splits and reassembles a file across chunks, ignoring order and duplicates", () => {
    const transfer = { path: "assets/clip.mp4", contentHash: "hash-1", mimeType: "video/mp4", bytesBase64: "ABCDEFGHIJ" };
    const chunks = splitAssetIntoChunks(transfer, 3);
    expect(chunks.map((c) => c.bytesBase64)).toEqual(["ABC", "DEF", "GHI", "J"]);

    const assembler = new AssetChunkAssembler();
    const shuffled = [chunks[3]!, chunks[1]!, chunks[1]!, chunks[0]!];
    for (const chunk of shuffled) expect(assembler.accept(chunk)).toBeNull();
    expect(assembler.accept(chunks[2]!)).toEqual(transfer);
    // Nothing is left pending once a file completes.
    expect(assembler.accept(chunks[0]!)).toBeNull();
  });

  it("collects the files a composition needs and keeps under-supplied jobs local", () => {
    const comp = {
      id: "comp-1", name: "Main", kind: "timeline" as const, width: 320, height: 180, fps: 30, duration: 10,
      objects: [{
        id: "obj-1",
        components: [{ id: "c1", type: "image", props: { assetId: "asset-1" } }],
        transform: { position: { value: [0, 0, 0], expression: { path: "scripts/obj-1/position.js", enabled: true } } },
      }],
    } as never;
    const project = {
      schemaVersion: 1, meta: { name: "t", createdAt: "", updatedAt: "" },
      assets: [{ id: "asset-1", path: "assets/logo.png", kind: "image" as const }],
      compositions: [comp], rootComposition: "comp-1", pluginRefs: [],
    } as never;

    // Asset referenced by id, expression script referenced by path.
    expect(collectJobFilePaths(project, comp)).toEqual(["assets/logo.png", "scripts/obj-1/position.js"]);

    const base = { ...job("j", 0), compositionId: "comp-1", project };
    expect(isSwarmJobSelfContained(base, comp)).toBe(false);
    expect(isSwarmJobSelfContained({ ...base, assets: [{ path: "assets/logo.png", contentHash: "h", bytesBase64: "" }] }, comp)).toBe(false);
    expect(isSwarmJobSelfContained({ ...base, assets: [
      { path: "assets/logo.png", contentHash: "h", bytesBase64: "" },
      { path: "scripts/obj-1/position.js", contentHash: "h2", bytesBase64: "" },
    ] }, comp)).toBe(true);
  });

  it("scores workers relative to the host on a self-contained benchmark job", () => {
    const job = createBenchmarkJob("runtime-1");
    // Must not depend on the user project: an empty comp is renderable on any worker.
    expect(job.project.assets).toEqual([]);
    expect(job.project.compositions[0]?.kind).toBe("timeline");
    expect(job.runtimeVersion).toBe("runtime-1");
    // A worker twice as fast as the host adds 2.0x, not its raw frames/second.
    expect(normalizedBenchmarkScore(60, 30)).toBe(2);
    expect(normalizedBenchmarkScore(30, 30)).toBe(1);
    expect(normalizedBenchmarkScore(30, 0)).toBe(0);
  });

  it("lets the same host reattach to its join code and refuses another device", async () => {
    const storage = new Map<string, unknown>();
    const kv = {
      get: async <T,>(key: string) => storage.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { storage.set(key, value); },
      delete: async (key: string) => { storage.delete(key); },
    };
    const host = { hostPeerId: "host-1", hostDeviceId: "device-A", hostLabel: "Host" };
    const first = await new DurableSwarmSession(kv).createSession(host, "CODE12", "RANDOM000001");

    // Same device, new peer id (a restarted host): same session, so approved workers stay valid.
    const again = await new DurableSwarmSession(kv)
      .createSession({ ...host, hostPeerId: "host-2" }, "CODE12", "RANDOM000002");
    expect(again.sessionId).toBe(first.sessionId);

    // A different device asking for the same code does not inherit the session.
    const other = await new DurableSwarmSession(kv)
      .createSession({ ...host, hostDeviceId: "device-B" }, "CODE12", "RANDOM000003");
    expect(other.sessionId).not.toBe(first.sessionId);
  });

  it("keeps rendezvous state durable across separate handler instances", async () => {
    // Durable storage is shared; each request builds a fresh session object, exactly like a
    // Durable Object serving successive requests (and unlike the per-instance Vercel Map).
    const storage = new Map<string, unknown>();
    const kv = {
      get: async <T,>(key: string) => storage.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { storage.set(key, value); },
      delete: async (key: string) => { storage.delete(key); },
    };
    const created = await new DurableSwarmSession(kv).createSession(
      { hostPeerId: "host", hostDeviceId: "host-device", hostLabel: "Host" },
      "ABC123",
      "RANDOM123456",
    );
    expect(joinCodeFromSessionId(created.sessionId)).toBe("ABC123");
    // The join window outlives a working session: peers are P2P once connected.
    expect(created.expiresAt - Date.now()).toBeGreaterThan(SWARM_SESSION_TTL_MS - 60_000);

    const peer = { peerId: "peer", deviceId: "device", label: "Phone", publicKeyJwk: {}, requestedAt: 0 };
    await new DurableSwarmSession(kv).joinSession({ joinCode: "ABC123", peer });
    expect(await new DurableSwarmSession(kv).takeEvents(created.sessionId, "host"))
      .toEqual([{ type: "peer-join-request", peer }]);
    // Drained queues do not redeliver.
    expect(await new DurableSwarmSession(kv).takeEvents(created.sessionId, "host")).toEqual([]);

    await new DurableSwarmSession(kv).approveJoin(created.sessionId, "host", "peer", true);
    await new DurableSwarmSession(kv).sendSignal(created.sessionId, "host", "peer", {
      kind: "candidate", candidate: { candidate: "c" },
    });
    expect((await new DurableSwarmSession(kv).takeEvents(created.sessionId, "peer")).map((e) => e.type))
      .toEqual(["peer-approved", "signal"]);

    await expect(new DurableSwarmSession(kv).joinSession({ joinCode: "NOPE", peer }))
      .rejects.toThrow("Unknown swarm join code");
  });

  it("answers events for an unknown session with a JSON error instead of crashing", async () => {
    let status = 0;
    let payload: unknown;
    const res = {
      status(code: number) { status = code; return res; },
      json(value: unknown) { payload = value; return res; },
      end() {},
    };
    await swarmHandler(
      { method: "POST", query: { action: "events" }, body: { sessionId: "missing", peerId: "peer", waitMs: 100 } },
      res,
    );
    expect(status).toBe(400);
    expect(payload).toEqual({ ok: false, error: "Unknown swarm session" });
  });

  it("defaults signaling to the deployed durable object worker", () => {
    expect(defaultSignalingEndpoint()).toBe(DEFAULT_SWARM_SIGNALING_URL);
    expect(DEFAULT_SWARM_SIGNALING_URL.startsWith("https://")).toBe(true);
  });

  it("reports non-JSON signaling failures without leaking a JSON parser error", async () => {
    const backend = new VercelSignalingBackend({
      endpoint: "http://example.test/api/swarm",
      fetchImpl: async () => new Response("A server error occurred", { status: 500 }),
    });
    await expect(backend.createSession({
      hostPeerId: "host",
      hostDeviceId: "device",
      hostLabel: "Host",
    })).rejects.toThrow("returned non-JSON (HTTP 500): A server error occurred");
  });
});
