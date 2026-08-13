import type { SwarmAssetChunkPayload, SwarmResultChunkPayload } from "../core/protocol";
import type { SwarmAssetTransfer } from "../core/types";

/**
 * Base64 characters per chunk. A WebRTC data channel negotiates a maximum message size that is
 * commonly 256KB and can be far lower; oversized sends fail and can tear down the channel, so
 * this stays small enough that the JSON envelope around it is still comfortably within it.
 */
export const SWARM_ASSET_CHUNK_CHARS = 32 * 1024;

export function splitAssetIntoChunks(
  transfer: SwarmAssetTransfer,
  chunkChars = SWARM_ASSET_CHUNK_CHARS,
): SwarmAssetChunkPayload[] {
  const size = Math.max(1, chunkChars);
  const count = Math.max(1, Math.ceil(transfer.bytesBase64.length / size));
  const chunks: SwarmAssetChunkPayload[] = [];
  for (let index = 0; index < count; index += 1) {
    chunks.push({
      path: transfer.path,
      contentHash: transfer.contentHash,
      mimeType: transfer.mimeType,
      index,
      count,
      bytesBase64: transfer.bytesBase64.slice(index * size, (index + 1) * size),
    });
  }
  return chunks;
}

export function splitResultBytes(jobId: string, bytesBase64: string, chunkChars = SWARM_ASSET_CHUNK_CHARS): SwarmResultChunkPayload[] {
  const size = Math.max(1, chunkChars);
  const count = Math.max(1, Math.ceil(bytesBase64.length / size));
  return Array.from({ length: count }, (_, index) => ({
    jobId,
    index,
    count,
    bytesBase64: bytesBase64.slice(index * size, (index + 1) * size),
  }));
}

/** Reassembles frame chunks per job; the caller drops them if the result never arrives. */
export class ResultChunkAssembler {
  private pending = new Map<string, { parts: string[]; received: number }>();

  accept(chunk: SwarmResultChunkPayload): void {
    if (chunk.count <= 0 || chunk.index < 0 || chunk.index >= chunk.count) return;
    const entry = this.pending.get(chunk.jobId) ?? { parts: new Array<string>(chunk.count).fill(""), received: 0 };
    if (entry.parts.length !== chunk.count) return;
    if (entry.parts[chunk.index] === "") entry.received += 1;
    entry.parts[chunk.index] = chunk.bytesBase64;
    this.pending.set(chunk.jobId, entry);
  }

  take(jobId: string): string | null {
    const entry = this.pending.get(jobId);
    if (!entry || entry.received < entry.parts.length) return null;
    this.pending.delete(jobId);
    return entry.parts.join("");
  }

  drop(jobId: string): void {
    this.pending.delete(jobId);
  }

  /** Drops only incomplete results; a complete late result may still be useful for measurement. */
  dropPartial(jobId: string): void {
    const entry = this.pending.get(jobId);
    if (entry && entry.received < entry.parts.length) this.pending.delete(jobId);
  }

  clear(): void {
    this.pending.clear();
  }
}

/**
 * Reassembles chunks per content hash. Returns the completed transfer on the final chunk; the
 * receiver still verifies the hash, so a mis-ordered or truncated stream fails there rather than
 * silently rendering with the wrong bytes.
 */
export class AssetChunkAssembler {
  private pending = new Map<string, { parts: string[]; received: number; payload: SwarmAssetChunkPayload }>();

  accept(chunk: SwarmAssetChunkPayload): SwarmAssetTransfer | null {
    if (chunk.count <= 0 || chunk.index < 0 || chunk.index >= chunk.count) return null;
    const entry = this.pending.get(chunk.contentHash)
      ?? { parts: new Array<string>(chunk.count).fill(""), received: 0, payload: chunk };
    if (entry.parts.length !== chunk.count) return null;
    if (entry.parts[chunk.index] === "") entry.received += 1;
    entry.parts[chunk.index] = chunk.bytesBase64;
    this.pending.set(chunk.contentHash, entry);
    if (entry.received < chunk.count) return null;
    this.pending.delete(chunk.contentHash);
    return {
      path: entry.payload.path,
      contentHash: chunk.contentHash,
      mimeType: entry.payload.mimeType,
      bytesBase64: entry.parts.join(""),
    };
  }

  /** Drops partial transfers, e.g. after a peer disconnects mid-file. */
  reset(): void {
    this.pending.clear();
  }
}
