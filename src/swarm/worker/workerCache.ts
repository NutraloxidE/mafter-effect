import type { SwarmAssetTransfer } from "../core/types";
import { fromAssetTransfer, sha256Hex } from "../core/assetManifest";

export class BoundedWorkerAssetCache {
  private entries = new Map<string, Uint8Array>();
  private bytes = 0;

  constructor(private readonly maxBytes = 128 * 1024 * 1024) {}

  async put(transfer: SwarmAssetTransfer): Promise<boolean> {
    const bytes = fromAssetTransfer(transfer);
    if (bytes.byteLength > this.maxBytes) return false;
    if (await sha256Hex(bytes) !== transfer.contentHash) return false;
    const previous = this.entries.get(transfer.contentHash);
    if (previous) this.bytes -= previous.byteLength;
    this.entries.delete(transfer.contentHash);
    while (this.bytes + bytes.byteLength > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      const removed = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (removed) this.bytes -= removed.byteLength;
    }
    this.entries.set(transfer.contentHash, bytes);
    this.bytes += bytes.byteLength;
    return true;
  }

  get(contentHash: string): Uint8Array | null {
    const bytes = this.entries.get(contentHash);
    if (!bytes) return null;
    this.entries.delete(contentHash);
    this.entries.set(contentHash, bytes);
    return bytes;
  }

  hashes(): string[] { return [...this.entries.keys()]; }
  sizeBytes(): number { return this.bytes; }
  clear(): void { this.entries.clear(); this.bytes = 0; }
}
