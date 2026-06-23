import { newObjectId } from "../core/ids";
import type { Frame, Project, SceneObject, TimelineComposition } from "../core/schema";
import { duplicateObjectsWithRemap } from "./duplicateObjects";
import { defaultLabelIndexForObject } from "./layerLabels";
import { shiftFootageSourceOffset } from "./layerSourceOffset";
import type { EditorStore } from "./store";

// §17 Undo/Redo — command + 逆 patch。
//
// MVP 方式の決定（Opus 検証 2026-06-16）: 「変更前/後のプロジェクト全体スナップショット」を保持する。
//   - **load-bearing 不変条件**: すべての編集は **immutable update**（spread/map、in-place 変異禁止）。
//     これにより before/after は変更パスのみ clone し残りは参照共有される（structural sharing）。
//     実質 JSON patch と同等のメモリ効率になるため、MVP で全コピーを恐れる必要はない。
//     in-place 変異が 1 箇所でも混ざると過去スナップショットが破壊され undo が壊れる。
//   - 正式な明示 JSON patch（プロパティ単位の差分）への移行は **M3 後**に再評価（§17「推奨」）。
//     HTML comp 本体・expression script は FS ファイルで project.json に載らない（§3/§7/§9）ため、
//     M2 を経てもスナップショット対象（project.json）は小さく保たれる、というのが先送り根拠。
//   - スタックはセッション内のみ（永続化しない, §17）。

export interface Command {
  label: string;
  // before: 適用前の project 状態（undo に使う）
  before: Project;
  // after: 適用後の project 状態（redo に使う）
  after: Project;
}

export interface UndoRedoStack {
  past: Command[];
  future: Command[];
}

export function emptyStack(): UndoRedoStack {
  return { past: [], future: [] };
}

export function pushCommand(
  stack: UndoRedoStack,
  cmd: Command,
): UndoRedoStack {
  return {
    past: [...stack.past, cmd],
    future: [], // 新規 command で redo スタックをクリア
  };
}

export function undo(
  stack: UndoRedoStack,
): { stack: UndoRedoStack; project: Project } | null {
  const last = stack.past[stack.past.length - 1];
  if (!last) return null;
  return {
    stack: {
      past: stack.past.slice(0, -1),
      future: [last, ...stack.future],
    },
    project: last.before,
  };
}

export function redo(
  stack: UndoRedoStack,
): { stack: UndoRedoStack; project: Project } | null {
  const next = stack.future[0];
  if (!next) return null;
  return {
    stack: {
      past: [...stack.past, next],
      future: stack.future.slice(1),
    },
    project: next.after,
  };
}

// ---- 高レベル編集操作 ----
// 各関数は「before/after を作って store.applyCommand を呼ぶ」パターン。

export function cmdAddObject(
  store: EditorStore,
  obj: SceneObject,
): void {
  const before = store.project;
  if (!before) return;
  const toAdd: SceneObject = obj.labelIndex === undefined
    ? { ...obj, labelIndex: defaultLabelIndexForObject(obj) }
    : obj;
  const after = withCompObjects(before, store.currentCompId, (objs) => [...objs, toAdd]);
  store.applyCommand({ label: `Add ${toAdd.components[0]?.type ?? "object"}`, before, after });
}

export function cmdRemoveObject(
  store: EditorStore,
  objectId: string,
): void {
  const before = store.project;
  if (!before) return;
  const after = withCompObjects(before, store.currentCompId, (objs) =>
    objs.filter((o) => o.id !== objectId),
  );
  store.applyCommand({ label: "Remove object", before, after });
}

// P1-6: 複数レイヤーをまとめて削除（1 undo）。
export function cmdRemoveObjects(
  store: EditorStore,
  objectIds: string[],
): void {
  const before = store.project;
  if (!before || objectIds.length === 0) return;
  const idSet = new Set(objectIds);
  const after = withCompObjects(before, store.currentCompId, (objs) =>
    objs.filter((o) => !idSet.has(o.id)),
  );
  store.applyCommand({ label: `Remove ${objectIds.length} object(s)`, before, after });
}

export function cmdUpdateObject(
  store: EditorStore,
  objectId: string,
  patch: Partial<SceneObject>,
  label = "Edit object",
): void {
  const before = store.project;
  if (!before) return;
  const after = withCompObjects(before, store.currentCompId, (objs) =>
    objs.map((o) => (o.id === objectId ? { ...o, ...patch } : o)),
  );
  store.applyCommand({ label, before, after });
}

// §21.5 複数オブジェクト横断の patch を 1 command（1 undo）で確定する。
// keyframe の複数選択移動・削除のように、選択が複数レイヤーをまたぐ場合に使う。
export function cmdUpdateObjects(
  store: EditorStore,
  patches: { id: string; patch: Partial<SceneObject> }[],
  label = "Edit objects",
): void {
  const before = store.project;
  if (!before || patches.length === 0) return;
  const map = new Map(patches.map((p) => [p.id, p.patch]));
  const after = withCompObjects(before, store.currentCompId, (objs) =>
    objs.map((o) => (map.has(o.id) ? { ...o, ...map.get(o.id)! } : o)),
  );
  store.applyCommand({ label, before, after });
}

// §21.7 Duplicate: 選択オブジェクトを複製する（Ctrl+D）。
// 複製は元の zOrder + 0.5 (just above) で挿入。新 ULID を振る。選択を複製先に移す。
export function cmdDuplicateObjects(
  store: EditorStore,
  objects: SceneObject[],
): string[] {
  const before = store.project;
  if (!before || objects.length === 0) return [];
  const comp = before.compositions.find(
    (c) => c.id === store.currentCompId && c.kind === "timeline",
  ) as TimelineComposition | undefined;
  const existingIds = new Set(comp?.objects.map((o) => o.id) ?? []);
  const copies = duplicateObjectsWithRemap(objects, existingIds);
  const after = withCompObjects(before, store.currentCompId, (objs) => [...objs, ...copies]);
  store.applyCommand({ label: "Duplicate", before, after });
  return copies.map((c) => c.id);
}

// §21.7 Split Layer: 選択レイヤーをプレイヘッド位置で分割する（Ctrl+Shift+D）。
// 元レイヤー: outPoint = frame。新レイヤー: inPoint = frame（footage offset を連動）。
// プレイヘッドがレイヤー範囲外（frame <= inPoint || frame >= outPoint）はスキップ。
export function cmdSplitObjects(
  store: EditorStore,
  objects: SceneObject[],
  frame: Frame,
): string[] {
  const before = store.project;
  if (!before || objects.length === 0) return [];
  const splittable = objects.filter((o) => frame > o.inPoint && frame < o.outPoint);
  if (splittable.length === 0) return [];
  const newIds: string[] = [];
  const after = withCompObjects(before, store.currentCompId, (objs) => {
    const patchMap = new Map<string, Partial<SceneObject>>();
    const additions: SceneObject[] = [];
    for (const o of splittable) {
      // 元レイヤーを trim: outPoint = frame
      patchMap.set(o.id, { outPoint: frame });
      // footage 系コンポーネントの源時刻オフセットを分割位置で再計算
      // delta = 分割位置 - 元 inPoint（新レイヤーの footage 起点ずれ）
      const delta = frame - o.inPoint;
      const shifted = shiftFootageSourceOffset(o.components, delta);
      const newId = newObjectId();
      newIds.push(newId);
      additions.push({
        ...o,
        id: newId,
        inPoint: frame,
        // outPoint は元のまま（分割後後半の終端）
        zOrder: o.zOrder + 0.5,
        components: shifted ?? o.components,
      });
    }
    // 新レイヤー（後半）を元レイヤーの直前に挿入 → タイムライン上で元レイヤーの「上」に表示される。
    const origToNew = new Map(splittable.map((o, i) => [o.id, additions[i]!]));
    const result: SceneObject[] = [];
    for (const o of objs) {
      const newLayer = origToNew.get(o.id);
      if (newLayer) result.push(newLayer); // 後半レイヤーを先に追加（タイムライン上で上）
      result.push(patchMap.has(o.id) ? { ...o, ...patchMap.get(o.id)! } : o);
    }
    return result;
  });
  store.applyCommand({ label: "Split layer", before, after });
  return newIds;
}

// ---- ヘルパー ----

function withCompObjects(
  project: Project,
  compId: string,
  fn: (objs: SceneObject[]) => SceneObject[],
): Project {
  return {
    ...project,
    compositions: project.compositions.map((c) =>
      c.id === compId && c.kind === "timeline"
        ? { ...c, objects: fn((c as TimelineComposition).objects) }
        : c,
    ),
  };
}
