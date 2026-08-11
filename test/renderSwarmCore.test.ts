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
import { buildSwarmRenderCacheKey, validateSwarmRenderResult } from "../src/swarm/core/cacheKey";
import { SwarmScheduler } from "../src/swarm/core/scheduler";
import { InMemorySwarmSignalingBackend } from "../src/swarm/signaling/inMemory";
import { DEFAULT_SWARM_SIGNALING_URL, defaultSignalingEndpoint, VercelSignalingBackend } from "../src/swarm/signaling/vercel";
import type { SwarmRenderJob } from "../src/swarm/core/types";
import swarmHandler from "../api/swarm/[action]";
import { DurableSwarmSession, joinCodeFromSessionId } from "../src/swarm/signaling/durableSessionCore";

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
