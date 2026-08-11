import type { SwarmSignal } from "../core/types";
import { DataChannelProtocol, type DataChannelLike } from "./dataChannelProtocol";

export interface WebRtcPeerOptions {
  initiator: boolean;
  configuration?: RTCConfiguration;
}

export type SwarmTransportKind = "unknown" | "direct" | "relay";

export class WebRtcPeer {
  readonly connection: RTCPeerConnection;
  protocol: DataChannelProtocol | null = null;
  transportKind: SwarmTransportKind = "unknown";
  onSignal?: (signal: SwarmSignal) => void;
  onMessage?: (message: Parameters<NonNullable<DataChannelProtocol["onMessage"]>>[0]) => void;
  onStateChange?: (state: RTCPeerConnectionState) => void;
  onTransportKind?: (kind: SwarmTransportKind) => void;
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

  /** Reads the negotiated candidate pair; a relay on either end means the traffic goes through TURN. */
  async detectTransportKind(): Promise<SwarmTransportKind> {
    const stats = await this.connection.getStats();
    const byId = new Map<string, { type?: string; candidateType?: string; state?: string; nominated?: boolean; selected?: boolean; localCandidateId?: string; remoteCandidateId?: string }>();
    stats.forEach((report) => byId.set(report.id, report as never));
    const pair = [...byId.values()].find((report) =>
      report.type === "candidate-pair" && (report.selected === true || (report.state === "succeeded" && report.nominated !== false)),
    );
    const endpoints = [pair?.localCandidateId, pair?.remoteCandidateId]
      .map((id) => (id ? byId.get(id)?.candidateType : undefined));
    const kind: SwarmTransportKind = !pair || endpoints.some((type) => type === undefined)
      ? "unknown"
      : endpoints.includes("relay") ? "relay" : "direct";
    if (kind !== this.transportKind) {
      this.transportKind = kind;
      this.onTransportKind?.(kind);
    }
    return kind;
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
      if (state === "open") {
        this.onStateChange?.("connected");
        void this.detectTransportKind();
      }
      if (state === "closed") this.onStateChange?.("disconnected");
    };
  }
}
