import { MemoryFs } from "../fs/MemoryFs";
import type { BundleManifest } from "../runtime/bundleTypes";

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** manifest から player 用 MemoryFs を構築する。 */
export function buildBundleFs(manifest: BundleManifest): MemoryFs {
  const fs = new MemoryFs();
  for (const [path, content] of Object.entries(manifest.textFiles)) {
    void fs.write(path, content);
  }
  for (const [path, b64] of Object.entries(manifest.blobs)) {
    void fs.write(path, base64ToBytes(b64));
  }
  return fs;
}

export function assetUrlForBundle(manifest: BundleManifest, assetPath: string): string {
  const base = manifest.assetBase.replace(/\/?$/, "");
  return `${base}/${assetPath}`;
}
