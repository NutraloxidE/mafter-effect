import type { AnimatedProp, Easing, SceneObject, Transform, Vec3 } from "../core/schema";

// §21.5 KF 複数選択。選択は (objectId, propertyPath, frame) の集合。
// P1-7: component prop パスは "comp_<idx>_<key>" 形式で拡張。
export type PropPath = string;

export const KF_SEP = "|";

export const kfKey = (objId: string, path: PropPath, frame: number): string =>
  `${objId}${KF_SEP}${path}${KF_SEP}${frame}`;

export function parseKfKey(key: string): { objId: string; path: PropPath; frame: number } {
  const i = key.indexOf(KF_SEP);
  const j = key.lastIndexOf(KF_SEP);
  return {
    objId: key.slice(0, i),
    path: key.slice(i + 1, j) as PropPath,
    frame: Number(key.slice(j + 1)),
  };
}

type TransformVecKey = "anchor" | "position" | "rotation" | "scale";

export function isAnimatedProp(v: unknown): v is AnimatedProp<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    "value" in v &&
    "keyframes" in v &&
    Array.isArray((v as AnimatedProp<unknown>).keyframes)
  );
}

/** タイムライン J/K 用: 選択レイヤー（未選択時は全レイヤー）の KF フレームを昇順で返す。 */
export function collectKfFrames(objects: SceneObject[], selectedIds: string[]): number[] {
  const targetObjs = selectedIds.length > 0 ? objects.filter((o) => selectedIds.includes(o.id)) : objects;
  const frameSet = new Set<number>();
  for (const obj of targetObjs) {
    [obj.transform.anchor, obj.transform.position, obj.transform.rotation, obj.transform.scale, obj.opacity]
      .forEach((prop) => prop.keyframes.forEach((kf) => frameSet.add(kf.frame)));
    for (const comp of obj.components) {
      for (const val of Object.values(comp.props)) {
        if (isAnimatedProp(val)) val.keyframes.forEach((kf) => frameSet.add(kf.frame));
      }
    }
    for (const effect of obj.effects ?? []) {
      for (const val of Object.values(effect.props)) {
        if (isAnimatedProp(val)) val.keyframes.forEach((kf) => frameSet.add(kf.frame));
      }
    }
    for (const inst of obj.expressionPresets ?? []) {
      for (const val of Object.values(inst.props)) {
        if (isAnimatedProp(val)) val.keyframes.forEach((kf) => frameSet.add(kf.frame));
      }
    }
  }
  return [...frameSet].sort((a, b) => a - b);
}

export function getPropByPath(obj: SceneObject, path: PropPath): AnimatedProp<unknown> {
  if (path === "opacity") return obj.opacity;
  if (path.startsWith("transform.")) {
    const key = path.slice("transform.".length) as TransformVecKey;
    return obj.transform[key];
  }
  if (path.startsWith("comp_")) {
    const rest = path.slice(5);
    const sep = rest.indexOf("_");
    const idx = Number(rest.slice(0, sep));
    const key = rest.slice(sep + 1);
    const val = obj.components[idx]?.props[key];
    if (isAnimatedProp(val)) return val;
  }
  if (path.startsWith("effects.")) {
    const rest = path.slice("effects.".length);
    const dot = rest.indexOf(".");
    if (dot < 0) return { value: 0, keyframes: [] };
    const effectId = rest.slice(0, dot);
    const key = rest.slice(dot + 1);
    const effect = obj.effects?.find((e) => e.id === effectId);
    const val = effect?.props[key];
    if (isAnimatedProp(val)) return val;
  }
  if (path.startsWith("expressionPresets.")) {
    const rest = path.slice("expressionPresets.".length);
    const dot = rest.indexOf(".");
    if (dot < 0) return { value: 0, keyframes: [] };
    const instanceId = rest.slice(0, dot);
    const key = rest.slice(dot + 1);
    const inst = obj.expressionPresets?.find((p) => p.id === instanceId);
    const val = inst?.props[key];
    if (isAnimatedProp(val)) return val;
  }
  return { value: 0, keyframes: [] };
}

export function moveKfFrames<T>(prop: AnimatedProp<T>, frames: Set<number>, delta: number): AnimatedProp<T> {
  if (delta === 0) return prop;
  const targets = new Set<number>();
  frames.forEach((f) => targets.add(f + delta));
  const kept = prop.keyframes.filter((k) => !frames.has(k.frame) && !targets.has(k.frame));
  const moved = prop.keyframes
    .filter((k) => frames.has(k.frame))
    .map((k) => ({ ...k, frame: k.frame + delta }));
  return { ...prop, keyframes: [...kept, ...moved].sort((a, b) => a.frame - b.frame) };
}

export function deleteKfFrames<T>(prop: AnimatedProp<T>, frames: Set<number>): AnimatedProp<T> {
  return { ...prop, keyframes: prop.keyframes.filter((k) => !frames.has(k.frame)) };
}

export function applyKfEasing<T>(prop: AnimatedProp<T>, frames: Set<number>, easing: Easing): AnimatedProp<T> {
  return { ...prop, keyframes: prop.keyframes.map((k) => (frames.has(k.frame) ? { ...k, easing } : k)) };
}

export function groupSelectedKfs(keys: Iterable<string>): Map<string, Map<PropPath, Set<number>>> {
  const m = new Map<string, Map<PropPath, Set<number>>>();
  for (const key of keys) {
    const { objId, path, frame } = parseKfKey(key);
    let pm = m.get(objId);
    if (!pm) {
      pm = new Map();
      m.set(objId, pm);
    }
    let fs = pm.get(path);
    if (!fs) {
      fs = new Set();
      pm.set(path, fs);
    }
    fs.add(frame);
  }
  return m;
}

export function buildKfPatches(
  objects: SceneObject[],
  group: Map<string, Map<PropPath, Set<number>>>,
  fn: (prop: AnimatedProp<unknown>, frames: Set<number>) => AnimatedProp<unknown>,
): { id: string; patch: Partial<SceneObject> }[] {
  const patches: { id: string; patch: Partial<SceneObject> }[] = [];
  for (const [objId, pm] of group) {
    const obj = objects.find((o) => o.id === objId);
    if (!obj) continue;
    const patch: Partial<SceneObject> = {};
    let transform: Transform = obj.transform;
    let touchedTransform = false;
    const compMods = new Map<number, Map<string, AnimatedProp<unknown>>>();
    const effectMods = new Map<string, Map<string, AnimatedProp<unknown>>>();
    const exprPresetMods = new Map<string, Map<string, AnimatedProp<unknown>>>();
    for (const [path, frames] of pm) {
      const next = fn(getPropByPath(obj, path), frames);
      if (path === "opacity") {
        patch.opacity = next as AnimatedProp<number>;
      } else if (path.startsWith("transform.")) {
        const k = path.slice("transform.".length) as TransformVecKey;
        transform = { ...transform, [k]: next as AnimatedProp<Vec3> };
        touchedTransform = true;
      } else if (path.startsWith("comp_")) {
        const rest = path.slice(5);
        const sep = rest.indexOf("_");
        const idx = Number(rest.slice(0, sep));
        const key = rest.slice(sep + 1);
        if (!compMods.has(idx)) compMods.set(idx, new Map());
        compMods.get(idx)!.set(key, next);
      } else if (path.startsWith("effects.")) {
        const rest = path.slice("effects.".length);
        const dot = rest.indexOf(".");
        if (dot < 0) continue;
        const effectId = rest.slice(0, dot);
        const key = rest.slice(dot + 1);
        if (!effectMods.has(effectId)) effectMods.set(effectId, new Map());
        effectMods.get(effectId)!.set(key, next);
      } else if (path.startsWith("expressionPresets.")) {
        const rest = path.slice("expressionPresets.".length);
        const dot = rest.indexOf(".");
        if (dot < 0) continue;
        const instanceId = rest.slice(0, dot);
        const key = rest.slice(dot + 1);
        if (!exprPresetMods.has(instanceId)) exprPresetMods.set(instanceId, new Map());
        exprPresetMods.get(instanceId)!.set(key, next);
      }
    }
    if (touchedTransform) patch.transform = transform;
    if (compMods.size > 0) {
      patch.components = obj.components.map((c, i) => {
        const kv = compMods.get(i);
        if (!kv) return c;
        return { ...c, props: { ...c.props, ...Object.fromEntries(kv) } };
      });
    }
    if (effectMods.size > 0 && obj.effects) {
      patch.effects = obj.effects.map((e) => {
        const kv = effectMods.get(e.id);
        if (!kv) return e;
        return { ...e, props: { ...e.props, ...Object.fromEntries(kv) } };
      });
    }
    if (exprPresetMods.size > 0 && obj.expressionPresets) {
      patch.expressionPresets = obj.expressionPresets.map((p) => {
        const kv = exprPresetMods.get(p.id);
        if (!kv) return p;
        return { ...p, props: { ...p.props, ...Object.fromEntries(kv) } };
      });
    }
    patches.push({ id: objId, patch });
  }
  return patches;
}
