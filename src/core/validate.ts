import type { Project, SceneObject, TimelineComposition } from "./schema";
import { CURRENT_SCHEMA_VERSION } from "./schema";

export interface ValidationResult {
  project: Project; // 正規化後（不正 parent を root 化した結果など）
  warnings: string[];
}

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
  }
}

// §5.6 マイグレーション登録テーブル（schemaVersion n → n+1）。
// 現状は v1 のみなので空。将来 v2 を足すときにここへ追加する。
const migrations: Record<number, (p: any) => any> = {};

/**
 * load 時 1 パス検証 + マイグレーション（§5.6 / §5.4-note）。
 * - schemaVersion が現行未満なら順に migration を適用。
 * - 現行より新しい未知バージョンは読み込み拒否（ProjectError）。
 * - 存在しない parent → root 扱い + warn。
 * - parent 循環（A→B→A）→ ProjectError。
 */
export function validateProject(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null) {
    throw new ProjectError("project.json: root must be an object");
  }
  const warnings: string[] = [];
  let project = migrate(raw as Project, warnings);

  for (const comp of project.compositions) {
    if (comp.kind === "timeline") {
      validateTimeline(comp, warnings);
    }
  }

  return { project, warnings };
}

function migrate(project: Project, warnings: string[]): Project {
  let version = project.schemaVersion as number;
  if (typeof version !== "number") {
    throw new ProjectError("project.json: missing schemaVersion");
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new ProjectError(
      `project.json: schemaVersion ${version} is newer than supported ${CURRENT_SCHEMA_VERSION}; refusing to load`,
    );
  }
  let p: any = project;
  while (version < CURRENT_SCHEMA_VERSION) {
    const step = migrations[version];
    if (!step) {
      throw new ProjectError(
        `project.json: no migration from schemaVersion ${version}`,
      );
    }
    p = step(p);
    version += 1;
    warnings.push(`migrated schemaVersion ${version - 1} → ${version}`);
  }
  return p as Project;
}

function validateTimeline(
  comp: TimelineComposition,
  warnings: string[],
): void {
  const byId = new Map<string, SceneObject>();
  for (const obj of comp.objects) byId.set(obj.id, obj);

  // 存在しない parent → root 化 + warn。
  for (const obj of comp.objects) {
    if (obj.parent !== null && !byId.has(obj.parent)) {
      warnings.push(
        `comp ${comp.id}: object ${obj.id} has unknown parent ${obj.parent}; treating as root`,
      );
      obj.parent = null;
    }
  }

  // 循環検出。
  const state = new Map<string, 0 | 1 | 2>(); // 0/undef=unseen, 1=in-stack, 2=done
  const visit = (id: string): void => {
    const s = state.get(id) ?? 0;
    if (s === 2) return;
    if (s === 1) {
      throw new ProjectError(`comp ${comp.id}: parent cycle detected at ${id}`);
    }
    state.set(id, 1);
    const parent = byId.get(id)?.parent;
    if (parent && byId.has(parent)) visit(parent);
    state.set(id, 2);
  };
  for (const obj of comp.objects) visit(obj.id);
}
