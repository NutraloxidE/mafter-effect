import type { ObjectId, SceneObject } from "../core/schema";

/** 指定オブジェクトの子孫 id（直接・間接）を収集する。 */
export function collectDescendantIds(
  objects: SceneObject[],
  objectId: ObjectId,
): Set<ObjectId> {
  const childrenByParent = new Map<ObjectId, ObjectId[]>();
  for (const obj of objects) {
    if (obj.parent === null) continue;
    const list = childrenByParent.get(obj.parent) ?? [];
    list.push(obj.id);
    childrenByParent.set(obj.parent, list);
  }

  const out = new Set<ObjectId>();
  const queue: ObjectId[] = [...(childrenByParent.get(objectId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (out.has(id)) continue;
    out.add(id);
    const kids = childrenByParent.get(id);
    if (kids) queue.push(...kids);
  }
  return out;
}

export function isValidParent(
  objects: SceneObject[],
  childId: ObjectId,
  parentId: ObjectId | null,
): boolean {
  if (parentId === null) return true;
  if (parentId === childId) return false;
  const byId = new Map(objects.map((o) => [o.id, o]));
  if (!byId.has(parentId)) return false;
  const descendants = collectDescendantIds(objects, childId);
  return !descendants.has(parentId);
}

/** parent 候補（自分・子孫を除く）。並びは呼び出し側の objects 順を維持。 */
export function listParentCandidates(
  objects: SceneObject[],
  childId: ObjectId,
): SceneObject[] {
  const descendants = collectDescendantIds(objects, childId);
  return objects.filter((o) => o.id !== childId && !descendants.has(o.id));
}
