import type { SceneObject } from "../core/schema";

/** §5.4e / §21.11: ロック中でも patch 可能なフィールド。 */
export const LOCK_EXEMPT_PATCH_KEYS = new Set<keyof SceneObject>([
  "locked",
  "enabled",
  "labelIndex",
]);

export function isLayerLocked(obj: SceneObject): boolean {
  return obj.locked === true;
}

export function isLockExemptPatch(patch: Partial<SceneObject>): boolean {
  const keys = Object.keys(patch) as (keyof SceneObject)[];
  if (keys.length === 0) return true;
  return keys.every((k) => LOCK_EXEMPT_PATCH_KEYS.has(k));
}

export function canEditLayer(obj: SceneObject, patch: Partial<SceneObject>): boolean {
  if (!isLayerLocked(obj)) return true;
  return isLockExemptPatch(patch);
}

/** §21.11: ロック以外のレイヤーへ一括表示/非表示する patch 列（変化があるものだけ）。 */
export function unlockedVisibilityPatches(
  objects: SceneObject[],
  enabled: boolean,
): { id: string; patch: Partial<SceneObject> }[] {
  return objects
    .filter((o) => !isLayerLocked(o) && o.enabled !== enabled)
    .map((o) => ({ id: o.id, patch: { enabled } }));
}
