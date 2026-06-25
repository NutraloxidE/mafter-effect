const STORAGE_KEY = "mafter-effect-project-bin-expanded";

function readSet(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function writeSet(set: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

export function isBinExpanded(binId: string): boolean {
  return readSet().has(binId);
}

export function setBinExpanded(binId: string, expanded: boolean): void {
  const set = readSet();
  if (expanded) set.add(binId);
  else set.delete(binId);
  writeSet(set);
}

export function toggleBinExpanded(binId: string): boolean {
  const set = readSet();
  const next = !set.has(binId);
  if (next) set.add(binId);
  else set.delete(binId);
  writeSet(set);
  return next;
}
