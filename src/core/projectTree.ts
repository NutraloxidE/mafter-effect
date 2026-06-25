import type {
  Project,
  ProjectBin,
  ProjectTreeEntry,
} from "./schema";

/** ルート直下の treeOrder キー（§20.5）。 */
export const ROOT_TREE_KEY = "";

export function treeParentKey(binId: string | null | undefined): string {
  return binId ?? ROOT_TREE_KEY;
}

function byIdString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function entryKey(e: ProjectTreeEntry): string {
  return `${e.kind}:${e.id}`;
}

function byIdBin(a: ProjectBin, b: ProjectBin): number {
  return byIdString(a.id, b.id);
}

export function entryExists(project: Project, entry: ProjectTreeEntry): boolean {
  switch (entry.kind) {
    case "bin":
      return (project.bins ?? []).some((b) => b.id === entry.id);
    case "composition":
      return project.compositions.some((c) => c.id === entry.id);
    case "asset":
      return project.assets.some((a) => a.id === entry.id);
  }
}

/** 親フォルダ直下に属するエントリを id 昇順で列挙（treeOrder 未設定時の既定）。 */
export function defaultEntriesForParent(
  project: Project,
  parentBinId: string | null,
): ProjectTreeEntry[] {
  const key = treeParentKey(parentBinId);
  const entries: ProjectTreeEntry[] = [];

  for (const bin of project.bins ?? []) {
    if (treeParentKey(bin.parentId) === key) {
      entries.push({ kind: "bin", id: bin.id });
    }
  }
  for (const comp of project.compositions) {
    if (treeParentKey(comp.binId) === key) {
      entries.push({ kind: "composition", id: comp.id });
    }
  }
  for (const asset of project.assets) {
    if (treeParentKey(asset.binId) === key) {
      entries.push({ kind: "asset", id: asset.id });
    }
  }

  entries.sort((a, b) => byIdString(a.id, b.id));
  return entries;
}

export function orderedEntriesForParent(
  project: Project,
  parentBinId: string | null,
): ProjectTreeEntry[] {
  const key = treeParentKey(parentBinId);
  const expected = defaultEntriesForParent(project, parentBinId);
  const existing = project.treeOrder?.[key];
  if (!existing || existing.length === 0) return expected;

  const expectedSet = new Set(expected.map(entryKey));
  const valid: ProjectTreeEntry[] = [];
  const seen = new Set<string>();

  for (const e of existing) {
    const k = entryKey(e);
    if (!expectedSet.has(k) || seen.has(k) || !entryExists(project, e)) continue;
    valid.push(e);
    seen.add(k);
  }
  for (const e of expected) {
    const k = entryKey(e);
    if (!seen.has(k)) valid.push(e);
  }
  return valid;
}

function collectParentKeys(project: Project): string[] {
  const keys = new Set<string>([ROOT_TREE_KEY]);
  for (const bin of project.bins ?? []) {
    keys.add(bin.id);
    keys.add(treeParentKey(bin.parentId));
  }
  for (const comp of project.compositions) {
    keys.add(treeParentKey(comp.binId));
  }
  for (const asset of project.assets) {
    keys.add(treeParentKey(asset.binId));
  }
  return [...keys].sort(byIdString);
}

function stripEmptyTreeOrder(
  treeOrder: Record<string, ProjectTreeEntry[]> | undefined,
): Record<string, ProjectTreeEntry[]> | undefined {
  if (!treeOrder) return undefined;
  const out: Record<string, ProjectTreeEntry[]> = {};
  for (const key of Object.keys(treeOrder).sort(byIdString)) {
    const list = treeOrder[key];
    if (list && list.length > 0) out[key] = list;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** treeOrder が未設定時と同じ id 昇順なら直列化で省略してよい（§20.5 byte 等価）。 */
export function treeOrderIsRedundant(project: Project): boolean {
  const order = project.treeOrder;
  if (!order || Object.keys(order).length === 0) return true;

  const withoutOrder: Project = { ...project, treeOrder: undefined };
  for (const key of Object.keys(order)) {
    const parentBinId = key === ROOT_TREE_KEY ? null : key;
    const actual = order[key];
    if (!actual || actual.length === 0) continue;
    const def = defaultEntriesForParent(withoutOrder, parentBinId);
    if (actual.length !== def.length) return false;
    for (let i = 0; i < actual.length; i++) {
      const a = actual[i]!;
      const d = def[i]!;
      if (a.kind !== d.kind || a.id !== d.id) return false;
    }
  }
  return true;
}

/** treeOrder を修復し、不正 binId / parentId を正規化する。 */
export function ensureProjectTree(project: Project): Project {
  const binIds = new Set((project.bins ?? []).map((b) => b.id));
  let bins = [...(project.bins ?? [])];

  for (const bin of bins) {
    if (bin.parentId !== null && !binIds.has(bin.parentId)) {
      bin.parentId = null;
    }
  }

  const compositions = project.compositions.map((c) => {
    if (c.binId && !binIds.has(c.binId)) {
      const { binId: _removed, ...rest } = c;
      return rest;
    }
    return c;
  });

  const assets = project.assets.map((a) => {
    if (a.binId && !binIds.has(a.binId)) {
      const { binId: _removed, ...rest } = a;
      return rest;
    }
    return a;
  });

  const base: Project = {
    ...project,
    bins: bins.length > 0 ? bins.sort(byIdBin) : undefined,
    compositions,
    assets,
  };

  const treeOrder: Record<string, ProjectTreeEntry[]> = {};
  for (const key of collectParentKeys(base)) {
    const parentBinId = key === ROOT_TREE_KEY ? null : key;
    const ordered = orderedEntriesForParent(base, parentBinId);
    if (ordered.length > 0) treeOrder[key] = ordered;
  }

  return {
    ...base,
    treeOrder: stripEmptyTreeOrder(treeOrder),
  };
}

export function removeTreeEntry(project: Project, entry: ProjectTreeEntry): Project {
  const treeOrder = { ...(project.treeOrder ?? {}) };
  let changed = false;
  for (const key of Object.keys(treeOrder)) {
    const prev = treeOrder[key];
    if (!prev) continue;
    const list = prev.filter(
      (e) => !(e.kind === entry.kind && e.id === entry.id),
    );
    if (list.length !== prev.length) {
      changed = true;
      if (list.length === 0) delete treeOrder[key];
      else treeOrder[key] = list;
    }
  }
  if (!changed) return project;
  return { ...project, treeOrder: stripEmptyTreeOrder(treeOrder) };
}

export function appendTreeEntry(
  project: Project,
  entry: ProjectTreeEntry,
  parentBinId: string | null,
): Project {
  let p = removeTreeEntry(project, entry);
  const key = treeParentKey(parentBinId);
  const treeOrder = { ...(p.treeOrder ?? {}) };
  const base = (treeOrder[key] ?? orderedEntriesForParent(p, parentBinId)).filter(
    (e) => !(e.kind === entry.kind && e.id === entry.id),
  );
  treeOrder[key] = [...base, entry];
  return { ...p, treeOrder: stripEmptyTreeOrder(treeOrder) };
}

export function createBinInProject(
  project: Project,
  binId: string,
  name: string,
  parentBinId: string | null,
): Project {
  const bin: ProjectBin = { id: binId, name, parentId: parentBinId };
  const bins = [...(project.bins ?? []), bin].sort(byIdBin);
  let p: Project = { ...project, bins };
  p = appendTreeEntry(p, { kind: "bin", id: binId }, parentBinId);
  return p;
}

export function renameBinInProject(project: Project, binId: string, name: string): Project {
  const bins = (project.bins ?? []).map((b) => (b.id === binId ? { ...b, name } : b));
  return { ...project, bins: bins.length > 0 ? bins : undefined };
}

function setCompositionBinId(
  project: Project,
  compId: string,
  binId: string | undefined,
): Project {
  return {
    ...project,
    compositions: project.compositions.map((c) => {
      if (c.id !== compId) return c;
      if (!binId) {
        const { binId: _removed, ...rest } = c;
        return rest;
      }
      return { ...c, binId };
    }),
  };
}

function setAssetBinId(project: Project, assetId: string, binId: string | undefined): Project {
  return {
    ...project,
    assets: project.assets.map((a) => {
      if (a.id !== assetId) return a;
      if (!binId) {
        const { binId: _removed, ...rest } = a;
        return rest;
      }
      return { ...a, binId };
    }),
  };
}

function setBinParent(project: Project, binId: string, parentBinId: string | null): Project {
  const bins = (project.bins ?? []).map((b) =>
    b.id === binId ? { ...b, parentId: parentBinId } : b,
  );
  return { ...project, bins };
}

/** フォルダ削除: 中身を親フォルダへ移動してから bin を除去する。 */
export function deleteBinFromProject(project: Project, binId: string): Project {
  const bin = (project.bins ?? []).find((b) => b.id === binId);
  if (!bin) return project;

  const parentBinId = bin.parentId;
  const childEntries = orderedEntriesForParent(project, binId);

  let p: Project = {
    ...project,
    bins: (project.bins ?? []).filter((b) => b.id !== binId),
  };
  p = removeTreeEntry(p, { kind: "bin", id: binId });

  const treeOrder = { ...(p.treeOrder ?? {}) };
  delete treeOrder[binId];

  for (const entry of childEntries) {
    if (entry.kind === "bin") {
      p = setBinParent(p, entry.id, parentBinId);
    } else if (entry.kind === "composition") {
      p = setCompositionBinId(p, entry.id, parentBinId ?? undefined);
    } else {
      p = setAssetBinId(p, entry.id, parentBinId ?? undefined);
    }
    p = appendTreeEntry(p, entry, parentBinId);
  }

  return { ...p, treeOrder: stripEmptyTreeOrder(treeOrder) };
}

export function moveTreeEntries(
  project: Project,
  entries: ProjectTreeEntry[],
  targetParentBinId: string | null,
  index: number,
): Project {
  if (entries.length === 0) return project;

  let p = project;
  for (const entry of entries) {
    p = removeTreeEntry(p, entry);
  }

  for (const entry of entries) {
    if (entry.kind === "composition") {
      p = setCompositionBinId(p, entry.id, targetParentBinId ?? undefined);
    } else if (entry.kind === "asset") {
      p = setAssetBinId(p, entry.id, targetParentBinId ?? undefined);
    } else if (entry.kind === "bin") {
      p = setBinParent(p, entry.id, targetParentBinId);
    }
  }

  const key = treeParentKey(targetParentBinId);
  const treeOrder = { ...(p.treeOrder ?? {}) };
  const base = (treeOrder[key] ?? orderedEntriesForParent(p, targetParentBinId)).filter(
    (e) => !entries.some((m) => m.kind === e.kind && m.id === e.id),
  );
  const clamped = Math.max(0, Math.min(index, base.length));
  base.splice(clamped, 0, ...entries);
  treeOrder[key] = base;

  return { ...p, treeOrder: stripEmptyTreeOrder(treeOrder) };
}

/** 新規 comp / asset 追加時: ルート末尾へ treeOrder 登録。 */
export function registerNewProjectItem(
  project: Project,
  entry: ProjectTreeEntry,
): Project {
  return appendTreeEntry(project, entry, null);
}

/** comp / asset / bin 削除時に treeOrder から除去。 */
export function unregisterProjectItem(
  project: Project,
  entry: ProjectTreeEntry,
): Project {
  return removeTreeEntry(project, entry);
}
