/// <reference types="@cloudflare/workers-types" />
import { DurableSwarmSession, joinCodeFromSessionId } from "../src/swarm/signaling/durableSessionCore";
import type { CreateSwarmSessionInput, JoinSwarmSessionInput, SwarmSignal } from "../src/swarm/core/types";

interface Env {
  SWARM_SESSION: DurableObjectNamespace;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

const json = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...CORS } });

function randomToken(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[value % 32]).join("");
}

/** Routes every action for one session to a single object; join code is the object name. */
function sessionName(action: string, body: Record<string, unknown>): string {
  if (action === "join") return String(body.joinCode ?? "").trim().toUpperCase();
  return joinCodeFromSessionId(String(body.sessionId ?? ""));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "POST") return json(405, { ok: false, error: "POST required" });
    try {
      const action = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const requested = String(body.joinCode ?? "").trim().toUpperCase();
      const name = action === "create"
        ? (/^[A-Z0-9]{4,12}$/.test(requested) ? requested : randomToken(6))
        : sessionName(action, body);
      if (!name) return json(400, { ok: false, error: "Unknown swarm session" });
      const stub = env.SWARM_SESSION.get(env.SWARM_SESSION.idFromName(name));
      return await stub.fetch(new Request(`https://swarm/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, joinCode: name }),
      }));
    } catch (error) {
      console.error("swarm worker failed", error);
      return json(400, { ok: false, error: error instanceof Error ? error.message : "Swarm request failed" });
    }
  },
};

export class SwarmSessionObject {
  private readonly session: DurableSwarmSession;
  private waiters = new Set<() => void>();

  constructor(private readonly state: DurableObjectState) {
    this.session = new DurableSwarmSession({
      get: (key) => this.state.storage.get(key),
      put: (key, value) => this.state.storage.put(key, value),
      delete: async (key) => { await this.state.storage.delete(key); },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.slice(1);
    const body = (await request.json()) as Record<string, unknown>;
    try {
      if (action === "create") {
        const value = await this.session.createSession(
          body as unknown as CreateSwarmSessionInput,
          String(body.joinCode),
          randomToken(12),
        );
        return json(200, { ok: true, value });
      }
      if (action === "join") {
        const value = await this.session.joinSession(body as unknown as JoinSwarmSessionInput);
        this.wake();
        return json(200, { ok: true, value });
      }
      if (action === "approve") {
        await this.session.approveJoin(String(body.sessionId), String(body.hostPeerId), String(body.peerId), body.approved === true);
        this.wake();
        return json(200, { ok: true, value: null });
      }
      if (action === "signal") {
        await this.session.sendSignal(String(body.sessionId), String(body.fromPeerId), String(body.toPeerId), body.signal as SwarmSignal);
        this.wake();
        return json(200, { ok: true, value: null });
      }
      if (action === "events") {
        const events = await this.longPoll(String(body.sessionId), String(body.peerId), Number(body.waitMs) || 20_000);
        return json(200, { ok: true, value: { events } });
      }
      if (action === "close") {
        await this.session.closeSession(String(body.sessionId));
        this.wake();
        return json(200, { ok: true, value: null });
      }
      return json(404, { ok: false, error: "Unknown swarm action" });
    } catch (error) {
      console.error("swarm session failed", action, error);
      return json(400, { ok: false, error: error instanceof Error ? error.message : "Swarm request failed" });
    }
  }

  private async longPoll(sessionId: string, peerId: string, waitMs: number): Promise<unknown[]> {
    const deadline = Date.now() + Math.min(25_000, Math.max(100, waitMs));
    for (;;) {
      const events = await this.session.takeEvents(sessionId, peerId);
      if (events.length > 0 || Date.now() >= deadline) return events;
      await this.waitForWake(deadline - Date.now());
    }
  }

  private waitForWake(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { this.waiters.delete(done); clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.add(done);
    });
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}
