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
import { buildSwarmRenderCacheKey, validateSwarmRenderResult } from "../src/swarm/core/cacheKey";
import { SwarmScheduler } from "../src/swarm/core/scheduler";
import { InMemorySwarmSignalingBackend } from "../src/swarm/signaling/inMemory";
import { VercelSignalingBackend } from "../src/swarm/signaling/vercel";
import type { SwarmRenderJob } from "../src/swarm/core/types";

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
