import { getVercelServerBackend } from "../../src/swarm/signaling/vercelServer";
import type { CreateSwarmSessionInput, JoinSwarmSessionInput, SwarmSignal } from "../../src/swarm/core/types";

interface VercelRequest {
  method?: string;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
}

interface VercelResponse {
  status(code: number): VercelResponse;
  json(value: unknown): VercelResponse;
  end(): void;
}

interface BodyRecord {
  [key: string]: unknown;
}

function record(value: unknown): BodyRecord {
  return typeof value === "object" && value !== null ? value as BodyRecord : {};
}

function actionFromRequest(req: VercelRequest): string {
  const value = req.query?.action;
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "POST required" });
    return;
  }
  const body = record(req.body);
  const backend = getVercelServerBackend();
  try {
    const action = actionFromRequest(req);
    if (action === "create") {
      const value = await backend.createSession(body as unknown as CreateSwarmSessionInput);
      res.status(200).json({ ok: true, value });
      return;
    }
    if (action === "join") {
      const value = await backend.joinSession(body as unknown as JoinSwarmSessionInput);
      res.status(200).json({ ok: true, value });
      return;
    }
    if (action === "approve") {
      await backend.approveJoin(String(body.sessionId), String(body.hostPeerId), String(body.peerId), body.approved === true);
      res.status(200).json({ ok: true, value: null });
      return;
    }
    if (action === "signal") {
      await backend.sendSignal(String(body.sessionId), String(body.fromPeerId), String(body.toPeerId), body.signal as SwarmSignal);
      res.status(200).json({ ok: true, value: null });
      return;
    }
    if (action === "events") {
      const events = await collectEvents(backend, String(body.sessionId), String(body.peerId), Number(body.waitMs) || 20_000);
      res.status(200).json({ ok: true, value: { events } });
      return;
    }
    if (action === "close") {
      await backend.closeSession(String(body.sessionId));
      res.status(200).json({ ok: true, value: null });
      return;
    }
    res.status(404).json({ ok: false, error: "Unknown swarm action" });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Swarm request failed" });
  }
}

async function collectEvents(
  backend: ReturnType<typeof getVercelServerBackend>,
  sessionId: string,
  peerId: string,
  waitMs: number,
): Promise<unknown[]> {
  const events: unknown[] = [];
  let unsubscribe: (() => void) | undefined;
  const result = new Promise<void>((resolve) => {
    void backend.subscribe(sessionId, peerId, (event) => {
      events.push(event);
      resolve();
    }).then((cleanup) => { unsubscribe = cleanup; });
  });
  await Promise.race([result, new Promise<void>((resolve) => setTimeout(resolve, Math.min(25_000, Math.max(100, waitMs))))]);
  unsubscribe?.();
  return events;
}
