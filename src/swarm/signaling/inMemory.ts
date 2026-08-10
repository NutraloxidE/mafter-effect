import type {
  CreateSwarmSessionInput,
  JoinSwarmSessionInput,
  JoinSwarmSessionResult,
  SwarmPeerId,
  SwarmSessionDescriptor,
  SwarmSignal,
  SwarmSignalingEvent,
  SwarmPeerDescriptor,
} from "../core/types";
import type { SwarmSignalingBackend } from "./SignalingBackend";

interface SessionState {
  descriptor: SwarmSessionDescriptor;
  hostPeerId: SwarmPeerId;
  peers: Map<SwarmPeerId, SwarmPeerDescriptor>;
  listeners: Map<SwarmPeerId, Set<(event: SwarmSignalingEvent) => void>>;
}

function randomToken(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[value % 32]).join("");
}

export class InMemorySwarmSignalingBackend implements SwarmSignalingBackend {
  private sessions = new Map<string, SessionState>();

  async createSession(input: CreateSwarmSessionInput): Promise<SwarmSessionDescriptor> {
    const now = Date.now();
    const descriptor: SwarmSessionDescriptor = {
      sessionId: `session-${randomToken(12)}`,
      joinCode: randomToken(6),
      expiresAt: now + Math.max(60_000, input.expiresInMs ?? 30 * 60_000),
    };
    this.sessions.set(descriptor.sessionId, {
      descriptor,
      hostPeerId: input.hostPeerId,
      peers: new Map(),
      listeners: new Map([[input.hostPeerId, new Set()]]),
    });
    return descriptor;
  }

  async joinSession(input: JoinSwarmSessionInput): Promise<JoinSwarmSessionResult> {
    const session = this.findByCode(input.joinCode);
    this.ensureLive(session);
    session.peers.set(input.peer.peerId, input.peer);
    this.emit(session, session.hostPeerId, { type: "peer-join-request", peer: input.peer });
    return { session: session.descriptor, peer: input.peer };
  }

  async approveJoin(sessionId: string, hostPeerId: string, peerId: string, approved: boolean): Promise<void> {
    const session = this.getSession(sessionId);
    if (session.hostPeerId !== hostPeerId) throw new Error("Only the host may approve a worker");
    const peer = session.peers.get(peerId);
    if (!peer) throw new Error("Unknown worker");
    if (approved) this.emit(session, peerId, { type: "peer-approved", peer, hostPeerId });
    else {
      this.emit(session, peerId, { type: "peer-rejected", peerId, reason: "Host rejected the worker" });
      session.peers.delete(peerId);
    }
  }

  async sendSignal(sessionId: string, fromPeerId: string, toPeerId: string, signal: SwarmSignal): Promise<void> {
    const session = this.getSession(sessionId);
    this.ensureLive(session);
    if (!session.peers.has(fromPeerId) && session.hostPeerId !== fromPeerId) throw new Error("Unknown sender");
    if (!session.peers.has(toPeerId) && session.hostPeerId !== toPeerId) throw new Error("Unknown recipient");
    this.emit(session, toPeerId, { type: "signal", fromPeerId, payload: signal });
  }

  async subscribe(sessionId: string, peerId: string, onEvent: (event: SwarmSignalingEvent) => void): Promise<() => void> {
    const session = this.getSession(sessionId);
    this.ensureLive(session);
    const listeners = session.listeners.get(peerId) ?? new Set();
    listeners.add(onEvent);
    session.listeners.set(peerId, listeners);
    return () => listeners.delete(onEvent);
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const peerId of session.peers.keys()) this.emit(session, peerId, { type: "peer-left", peerId: session.hostPeerId });
    this.sessions.delete(sessionId);
  }

  private findByCode(joinCode: string): SessionState {
    for (const session of this.sessions.values()) {
      if (session.descriptor.joinCode === joinCode) return session;
    }
    throw new Error("Unknown swarm join code");
  }

  private getSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Unknown swarm session");
    return session;
  }

  private ensureLive(session: SessionState): void {
    if (session.descriptor.expiresAt > Date.now()) return;
    this.emit(session, session.hostPeerId, { type: "session-expired" });
    this.sessions.delete(session.descriptor.sessionId);
    throw new Error("Swarm session expired");
  }

  private emit(session: SessionState, peerId: string, event: SwarmSignalingEvent): void {
    for (const listener of session.listeners.get(peerId) ?? []) listener(event);
  }
}

export function createInMemorySwarmBackend(): InMemorySwarmSignalingBackend {
  return new InMemorySwarmSignalingBackend();
}
