export const SWARM_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const SWARM_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export interface ChunkTransport {
  send(bytes: Uint8Array): Promise<void>;
}

export function splitIntoChunks(bytes: Uint8Array, maxBytes = SWARM_MAX_MESSAGE_BYTES): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += maxBytes) {
    chunks.push(bytes.slice(offset, Math.min(bytes.byteLength, offset + maxBytes)));
  }
  return chunks;
}

export function mergeChunks(chunks: Uint8Array[], expectedBytes: number): Uint8Array | null {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (total !== expectedBytes) return null;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
