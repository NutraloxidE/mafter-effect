import type { SwarmSignal } from "../core/types";
import { DataChannelProtocol, type DataChannelLike } from "./dataChannelProtocol";

export interface WebRtcPeerOptions {
  initiator: boolean;
  configuration?: RTCConfiguration;
}

export class WebRtcPeer {
  readonly connection: RTCPeerConnection;
  protocol: DataChannelProtocol | null = null;
  onSignal?: (signal: SwarmSignal) => void;
  onMessage?: (message: Parameters<NonNullable<DataChannelProtocol["onMessage"]>>[0]) => void;
  onStateChange?: (state: RTCPeerConnectionState) => void;
  private started = false;

  constructor(private readonly options: WebRtcPeerOptions) {
    this.connection = new RTCPeerConnection(options.configuration);
    this.connection.onicecandidate = (event) => {
      if (event.candidate) this.onSignal?.({ kind: "candidate", candidate: event.candidate.toJSON() });
    };
    this.connection.onconnectionstatechange = () => this.onStateChange?.(this.connection.connectionState);
    this.connection.ondatachannel = (event) => this.bindChannel(event.channel);
    if (options.initiator) this.bindChannel(this.connection.createDataChannel("mafter-swarm", { ordered: true }));
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.options.initiator) return;
    const offer = await this.connection.createOffer();
    await this.connection.setLocalDescription(offer);
    if (this.connection.localDescription) {
      this.onSignal?.({ kind: "description", description: this.connection.localDescription.toJSON() });
    }
  }

  async applySignal(signal: SwarmSignal): Promise<void> {
    if (signal.kind === "candidate") {
      await this.connection.addIceCandidate(signal.candidate);
      return;
    }
    await this.connection.setRemoteDescription(signal.description);
    if (!this.options.initiator && signal.description.type === "offer") {
      const answer = await this.connection.createAnswer();
      await this.connection.setLocalDescription(answer);
      if (this.connection.localDescription) {
        this.onSignal?.({ kind: "description", description: this.connection.localDescription.toJSON() });
      }
    }
  }

  close(): void {
    this.protocol?.close();
    this.connection.close();
  }

  private bindChannel(channel: RTCDataChannel): void {
    const protocol = new DataChannelProtocol(channel as unknown as DataChannelLike);
    this.protocol = protocol;
    protocol.onMessage = (message) => this.onMessage?.(message);
    protocol.onStateChange = (state) => {
      if (state === "open") this.onStateChange?.("connected");
      if (state === "closed") this.onStateChange?.("disconnected");
    };
  }
}
