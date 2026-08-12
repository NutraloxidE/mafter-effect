import type { Project, TimelineComposition } from "../../core/schema";
import type { FileSystem } from "../../fs/FileSystem";
import { BUILTIN_COMPONENT_TYPES } from "../../runtime/builtinComponents";
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
 * Files without which the worker draws something the host never would: asset bytes referenced by
 * id or path, enabled expression scripts, and any nested HTML comp's script. A job missing one of
 * these stays local. Walking the composition generically keeps this correct for component types
 * whose prop names we do not know here.
 */
export function requiredJobFilePaths(project: Project, comp: TimelineComposition): string[] {
  const assetPathById = new Map(project.assets.map((asset) => [asset.id, asset.path]));
  const paths = new Set<string>();
  for (const node of timelineCompTree(project, comp, paths)) {
    walk(node.objects, (node) => {
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
  }
  return [...paths].sort();
}

/**
 * Everything worth sending: the required files plus the ones named only in the asset table, which
 * no walk of the composition can find — every font (a text layer names its font by CSS family,
 * which `FontOutlineCache` resolves against `meta.family`, so the asset's id and path appear
 * nowhere), a split-alpha mask, and the proxy tier a layer's `footageQuality` selects.
 *
 * These are not required: when one is missing from the host's own FS the host renders without it
 * too — a fallback font, the original instead of a proxy — so a worker that also lacks it still
 * draws the same picture. Requiring them would let a stale `meta.proxies` entry quietly send every
 * job local.
 */
export function collectJobFilePaths(project: Project, comp: TimelineComposition): string[] {
  const paths = new Set(requiredJobFilePaths(project, comp));
  for (const asset of project.assets) {
    if (asset.kind === "font") paths.add(asset.path);
    if (!paths.has(asset.path)) continue;
    for (const companion of companionAssetPaths(asset.meta)) paths.add(companion);
  }
  return [...paths].sort();
}

/**
 * Every timeline composition the render reaches, plus the script of any HTML composition nested in
 * it. A precomp's objects live in `project.compositions`, not in the parent's object list, so
 * walking the parent alone left a worker without any footage, script or font used inside it — and
 * the job still looked self-contained, because the parent's own files had all arrived.
 */
function timelineCompTree(project: Project, root: TimelineComposition, into: Set<string>): TimelineComposition[] {
  const seen = new Set<string>();
  const comps: TimelineComposition[] = [];
  const visit = (comp: TimelineComposition): void => {
    if (seen.has(comp.id)) return;
    seen.add(comp.id);
    comps.push(comp);
    for (const object of comp.objects ?? []) {
      for (const component of object.components ?? []) {
        if (component.type !== "comp") continue;
        const childId = component.props["compId"];
        if (typeof childId !== "string" || childId.length === 0) continue;
        const child = project.compositions.find((candidate) => candidate.id === childId);
        if (!child) continue;
        if (child.kind === "timeline") visit(child);
        // The exporter loads an HTML comp from this one path; if it is missing the job falls back
        // to rendering here rather than shipping a comp the worker cannot draw.
        else into.add(`compositions/${child.id}/script.js`);
      }
    }
  };
  visit(root);
  return comps;
}

function compTreeUsesPluginComponent(project: Project, comp: TimelineComposition): boolean {
  for (const node of timelineCompTree(project, comp, new Set())) {
    for (const object of node.objects ?? []) {
      for (const component of object.components ?? []) {
        if (!BUILTIN_COMPONENT_TYPES.has(component.type)) return true;
      }
    }
  }
  return false;
}

function companionAssetPaths(meta: Record<string, unknown> | undefined): string[] {
  const paths: string[] = [];
  if (typeof meta?.alphaPath === "string" && meta.alphaPath.length > 0) paths.push(meta.alphaPath);
  const proxies = meta?.proxies;
  if (proxies && typeof proxies === "object") {
    for (const raw of Object.values(proxies as Record<string, unknown>)) {
      const path = (raw as { path?: unknown } | null)?.path;
      if (typeof path === "string" && path.length > 0) paths.push(path);
    }
  }
  return paths;
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
      // An unreadable file is only fatal if it was required, and `isSwarmJobSelfContained` decides
      // that from what actually arrived — so skip it rather than abandoning the whole job.
      continue;
    }
    total += transfer.bytesBase64.length;
    if (total > budgetBytes) return null;
    assets.push(transfer);
  }
  return assets;
}

/** True when every file the composition cannot be drawn without travels with the job. */
export function isSwarmJobSelfContained(job: SwarmRenderJob, comp: TimelineComposition): boolean {
  // A plugin component is registered from `plugins/` on the host and nowhere on a worker, so the
  // worker would draw the layer as nothing at all. Keep those renders here until it can load them.
  if (compTreeUsesPluginComponent(job.project, comp)) return false;
  const required = requiredJobFilePaths(job.project, comp);
  if (required.length === 0) return true;
  const attached = new Set((job.assets ?? []).map((asset) => asset.path));
  return required.every((path) => attached.has(path));
}
