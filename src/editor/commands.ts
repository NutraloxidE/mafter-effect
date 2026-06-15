import type { Project, SceneObject, TimelineComposition } from "../core/schema";
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
  const after = withCompObjects(before, store.currentCompId, (objs) => [...objs, obj]);
  store.applyCommand({ label: `Add ${obj.components[0]?.type ?? "object"}`, before, after });
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
