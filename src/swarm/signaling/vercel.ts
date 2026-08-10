import type {
  CreateSwarmSessionInput,
  JoinSwarmSessionInput,
  JoinSwarmSessionResult,
  SwarmSessionDescriptor,
  SwarmSignal,
  SwarmSignalingEvent,
} from "../core/types";
import type { SwarmSignalingBackend } from "./SignalingBackend";

interface VercelResponse<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

export interface VercelSignalingOptions {
  endpoint: string;
  fetchImpl?: typeof fetch;
}

export class VercelSignalingBackend implements SwarmSignalingBackend {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private activeSubscriptions = new Set<{ closed: boolean }>();

  constructor(options: VercelSignalingOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  createSession(input: CreateSwarmSessionInput): Promise<SwarmSessionDescriptor> {
    return this.request("create", input);
  }

  joinSession(input: JoinSwarmSessionInput): Promise<JoinSwarmSessionResult> {
    return this.request("join", input);
  }

  async approveJoin(sessionId: string, hostPeerId: string, peerId: string, approved: boolean): Promise<void> {
    await this.request("approve", { sessionId, hostPeerId, peerId, approved });
  }

  async sendSignal(sessionId: string, fromPeerId: string, toPeerId: string, signal: SwarmSignal): Promise<void> {
    await this.request("signal", { sessionId, fromPeerId, toPeerId, signal });
  }

  async subscribe(sessionId: string, peerId: string, onEvent: (event: SwarmSignalingEvent) => void): Promise<() => void> {
    const state = { closed: false };
    this.activeSubscriptions.add(state);
    void this.eventLoop(sessionId, peerId, onEvent, state);
    return () => {
      state.closed = true;
      this.activeSubscriptions.delete(state);
    };
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request("close", { sessionId });
  }

  private async eventLoop(
    sessionId: string,
    peerId: string,
    onEvent: (event: SwarmSignalingEvent) => void,
    state: { closed: boolean },
  ): Promise<void> {
    let backoffMs = 250;
    while (!state.closed) {
      try {
        const response = await this.request<{ events: SwarmSignalingEvent[] }>("events", {
          sessionId,
          peerId,
          waitMs: 20_000,
        });
        for (const event of response.events) onEvent(event);
        backoffMs = 250;
      } catch {
        if (state.closed) return;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(8_000, backoffMs * 2);
      }
    }
  }

  private async request<T>(action: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.endpoint}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as VercelResponse<T>;
    if (!response.ok || !payload.ok || payload.value === undefined) {
      throw new Error(payload.error ?? `Swarm signaling request failed: ${action}`);
    }
    return payload.value;
  }
}

export function defaultSignalingEndpoint(): string {
  const configured = import.meta.env.VITE_SWARM_SIGNALING_URL as string | undefined;
  return configured ?? "/api/swarm";
}
