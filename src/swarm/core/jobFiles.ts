import type { Project, TimelineComposition } from "../../core/schema";
import type { FileSystem } from "../../fs/FileSystem";
import { toAssetTransfer } from "./assetManifest";
import type { SwarmAssetTransfer, SwarmRenderJob } from "./types";

/** Total attached bytes a single job may carry inline; larger footage stays local until chunked transfer lands. */
export const SWARM_JOB_FILE_BUDGET_BYTES = 24 * 1024 * 1024;

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
 * the payload exceeds the inline budget — `isSwarmJobSelfContained` then keeps the job local
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

/** True when every file the composition references travels with the job. */
export function isSwarmJobSelfContained(job: SwarmRenderJob, comp: TimelineComposition): boolean {
  const required = collectJobFilePaths(job.project, comp);
  if (required.length === 0) return true;
  const attached = new Set((job.assets ?? []).map((asset) => asset.path));
  return required.every((path) => attached.has(path));
}
