import type {
  CreateSwarmSessionInput,
  JoinSwarmSessionInput,
  JoinSwarmSessionResult,
  SwarmPeerId,
  SwarmSessionDescriptor,
  SwarmSignal,
  SwarmSignalingEvent,
} from "../core/types";

export interface SwarmSignalingBackend {
  createSession(input: CreateSwarmSessionInput): Promise<SwarmSessionDescriptor>;
  joinSession(input: JoinSwarmSessionInput): Promise<JoinSwarmSessionResult>;
  approveJoin(sessionId: string, hostPeerId: SwarmPeerId, peerId: SwarmPeerId, approved: boolean): Promise<void>;
  sendSignal(sessionId: string, fromPeerId: SwarmPeerId, toPeerId: SwarmPeerId, signal: SwarmSignal): Promise<void>;
  subscribe(sessionId: string, peerId: SwarmPeerId, onEvent: (event: SwarmSignalingEvent) => void): Promise<() => void>;
  closeSession(sessionId: string): Promise<void>;
}
