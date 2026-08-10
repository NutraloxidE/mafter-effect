import { InMemorySwarmSignalingBackend } from "./inMemory";
import type { SwarmSignalingBackend } from "./SignalingBackend";

// Vercel functions may reuse an instance, so keep only short-lived rendezvous state here.
// A future Cloudflare/DO adapter can replace this server store without touching swarm core.
const serverBackend = new InMemorySwarmSignalingBackend();

export interface SwarmServerRequest {
  action: string;
  body: unknown;
}

export function getVercelServerBackend(): SwarmSignalingBackend {
  return serverBackend;
}

export function parseSwarmServerRequest(body: unknown): SwarmServerRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const value = body as Record<string, unknown>;
  return typeof value.action === "string" && "body" in value
    ? { action: value.action, body: value.body }
    : null;
}
