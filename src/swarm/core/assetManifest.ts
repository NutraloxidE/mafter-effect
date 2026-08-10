import type { FileSystem } from "../../fs/FileSystem";
import type { SwarmAssetTransfer } from "./types";

export interface AssetManifestEntry {
  path: string;
  contentHash: string;
  byteLength: number;
  mimeType?: string;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

export async function buildAssetManifest(
  fs: FileSystem,
  paths: string[],
  mimeTypeFor?: (path: string) => string | undefined,
): Promise<AssetManifestEntry[]> {
  const entries: AssetManifestEntry[] = [];
  for (const path of [...paths].sort()) {
    const bytes = await fs.read(path);
    entries.push({ path, contentHash: await sha256Hex(bytes), byteLength: bytes.byteLength, mimeType: mimeTypeFor?.(path) });
  }
  return entries;
}

export async function toAssetTransfer(fs: FileSystem, path: string, mimeType?: string): Promise<SwarmAssetTransfer> {
  const bytes = await fs.read(path);
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return { path, contentHash: await sha256Hex(bytes), mimeType, bytesBase64: btoa(text) };
}

export function fromAssetTransfer(transfer: SwarmAssetTransfer): Uint8Array {
  const text = atob(transfer.bytesBase64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}
