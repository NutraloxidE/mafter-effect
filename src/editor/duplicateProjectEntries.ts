import { newAssetId, newBinId, newCompId, newObjectId, newVertexId } from "../core/ids";
import { appendTreeEntry, entryExists, orderedEntriesForParent } from "../core/projectTree";
import type {
  AssetEntry,
  Component,
  Composition,
  Project,
  ProjectBin,
  ProjectTreeEntry,
  SceneObject,
  ShapeVertex,
  TimelineComposition,
} from "../core/schema";

export interface ProjectEntryIdFactory {
  asset: () => string;
  bin: () => string;
  comp: () => string;
  object: () => string;
  vertex: () => string;
}

export interface DuplicateProjectEntriesResult {
  project: Project;
  pastedEntries: ProjectTreeEntry[];
  htmlCompCopies: Array<{ from: string; to: string }>;
  objectScriptCopies: Array<{ from: string; to: string }>;
}

const defaultIds: ProjectEntryIdFactory = {
  asset: newAssetId,
  bin: newBinId,
  comp: newCompId,
  object: newObjectId,
  vertex: newVertexId,
};

function key(entry: ProjectTreeEntry): string {
  return `${entry.kind}:${entry.id}`;
}

function parentBinOf(project: Project, entry: ProjectTreeEntry): string | null {
  if (entry.kind === "bin") {
    return (project.bins ?? []).find((bin) => bin.id === entry.id)?.parentId ?? null;
  }
  if (entry.kind === "composition") {
    return project.compositions.find((comp) => comp.id === entry.id)?.binId ?? null;
  }
  return project.assets.find((asset) => asset.id === entry.id)?.binId ?? null;
}

function hasSelectedBinAncestor(
  project: Project,
  entry: ProjectTreeEntry,
  selectedBinIds: ReadonlySet<string>,
): boolean {
  const bins = new Map((project.bins ?? []).map((bin) => [bin.id, bin]));
  let parentId = parentBinOf(project, entry);
  while (parentId) {
    if (selectedBinIds.has(parentId)) return true;
    parentId = bins.get(parentId)?.parentId ?? null;
  }
  return false;
}

/** Remove missing/duplicate roots and descendants already covered by a selected bin. */
export function normalizeProjectCopyRoots(
  project: Project,
  entries: ProjectTreeEntry[],
): ProjectTreeEntry[] {
  const unique: ProjectTreeEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const k = key(entry);
    if (seen.has(k) || !entryExists(project, entry)) continue;
    seen.add(k);
    unique.push(entry);
  }
  const selectedBinIds = new Set(unique.filter((entry) => entry.kind === "bin").map((entry) => entry.id));
  return unique.filter((entry) => !hasSelectedBinAncestor(project, entry, selectedBinIds));
}

interface CollectedEntry {
  entry: ProjectTreeEntry;
}

function collectEntries(project: Project, roots: ProjectTreeEntry[]): CollectedEntry[] {
  const out: CollectedEntry[] = [];
  const seen = new Set<string>();
  const visit = (entry: ProjectTreeEntry) => {
    const k = key(entry);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ entry });
    if (entry.kind === "bin") {
      for (const child of orderedEntriesForParent(project, entry.id)) visit(child);
    }
  };
  for (const root of roots) visit(root);
  return out;
}

function remapExpressionPaths(value: unknown, objectIds: ReadonlyMap<string, string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) remapExpressionPaths(item, objectIds);
    return;
  }
  const record = value as Record<string, unknown>;
  const expression = record["expression"];
  if (expression && typeof expression === "object") {
    const expr = expression as Record<string, unknown>;
    if (typeof expr["path"] === "string") {
      for (const [from, to] of objectIds) {
        const prefix = `scripts/${from}/`;
        if (expr["path"].startsWith(prefix)) {
          expr["path"] = `scripts/${to}/${expr["path"].slice(prefix.length)}`;
          break;
        }
      }
    }
  }
  for (const child of Object.values(record)) remapExpressionPaths(child, objectIds);
}

function remapShapeVertices(vertices: unknown, ids: ProjectEntryIdFactory): void {
  if (!Array.isArray(vertices)) return;
  for (const raw of vertices) {
    if (!raw || typeof raw !== "object") continue;
    const vertex = raw as ShapeVertex;
    if (typeof vertex.id === "string") vertex.id = ids.vertex();
  }
}

function cloneComponent(
  source: Component,
  compIds: ReadonlyMap<string, string>,
  assetIds: ReadonlyMap<string, string>,
  objectIds: ReadonlyMap<string, string>,
  ids: ProjectEntryIdFactory,
): Component {
  const component = structuredClone(source) as Component;
  const props = component.props;
  if ((component.type === "comp" || component.type === "html") && typeof props["compId"] === "string") {
    props["compId"] = compIds.get(props["compId"]) ?? props["compId"];
  }
  if (
    (component.type === "audio" || component.type === "image" || component.type === "video") &&
    typeof props["asset"] === "string"
  ) {
    props["asset"] = assetIds.get(props["asset"]) ?? props["asset"];
  }
  if (component.type === "shape") {
    remapShapeVertices(props["vertices"], ids);
    const rings = props["rings"];
    if (Array.isArray(rings)) for (const ring of rings) remapShapeVertices(ring, ids);
    const mergeInputs = props["mergeInputs"];
    if (Array.isArray(mergeInputs)) {
      for (const raw of mergeInputs) {
        if (!raw || typeof raw !== "object") continue;
        const input = raw as Record<string, unknown>;
        if (typeof input["id"] === "string") input["id"] = ids.object();
        if (typeof input["objectId"] === "string") {
          input["objectId"] = objectIds.get(input["objectId"]) ?? input["objectId"];
        }
      }
    }
  }
  remapExpressionPaths(component.props, objectIds);
  return component;
}

function cloneTimelineComposition(
  source: TimelineComposition,
  newId: string,
  binId: string | undefined,
  name: string,
  compIds: ReadonlyMap<string, string>,
  assetIds: ReadonlyMap<string, string>,
  ids: ProjectEntryIdFactory,
  objectScriptCopies: Array<{ from: string; to: string }>,
): TimelineComposition {
  const objectIds = new Map(source.objects.map((object) => [object.id, ids.object()]));
  const objects: SceneObject[] = source.objects.map((sourceObject) => {
    const object = structuredClone(sourceObject) as SceneObject;
    object.id = objectIds.get(sourceObject.id)!;
    object.parent = sourceObject.parent ? objectIds.get(sourceObject.parent) ?? sourceObject.parent : null;
    object.components = sourceObject.components.map((component) =>
      cloneComponent(component, compIds, assetIds, objectIds, ids),
    );
    if (object.effects) {
      object.effects = object.effects.map((effect) => ({ ...effect, id: ids.object() }));
    }
    if (object.expressionPresets) {
      object.expressionPresets = object.expressionPresets.map((preset) => ({ ...preset, id: ids.object() }));
    }
    remapExpressionPaths(object, objectIds);
    objectScriptCopies.push({ from: sourceObject.id, to: object.id });
    return object;
  });
  return { ...structuredClone(source), id: newId, name, binId, objects };
}

function withBinId<T extends { binId?: string }>(value: T, binId: string | null): T {
  if (binId) return { ...value, binId };
  const { binId: _removed, ...rest } = value;
  return rest as T;
}

/** Pure project transform used by Project-panel Copy/Paste. */
export function duplicateProjectEntries(
  project: Project,
  entries: ProjectTreeEntry[],
  targetParentBinId: string | null,
  ids: ProjectEntryIdFactory = defaultIds,
): DuplicateProjectEntriesResult {
  const roots = normalizeProjectCopyRoots(project, entries);
  if (roots.length === 0) {
    return { project, pastedEntries: [], htmlCompCopies: [], objectScriptCopies: [] };
  }
  const collected = collectEntries(project, roots);
  const binIds = new Map<string, string>();
  const compIds = new Map<string, string>();
  const assetIds = new Map<string, string>();
  for (const { entry } of collected) {
    if (entry.kind === "bin") binIds.set(entry.id, ids.bin());
    else if (entry.kind === "composition") compIds.set(entry.id, ids.comp());
    else assetIds.set(entry.id, ids.asset());
  }

  const rootKeys = new Set(roots.map(key));
  const newBins: ProjectBin[] = [];
  const newCompositions: Composition[] = [];
  const newAssets: AssetEntry[] = [];
  const htmlCompCopies: Array<{ from: string; to: string }> = [];
  const objectScriptCopies: Array<{ from: string; to: string }> = [];
  const clonedEntries: Array<{ entry: ProjectTreeEntry; parentBinId: string | null }> = [];

  for (const { entry } of collected) {
    const isRoot = rootKeys.has(key(entry));
    const sourceParent = parentBinOf(project, entry);
    const parentBinId = isRoot ? targetParentBinId : sourceParent ? binIds.get(sourceParent) ?? targetParentBinId : targetParentBinId;
    if (entry.kind === "bin") {
      const source = (project.bins ?? []).find((bin) => bin.id === entry.id)!;
      const id = binIds.get(entry.id)!;
      newBins.push({ ...structuredClone(source), id, name: isRoot ? `${source.name} copy` : source.name, parentId: parentBinId });
      clonedEntries.push({ entry: { kind: "bin", id }, parentBinId });
      continue;
    }
    if (entry.kind === "asset") {
      const source = project.assets.find((asset) => asset.id === entry.id)!;
      const id = assetIds.get(entry.id)!;
      newAssets.push(withBinId({ ...structuredClone(source), id }, parentBinId));
      clonedEntries.push({ entry: { kind: "asset", id }, parentBinId });
      continue;
    }
    const source = project.compositions.find((comp) => comp.id === entry.id)!;
    const id = compIds.get(entry.id)!;
    const name = isRoot ? `${source.name} copy` : source.name;
    if (source.kind === "timeline") {
      newCompositions.push(
        cloneTimelineComposition(
          source,
          id,
          parentBinId ?? undefined,
          name,
          compIds,
          assetIds,
          ids,
          objectScriptCopies,
        ),
      );
    } else {
      newCompositions.push(withBinId({ ...structuredClone(source), id, name }, parentBinId));
      htmlCompCopies.push({ from: source.id, to: id });
    }
    clonedEntries.push({ entry: { kind: "composition", id }, parentBinId });
  }

  let next: Project = {
    ...project,
    bins: [...(project.bins ?? []), ...newBins].sort((a, b) => a.id.localeCompare(b.id)),
    compositions: [...project.compositions, ...newCompositions].sort((a, b) => a.id.localeCompare(b.id)),
    assets: [...project.assets, ...newAssets].sort((a, b) => a.id.localeCompare(b.id)),
  };
  for (const clone of clonedEntries) next = appendTreeEntry(next, clone.entry, clone.parentBinId);

  const pastedEntries = roots.map((root) => {
    if (root.kind === "bin") return { kind: "bin" as const, id: binIds.get(root.id)! };
    if (root.kind === "composition") return { kind: "composition" as const, id: compIds.get(root.id)! };
    return { kind: "asset" as const, id: assetIds.get(root.id)! };
  });
  return { project: next, pastedEntries, htmlCompCopies, objectScriptCopies };
}
