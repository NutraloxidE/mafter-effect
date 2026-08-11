import type {
  CreateSwarmSessionInput,
  JoinSwarmSessionInput,
  JoinSwarmSessionResult,
  SwarmPeerDescriptor,
  SwarmSessionDescriptor,
  SwarmSignal,
  SwarmSignalingEvent,
} from "../core/types";

/** Minimal subset of Durable Object storage, so the rendezvous logic stays testable off-workerd. */
export interface DurableKv {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

interface SessionRecord {
  descriptor: SwarmSessionDescriptor;
  hostPeerId: string;
  /** Only this device may reattach to the session; possession of the code alone is not enough. */
  hostDeviceId?: string;
  peers: Record<string, SwarmPeerDescriptor>;
}

const SESSION_KEY = "session";

/**
 * How long a join code stays usable. Expiry only closes the door to *new* joins — established
 * peers talk directly and do not touch the server again — so a short window buys no safety and
 * just forces a working swarm to be rebuilt by hand.
 */
export const SWARM_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const queueKey = (peerId: string): string => `q:${peerId}`;

/** Session ids embed the join code so every action routes to the same Durable Object. */
export function joinCodeFromSessionId(sessionId: string): string {
  return sessionId.split("-")[1] ?? "";
}

export function makeSessionId(joinCode: string, random: string): string {
  return `session-${joinCode}-${random}`;
}

/**
 * Rendezvous state for exactly one swarm session: session, pending joins, offer/answer/ICE
 * and a short-lived per-peer event queue. Nothing else belongs here — heartbeat, progress,
 * job dispatch and results ride the P2P data channel once WebRTC is up.
 */
export class DurableSwarmSession {
  constructor(private readonly kv: DurableKv) {}

  async createSession(input: CreateSwarmSessionInput, joinCode: string, random: string): Promise<SwarmSessionDescriptor> {
    const expiresAt = Date.now() + Math.max(60_000, input.expiresInMs ?? SWARM_SESSION_TTL_MS);
    const existing = await this.kv.get<SessionRecord>(SESSION_KEY);
    // Reattaching keeps the session id, so approved workers stay approved and reconnect on their
    // own; a different device asking for the same code gets a fresh session instead.
    if (existing && existing.descriptor.joinCode === joinCode && existing.hostDeviceId === input.hostDeviceId) {
      const descriptor = { ...existing.descriptor, expiresAt };
      // Deliberately no replay of known peers to the new host: a peer id here may be from a join
      // the worker has already abandoned, and announcing it makes the host open a connection to a
      // peer that will never answer. A stranded worker rejoins on its own (see WorkerRuntime's
      // approval timeout), which produces a live peer id instead of resurrecting a dead one.
      await this.kv.put(SESSION_KEY, { ...existing, descriptor, hostPeerId: input.hostPeerId });
      if (existing.hostPeerId !== input.hostPeerId) await this.kv.delete(queueKey(existing.hostPeerId));
      return descriptor;
    }
    const descriptor: SwarmSessionDescriptor = {
      sessionId: makeSessionId(joinCode, random),
      joinCode,
      expiresAt,
    };
    await this.kv.put(SESSION_KEY, {
      descriptor,
      hostPeerId: input.hostPeerId,
      hostDeviceId: input.hostDeviceId,
      peers: {},
    } satisfies SessionRecord);
    return descriptor;
  }

  async joinSession(input: JoinSwarmSessionInput): Promise<JoinSwarmSessionResult> {
    const session = await this.live();
    if (session.descriptor.joinCode !== input.joinCode) throw new Error("Unknown swarm join code");
    session.peers[input.peer.peerId] = input.peer;
    await this.kv.put(SESSION_KEY, session);
    await this.emit(session.hostPeerId, { type: "peer-join-request", peer: input.peer });
    return { session: session.descriptor, peer: input.peer };
  }

  async approveJoin(sessionId: string, hostPeerId: string, peerId: string, approved: boolean): Promise<void> {
    const session = await this.live(sessionId);
    if (session.hostPeerId !== hostPeerId) throw new Error("Only the host may approve a worker");
    const peer = session.peers[peerId];
    if (!peer) throw new Error("Unknown worker");
    if (approved) {
      await this.emit(peerId, { type: "peer-approved", peer, hostPeerId });
      return;
    }
    delete session.peers[peerId];
    await this.kv.put(SESSION_KEY, session);
    await this.emit(peerId, { type: "peer-rejected", peerId, reason: "Host rejected the worker" });
  }

  async sendSignal(sessionId: string, fromPeerId: string, toPeerId: string, signal: SwarmSignal): Promise<void> {
    const session = await this.live(sessionId);
    if (!this.known(session, fromPeerId)) throw new Error("Unknown sender");
    if (!this.known(session, toPeerId)) throw new Error("Unknown recipient");
    await this.emit(toPeerId, { type: "signal", fromPeerId, payload: signal });
  }

  /** Drains the peer's pending events; the transport layer decides how long to long-poll. */
  async takeEvents(sessionId: string, peerId: string): Promise<SwarmSignalingEvent[]> {
    const session = await this.kv.get<SessionRecord>(SESSION_KEY);
    if (!session || session.descriptor.sessionId !== sessionId) throw new Error("Unknown swarm session");
    if (!this.known(session, peerId)) throw new Error("Unknown swarm peer");
    // Expiry is reported to the poller rather than thrown, otherwise the client only ever
    // sees "Unknown swarm session" and cannot distinguish a timeout from a bad code.
    if (session.descriptor.expiresAt <= Date.now()) {
      await this.kv.delete(SESSION_KEY);
      return [{ type: "session-expired" }];
    }
    const events = (await this.kv.get<SwarmSignalingEvent[]>(queueKey(peerId))) ?? [];
    if (events.length > 0) await this.kv.delete(queueKey(peerId));
    return events;
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = await this.kv.get<SessionRecord>(SESSION_KEY);
    if (!session || session.descriptor.sessionId !== sessionId) return;
    for (const peerId of Object.keys(session.peers)) {
      await this.emit(peerId, { type: "peer-left", peerId: session.hostPeerId });
    }
    await this.kv.delete(SESSION_KEY);
  }

  private known(session: SessionRecord, peerId: string): boolean {
    return session.hostPeerId === peerId || peerId in session.peers;
  }

  private async live(sessionId?: string): Promise<SessionRecord> {
    const session = await this.kv.get<SessionRecord>(SESSION_KEY);
    if (!session) throw new Error("Unknown swarm session");
    if (sessionId !== undefined && session.descriptor.sessionId !== sessionId) throw new Error("Unknown swarm session");
    if (session.descriptor.expiresAt <= Date.now()) {
      await this.emit(session.hostPeerId, { type: "session-expired" });
      await this.kv.delete(SESSION_KEY);
      throw new Error("Swarm session expired");
    }
    return session;
  }

  private async emit(peerId: string, event: SwarmSignalingEvent): Promise<void> {
    const queue = (await this.kv.get<SwarmSignalingEvent[]>(queueKey(peerId))) ?? [];
    queue.push(event);
    await this.kv.put(queueKey(peerId), queue);
  }
}
