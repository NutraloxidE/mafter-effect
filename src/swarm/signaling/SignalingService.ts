import { InMemorySwarmSignalingBackend } from "./inMemory";
import { defaultSignalingEndpoint, VercelSignalingBackend } from "./vercel";
import type { SwarmSignalingBackend } from "./SignalingBackend";

let sharedInMemoryBackend: InMemorySwarmSignalingBackend | null = null;

export interface SignalingServiceOptions {
  backend?: SwarmSignalingBackend;
  endpoint?: string;
  useInMemory?: boolean;
}

export function createSignalingBackend(options: SignalingServiceOptions = {}): SwarmSignalingBackend {
  if (options.backend) return options.backend;
  if (options.useInMemory) {
    sharedInMemoryBackend ??= new InMemorySwarmSignalingBackend();
    return sharedInMemoryBackend;
  }
  return new VercelSignalingBackend({ endpoint: options.endpoint ?? defaultSignalingEndpoint() });
}
