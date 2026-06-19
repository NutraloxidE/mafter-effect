import { bootBundlePlayer } from "./BundlePlayer";
import type { BundleBootConfig } from "../runtime/bundleTypes";

export { bootBundlePlayer, BundlePlayer } from "./BundlePlayer";
export type { BundleBootConfig } from "../runtime/bundleTypes";

/** IIFE エントリ: index.html から MafterPlayer.boot() を呼ぶ。 */
export function bootFromDom(): void {
  const manifestEl = document.getElementById("mafter-bundle-manifest");
  const stage = document.getElementById("mafter-stage");
  if (!manifestEl?.textContent || !stage) return;
  const manifest = JSON.parse(manifestEl.textContent) as BundleBootConfig["manifest"];
  void bootBundlePlayer({ stage, manifest });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootFromDom);
  } else {
    bootFromDom();
  }
}
