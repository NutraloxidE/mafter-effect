import { SWARM_PROTOCOL_VERSION, type SwarmJobFailureReason, type SwarmRenderJob, type SwarmRenderResult, type WorkerCapabilities } from "./types";

export type SwarmMessageType =
  | "hello"
  | "capabilities"
  | "challenge"
  | "challenge-response"
  | "benchmark-request"
  | "benchmark-result"
  | "asset-chunk"
  | "job-offer"
  | "job-accepted"
  | "job-progress"
  | "job-result"
  | "job-result-chunk"
  | "job-cancel"
  | "job-failed"
  | "heartbeat"
  | "ping"
  | "pong"
  | "worker-availability"
  | "worker-draining"
  | "worker-goodbye";

export interface SwarmHelloPayload {
  deviceId: string;
  label: string;
  publicKeyJwk: JsonWebKey;
  runtimeVersion: string;
  protocolVersion: number;
}

export interface SwarmBenchmarkResultPayload {
  score: number;
  framesPerSecond: number;
  renderMs: number;
}

export interface SwarmChallengePayload {
  nonce: string;
}

export interface SwarmChallengeResponsePayload {
  nonce: string;
  signatureBase64: string;
}

export interface SwarmJobFailedPayload {
  jobId: string;
  message: string;
  reason?: SwarmJobFailureReason;
}

export interface SwarmJobProgressPayload {
  jobId: string;
  completedFrames: number;
  totalFrames: number;
}

/** One slice of a content-addressed file, sent ahead of the jobs that need it. */
export interface SwarmAssetChunkPayload {
  path: string;
  contentHash: string;
  mimeType?: string;
  index: number;
  count: number;
  bytesBase64: string;
}

/** One slice of a rendered frame; frames exceed the data channel's single-message limit. */
export interface SwarmResultChunkPayload {
  jobId: string;
  index: number;
  count: number;
  bytesBase64: string;
}

export interface SwarmMessagePayloads {
  hello: SwarmHelloPayload;
  capabilities: WorkerCapabilities;
  challenge: SwarmChallengePayload;
  "challenge-response": SwarmChallengeResponsePayload;
  "benchmark-request": { job?: SwarmRenderJob };
  "benchmark-result": SwarmBenchmarkResultPayload;
  "asset-chunk": SwarmAssetChunkPayload;
  "job-offer": { job: SwarmRenderJob };
  "job-accepted": { jobId: string };
  "job-progress": SwarmJobProgressPayload;
  "job-result": SwarmRenderResult;
  "job-result-chunk": SwarmResultChunkPayload;
  "job-cancel": { jobId: string };
  "job-failed": SwarmJobFailedPayload;
  "worker-availability": { available: boolean; reason?: string };
  heartbeat: { at: number };
  ping: { at: number };
  pong: { at: number };
  "worker-draining": { reason?: string };
  "worker-goodbye": { reason?: string };
}

export interface SwarmMessageEnvelope<TType extends SwarmMessageType = SwarmMessageType> {
  protocolVersion: typeof SWARM_PROTOCOL_VERSION;
  messageId: string;
  type: TType;
  payload: SwarmMessagePayloads[TType];
}

let messageCounter = 0;

function newMessageId(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (randomUuid) return randomUuid.call(globalThis.crypto);
  messageCounter += 1;
  return `swarm-${Date.now()}-${messageCounter}`;
}

export function createSwarmMessage<TType extends SwarmMessageType>(
  type: TType,
  payload: SwarmMessagePayloads[TType],
): SwarmMessageEnvelope<TType> {
  return { protocolVersion: SWARM_PROTOCOL_VERSION, messageId: newMessageId(), type, payload };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMessageType(value: unknown): value is SwarmMessageType {
  return typeof value === "string" && [
    "hello", "capabilities", "challenge", "challenge-response", "benchmark-request",
    "benchmark-result", "asset-chunk", "job-offer", "job-accepted", "job-progress", "job-result",
    "job-result-chunk", "job-cancel", "job-failed", "heartbeat", "ping", "pong", "worker-availability", "worker-draining",
    "worker-goodbye",
  ].includes(value);
}

function hasString(payload: Record<string, unknown>, key: string): boolean {
  return typeof payload[key] === "string" && payload[key] !== "";
}

function hasFiniteNumber(payload: Record<string, unknown>, key: string): boolean {
  return typeof payload[key] === "number" && Number.isFinite(payload[key]);
}

function isPayloadShape(type: SwarmMessageType, payload: Record<string, unknown>): boolean {
  switch (type) {
    case "hello":
      return hasString(payload, "deviceId") && hasString(payload, "label") &&
        isRecord(payload.publicKeyJwk) && hasString(payload, "runtimeVersion") &&
        hasFiniteNumber(payload, "protocolVersion");
    case "capabilities":
      return hasString(payload, "browser") && typeof payload.webgl === "boolean" &&
        typeof payload.webgl2 === "boolean" && typeof payload.webCodecs === "boolean" &&
        typeof payload.offscreenCanvas === "boolean" && hasString(payload, "runtimeVersion") &&
        hasFiniteNumber(payload, "protocolVersion");
    case "challenge":
      return hasString(payload, "nonce");
    case "challenge-response":
      return hasString(payload, "nonce") && hasString(payload, "signatureBase64");
    case "benchmark-request":
      return payload.job === undefined || isRecord(payload.job);
    case "benchmark-result":
      return hasFiniteNumber(payload, "score") && hasFiniteNumber(payload, "framesPerSecond") &&
        hasFiniteNumber(payload, "renderMs");
    case "asset-chunk":
      return hasString(payload, "path") && hasString(payload, "contentHash") &&
        hasFiniteNumber(payload, "index") && hasFiniteNumber(payload, "count") &&
        typeof payload.bytesBase64 === "string";
    case "job-offer":
      return isRecord(payload.job) && hasString(payload.job, "id");
    case "worker-availability":
      return typeof payload.available === "boolean";
    case "job-result-chunk":
      return hasString(payload, "jobId") && hasFiniteNumber(payload, "index") &&
        hasFiniteNumber(payload, "count") && typeof payload.bytesBase64 === "string";
    case "job-accepted":
    case "job-cancel":
      return hasString(payload, "jobId");
    case "job-progress":
      return hasString(payload, "jobId") && hasFiniteNumber(payload, "completedFrames") &&
        hasFiniteNumber(payload, "totalFrames");
    case "job-result":
      return hasString(payload, "jobId") && hasString(payload, "renderRevision") &&
        hasString(payload, "compositionId") &&
        // Pixels normally arrive as job-result-chunk messages, leaving this empty on purpose.
        typeof payload.bytesBase64 === "string" &&
        hasFiniteNumber(payload, "frameStart") && hasFiniteNumber(payload, "frameEnd") &&
        hasFiniteNumber(payload, "width") && hasFiniteNumber(payload, "height") &&
        hasFiniteNumber(payload, "byteLength") && hasString(payload, "runtimeVersion");
    case "job-failed":
      return hasString(payload, "jobId") && hasString(payload, "message") &&
        (payload.reason === undefined || [
          "no-ack", "render-stall", "transfer-stall", "worker-failed", "disconnected", "hard-deadline", "invalid-result",
        ].includes(payload.reason as string));
    case "heartbeat":
    case "ping":
    case "pong":
      return hasFiniteNumber(payload, "at");
    case "worker-draining":
    case "worker-goodbye":
      return true;
  }
}

export function parseSwarmMessage(value: unknown): SwarmMessageEnvelope | null {
  const raw = typeof value === "string" ? parseJson(value) : value;
  if (!isRecord(raw)) return null;
  if (raw.protocolVersion !== SWARM_PROTOCOL_VERSION) return null;
  if (typeof raw.messageId !== "string" || raw.messageId.length === 0) return null;
  if (!isMessageType(raw.type) || !isRecord(raw.payload) || !isPayloadShape(raw.type, raw.payload)) return null;
  return raw as unknown as SwarmMessageEnvelope;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function serializeSwarmMessage(message: SwarmMessageEnvelope): string {
  return JSON.stringify(message);
}

export function isSwarmMessageType<TType extends SwarmMessageType>(
  message: SwarmMessageEnvelope,
  type: TType,
): message is SwarmMessageEnvelope<TType> {
  return message.type === type;
}
