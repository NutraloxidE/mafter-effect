import type { Project, TimelineComposition } from "../../core/schema";
import type { FileSystem } from "../../fs/FileSystem";
import { toAssetTransfer } from "./assetManifest";
import type { SwarmAssetTransfer, SwarmRenderJob } from "./types";

/**
 * Total base64 length a job may reference. Files travel as chunks, so this is a memory bound
 * (host string + worker cache), not a message-size one; it matches the worker asset cache ceiling.
 */
export const SWARM_JOB_FILE_BUDGET_BYTES = 128 * 1024 * 1024;

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const node = value as Record<string, unknown>;
  visit(node);
  for (const child of Object.values(node)) walk(child, visit);
}

/**
 * Project files a worker must have on disk to render this composition: asset bytes referenced by
 * id or path, and enabled expression scripts. Walking the composition generically keeps this
 * correct for component types whose prop names we do not know here.
 */
export function collectJobFilePaths(project: Project, comp: TimelineComposition): string[] {
  const assetPathById = new Map(project.assets.map((asset) => [asset.id, asset.path]));
  const paths = new Set<string>();
  walk(comp.objects, (node) => {
    const expression = node.expression;
    if (typeof expression === "object" && expression !== null) {
      const ref = expression as { path?: unknown; enabled?: unknown };
      if (ref.enabled !== false && typeof ref.path === "string") paths.add(ref.path);
    }
    for (const value of Object.values(node)) {
      if (typeof value !== "string") continue;
      if (value.startsWith("assets/") || value.startsWith("scripts/")) paths.add(value);
      const byId = assetPathById.get(value);
      if (byId) paths.add(byId);
    }
  });
  return [...paths].sort();
}

/**
 * Attaches the referenced files to the job. Returns the job unchanged when anything is missing or
 * the payload exceeds the budget — `isSwarmJobSelfContained` then keeps the job local
 * rather than shipping a render that would silently lose footage.
 */
export async function attachJobFiles(
  job: SwarmRenderJob,
  comp: TimelineComposition,
  fs: FileSystem,
  budgetBytes = SWARM_JOB_FILE_BUDGET_BYTES,
): Promise<SwarmRenderJob> {
  const paths = collectJobFilePaths(job.project, comp);
  if (paths.length === 0) return { ...job, assets: [] };
  const assets: SwarmAssetTransfer[] = [];
  let total = 0;
  for (const path of paths) {
    let transfer: SwarmAssetTransfer;
    try {
      transfer = await toAssetTransfer(fs, path);
    } catch {
      return job;
    }
    total += transfer.bytesBase64.length;
    if (total > budgetBytes) return job;
    assets.push(transfer);
  }
  return { ...job, assets };
}

const transferCache = new Map<string, { key: string; transfers: Promise<SwarmAssetTransfer[] | null> }>();

/**
 * Same as `attachJobFiles`, but reads and hashes each file once per (composition, revision)
 * instead of once per frame. An export submits one job per frame, and re-encoding tens of
 * megabytes of footage for every one of them costs far more than the render it is accelerating.
 */
export async function attachJobFilesCached(
  job: SwarmRenderJob,
  comp: TimelineComposition,
  fs: FileSystem,
  revision: string,
  budgetBytes = SWARM_JOB_FILE_BUDGET_BYTES,
): Promise<SwarmRenderJob> {
  const paths = collectJobFilePaths(job.project, comp);
  if (paths.length === 0) return { ...job, assets: [] };
  const key = `${revision}::${paths.join("|")}`;
  const cached = transferCache.get(comp.id);
  if (!cached || cached.key !== key) {
    transferCache.set(comp.id, {
      key,
      transfers: readTransfers(paths, fs, budgetBytes),
    });
  }
  const transfers = await transferCache.get(comp.id)!.transfers;
  return transfers ? { ...job, assets: transfers } : job;
}

async function readTransfers(
  paths: string[],
  fs: FileSystem,
  budgetBytes: number,
): Promise<SwarmAssetTransfer[] | null> {
  const assets: SwarmAssetTransfer[] = [];
  let total = 0;
  for (const path of paths) {
    let transfer: SwarmAssetTransfer;
    try {
      transfer = await toAssetTransfer(fs, path);
    } catch {
      return null;
    }
    total += transfer.bytesBase64.length;
    if (total > budgetBytes) return null;
    assets.push(transfer);
  }
  return assets;
}

/** True when every file the composition references travels with the job. */
export function isSwarmJobSelfContained(job: SwarmRenderJob, comp: TimelineComposition): boolean {
  const required = collectJobFilePaths(job.project, comp);
  if (required.length === 0) return true;
  const attached = new Set((job.assets ?? []).map((asset) => asset.path));
  return required.every((path) => attached.has(path));
}
