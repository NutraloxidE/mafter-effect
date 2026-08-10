import { InMemorySwarmSignalingBackend } from "./inMemory";
import type { SwarmSignalingBackend } from "./SignalingBackend";

// Process-local state only survives while one instance handles every request, which Vercel
// never guarantees: /create, /join and /events can each land on a different instance, so the
// session, the peers and the long-poll listeners all go missing. This backend is therefore
// local-dev/test only — production signaling runs on the Durable Object worker
// (worker/swarmSignaling.ts), pointed at via VITE_SWARM_SIGNALING_URL.
const serverBackend = new InMemorySwarmSignalingBackend();

function isServerlessProduction(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.VERCEL_ENV === "production" || env?.VERCEL_ENV === "preview";
}

export interface SwarmServerRequest {
  action: string;
  body: unknown;
}

export function getVercelServerBackend(): SwarmSignalingBackend {
  if (isServerlessProduction()) {
    throw new Error(
      "Swarm signaling is not available on this deployment: set VITE_SWARM_SIGNALING_URL to the Durable Object worker (see doc/render-swarm.md).",
    );
  }
  return serverBackend;
}

export function parseSwarmServerRequest(body: unknown): SwarmServerRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const value = body as Record<string, unknown>;
  return typeof value.action === "string" && "body" in value
    ? { action: value.action, body: value.body }
    : null;
}
