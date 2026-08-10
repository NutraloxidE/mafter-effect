import { parseSwarmMessage, serializeSwarmMessage, type SwarmMessageEnvelope } from "../core/protocol";
import { SWARM_MAX_BUFFERED_BYTES } from "./chunkTransport";

export interface DataChannelLike {
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onbufferedamountlow: ((event: Event) => void) | null;
  send(data: string): void;
  close(): void;
}

export class DataChannelProtocol {
  private waiters: Array<() => void> = [];
  onMessage?: (message: SwarmMessageEnvelope) => void;
  onStateChange?: (state: RTCDataChannelState) => void;
  onBytes?: (direction: "rx" | "tx", bytes: number) => void;

  constructor(private readonly channel: DataChannelLike) {
    channel.bufferedAmountLowThreshold = SWARM_MAX_BUFFERED_BYTES / 2;
    channel.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      const message = parseSwarmMessage(raw);
      if (!message) return;
      this.onBytes?.("rx", raw.length);
      this.onMessage?.(message);
    };
    channel.onopen = () => this.onStateChange?.("open");
    channel.onclose = () => this.onStateChange?.("closed");
    channel.onerror = () => this.onStateChange?.("closed");
    channel.onbufferedamountlow = () => this.flushWaiters();
  }

  get state(): RTCDataChannelState {
    return this.channel.readyState;
  }

  async send(message: SwarmMessageEnvelope): Promise<void> {
    const data = serializeSwarmMessage(message);
    if (data.length > SWARM_MAX_BUFFERED_BYTES) throw new Error("Swarm message exceeds the bounded transport buffer");
    if (this.channel.readyState !== "open") throw new Error("Swarm data channel is not open");
    await this.waitForBuffer();
    this.channel.send(data);
    this.onBytes?.("tx", data.length);
  }

  close(): void {
    this.channel.close();
  }

  private waitForBuffer(): Promise<void> {
    if (this.channel.bufferedAmount <= SWARM_MAX_BUFFERED_BYTES) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private flushWaiters(): void {
    if (this.channel.bufferedAmount > SWARM_MAX_BUFFERED_BYTES / 2) return;
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
