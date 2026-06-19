import type { Frame } from "../core/schema";

const STORAGE_KEY = "mafter-work-area-v1";

export interface WorkArea {
  inPoint: Frame;
  outPoint: Frame;
}

type WorkAreaByComp = Record<string, WorkArea>;

function readAll(): WorkAreaByComp {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as WorkAreaByComp;
  } catch {
    /* ignore */
  }
  return {};
}

function writeAll(data: WorkAreaByComp): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

/** §28.8 comp ごとのワークエリア（project.json 非汚染）。 */
export function loadWorkArea(compId: string, duration: number): WorkArea {
  const saved = readAll()[compId];
  if (!saved) return { inPoint: 0, outPoint: Math.max(1, duration) };
  const inPoint = Math.max(0, Math.min(duration - 1, saved.inPoint));
  const outPoint = Math.max(inPoint + 1, Math.min(duration, saved.outPoint));
  return { inPoint, outPoint };
}

export function saveWorkArea(compId: string, area: WorkArea): void {
  const all = readAll();
  all[compId] = area;
  writeAll(all);
}
