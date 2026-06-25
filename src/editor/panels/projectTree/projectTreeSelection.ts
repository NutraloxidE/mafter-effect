import type { Project, ProjectTreeEntry } from "../../../core/schema";

export function entryKey(entry: ProjectTreeEntry): string {
  return `${entry.kind}:${entry.id}`;
}

export function parseEntryKey(key: string): ProjectTreeEntry | null {
  const sep = key.indexOf(":");
  if (sep < 0) return null;
  const kind = key.slice(0, sep);
  const id = key.slice(sep + 1);
  if (kind === "bin" || kind === "composition" || kind === "asset") {
    return { kind, id };
  }
  return null;
}

export function keysToEntries(keys: Iterable<string>): ProjectTreeEntry[] {
  const out: ProjectTreeEntry[] = [];
  for (const key of keys) {
    const entry = parseEntryKey(key);
    if (entry) out.push(entry);
  }
  return out;
}

export function isValidTreeEntry(value: unknown): value is ProjectTreeEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as ProjectTreeEntry;
  return (
    (e.kind === "bin" || e.kind === "composition" || e.kind === "asset") &&
    typeof e.id === "string" &&
    e.id.length > 0
  );
}

export function serializeTreeDragPayload(entries: ProjectTreeEntry[]): string {
  return JSON.stringify({ entries });
}

export function parseTreeDragPayload(data: string): ProjectTreeEntry[] {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (parsed && typeof parsed === "object" && "entries" in parsed) {
      const list = (parsed as { entries: unknown }).entries;
      if (Array.isArray(list)) {
        return list.filter(isValidTreeEntry);
      }
    }
    if (isValidTreeEntry(parsed)) return [parsed];
  } catch {
    /* ignore */
  }
  return [];
}

/** bin を targetBinId 配下へ移動してよいか（自分自身・子孫フォルダへは不可）。 */
export function canMoveBinTo(
  project: Project,
  movingBinId: string,
  targetBinId: string | null,
): boolean {
  if (targetBinId === null) return true;
  if (movingBinId === targetBinId) return false;
  const bins = project.bins ?? [];
  let cur = bins.find((b) => b.id === targetBinId);
  while (cur) {
    if (cur.id === movingBinId) return false;
    cur = cur.parentId ? bins.find((b) => b.id === cur!.parentId) : undefined;
  }
  return true;
}

export function filterMovableEntries(
  project: Project,
  entries: ProjectTreeEntry[],
  targetBinId: string | null,
): ProjectTreeEntry[] {
  return entries.filter((e) => {
    if (e.kind === "bin") return canMoveBinTo(project, e.id, targetBinId);
    return true;
  });
}
