import type { ObjectId, Project, SceneObject, TimelineComposition } from "./schema";
import { CURRENT_SCHEMA_VERSION } from "./schema";
import { isKnownBlendMode } from "./blendMode";
import { ensureProjectTree } from "./projectTree";

export interface ValidationResult {
  project: Project; // 正規化後（不正 parent を root 化した結果など）
  warnings: string[];
  /** エディタ専用: 未知 blendMode の raw 名（objectId → 文字列）。project.json には書かない。 */
  missingBlendModes: Record<ObjectId, string>;
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
  const missingBlendModes: Record<ObjectId, string> = {};
  let project = migrate(raw as Project, warnings);

  for (const comp of project.compositions) {
    validateCompMeta(comp, warnings);
    if (comp.kind === "timeline") {
      validateTimeline(comp, warnings, missingBlendModes);
    }
  }

  validateProjectBins(project, warnings);
  project = ensureProjectTree(project);

  return { project, warnings, missingBlendModes };
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

// §21.1b: 全 comp（timeline/html）共通の表示専用メタ検証。bpm/beatsPerBar を正規化。
function validateCompMeta(
  comp: { id: string; bpm?: number; beatsPerBar?: number },
  warnings: string[],
): void {
  if (comp.bpm !== undefined) {
    if (typeof comp.bpm !== "number" || !Number.isFinite(comp.bpm) || comp.bpm < 0) {
      warnings.push(`comp ${comp.id}: invalid bpm ${String(comp.bpm)}; clearing`);
      comp.bpm = undefined;
      comp.beatsPerBar = undefined;
    } else if (comp.bpm === 0) {
      comp.bpm = undefined;
      comp.beatsPerBar = undefined;
    }
  }
  if (comp.beatsPerBar !== undefined) {
    if (comp.bpm === undefined) {
      comp.beatsPerBar = undefined; // bpm 無効時は無意味
    } else if (
      typeof comp.beatsPerBar !== "number" ||
      !Number.isInteger(comp.beatsPerBar) ||
      comp.beatsPerBar < 1
    ) {
      warnings.push(
        `comp ${comp.id}: invalid beatsPerBar ${String(comp.beatsPerBar)}; using 4`,
      );
      comp.beatsPerBar = 4;
    }
  }
}

function validateTimeline(
  comp: TimelineComposition,
  warnings: string[],
  missingBlendModes: Record<ObjectId, string>,
): void {
  const byId = new Map<string, SceneObject>();
  for (const obj of comp.objects) byId.set(obj.id, obj);

  for (const obj of comp.objects) {
    if (obj.isNull === true && obj.isAdjustment === true) {
      warnings.push(
        `comp ${comp.id}: object ${obj.id} has both isNull and isAdjustment; treating as Null (clearing isAdjustment)`,
      );
      obj.isAdjustment = undefined;
    }
    // §5.4d: 不明な blendMode は normal 扱い（undefined）にする。エディタは missingBlendModes で表示。
    if (obj.blendMode !== undefined && !isKnownBlendMode(obj.blendMode)) {
      warnings.push(
        `comp ${comp.id}: object ${obj.id} has unknown blendMode ${String(obj.blendMode)}; treating as normal`,
      );
      if (obj.blendMode !== "") {
        missingBlendModes[obj.id] = String(obj.blendMode);
      }
      obj.blendMode = undefined;
    }
    // §27.4: adjustmentMode は調整レイヤーのみ有効。不正値・非調整は live 扱い（undefined）にする。
    if (obj.adjustmentMode !== undefined) {
      if (obj.isAdjustment !== true) {
        warnings.push(
          `comp ${comp.id}: object ${obj.id} has adjustmentMode without isAdjustment; clearing`,
        );
        obj.adjustmentMode = undefined;
      } else if (obj.adjustmentMode !== "live" && obj.adjustmentMode !== "raster") {
        warnings.push(
          `comp ${comp.id}: object ${obj.id} has invalid adjustmentMode ${String(obj.adjustmentMode)}; treating as live`,
        );
        obj.adjustmentMode = undefined;
      }
    }
    // §5.4e: locked は boolean のみ有効。
    if (obj.locked !== undefined && typeof obj.locked !== "boolean") {
      warnings.push(
        `comp ${comp.id}: object ${obj.id} has invalid locked ${String(obj.locked)}; clearing`,
      );
      obj.locked = undefined;
    }
  }

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

function validateProjectBins(project: Project, warnings: string[]): void {
  const bins = project.bins ?? [];
  const binIds = new Set(bins.map((b) => b.id));

  for (const bin of bins) {
    if (bin.parentId !== null && !binIds.has(bin.parentId)) {
      warnings.push(
        `project bin ${bin.id} has unknown parent ${bin.parentId}; treating as root`,
      );
      bin.parentId = null;
    }
    if (bin.parentId === bin.id) {
      warnings.push(`project bin ${bin.id} is its own parent; treating as root`);
      bin.parentId = null;
    }
  }

  const state = new Map<string, 0 | 1 | 2>();
  const byId = new Map(bins.map((b) => [b.id, b]));
  const visit = (id: string): void => {
    const s = state.get(id) ?? 0;
    if (s === 2) return;
    if (s === 1) {
      throw new ProjectError(`project: bin parent cycle detected at ${id}`);
    }
    state.set(id, 1);
    const parent = byId.get(id)?.parentId;
    if (parent && byId.has(parent)) visit(parent);
    state.set(id, 2);
  };
  for (const bin of bins) visit(bin.id);

  for (const comp of project.compositions) {
    if (comp.binId && !binIds.has(comp.binId)) {
      warnings.push(
        `composition ${comp.id} has unknown binId ${comp.binId}; treating as root`,
      );
      comp.binId = undefined;
    }
  }
  for (const asset of project.assets) {
    if (asset.binId && !binIds.has(asset.binId)) {
      warnings.push(
        `asset ${asset.id} has unknown binId ${asset.binId}; treating as root`,
      );
      asset.binId = undefined;
    }
  }
}
