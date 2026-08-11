/**
 * Keeps a worker on the deployed build. A worker left running an older bundle renders with
 * whatever bugs that build had, and the frames it returns look like host-side problems — which is
 * exactly how a stale worker cost us a debugging session.
 *
 * The entry bundle is content-hashed, so its filename is a sufficient build identity and works on
 * any static host without extra deployment metadata.
 */
const ENTRY_SCRIPT = /\/assets\/index-[A-Za-z0-9_-]+\.js/;

export function extractBuildTag(html: string): string | null {
  return ENTRY_SCRIPT.exec(html)?.[0] ?? null;
}

export function currentBuildTag(doc: Document = document): string | null {
  for (const script of [...doc.querySelectorAll("script[src]")]) {
    const tag = extractBuildTag(script.getAttribute("src") ?? "");
    if (tag) return tag;
  }
  return null;
}

export interface UpdateCheckOptions {
  fetchImpl?: typeof fetch;
  origin?: string;
  doc?: Document;
}

/** True when the deployment now serves a different entry bundle than the one running here. */
export async function isWorkerOutdated(options: UpdateCheckOptions = {}): Promise<boolean> {
  const running = currentBuildTag(options.doc ?? document);
  if (!running) return false;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  try {
    const response = await fetchImpl(`${options.origin ?? ""}/?swarm-update-check=1`, { cache: "no-store" });
    if (!response.ok) return false;
    const deployed = extractBuildTag(await response.text());
    return deployed !== null && deployed !== running;
  } catch {
    // A failed check must never take a working worker offline.
    return false;
  }
}
