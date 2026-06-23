import { newObjectId } from "../core/ids";
import type { ObjectId, SceneObject } from "../core/schema";

/**
 * §21.7 Duplicate / Paste: 複製セットに新 ULID を振り、セット内の parent をリマップする。
 * - セット内 parent → 新 ID
 * - comp 内既存 parent（existingIds）→ 維持（子だけコピー時に元 Null へリンク）
 * - それ以外（カット後ペースト等）→ null（root 化）
 */
export function duplicateObjectsWithRemap(
  sources: SceneObject[],
  existingIds: ReadonlySet<string>,
): SceneObject[] {
  if (sources.length === 0) return [];

  const idMap = new Map<ObjectId, ObjectId>();
  for (const o of sources) {
    idMap.set(o.id, newObjectId());
  }

  return sources.map((o) => {
    const clone = structuredClone(o) as SceneObject;
    clone.id = idMap.get(o.id)!;
    clone.zOrder = o.zOrder + 0.5;
    clone.parent = resolveDuplicatedParent(o.parent, idMap, existingIds);
    return clone;
  });
}

function resolveDuplicatedParent(
  parent: ObjectId | null,
  idMap: ReadonlyMap<ObjectId, ObjectId>,
  existingIds: ReadonlySet<string>,
): ObjectId | null {
  if (parent === null) return null;
  const remapped = idMap.get(parent);
  if (remapped !== undefined) return remapped;
  if (existingIds.has(parent)) return parent;
  return null;
}
