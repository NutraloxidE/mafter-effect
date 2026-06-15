import { create } from "zustand";
import { createProject } from "../core/createProject";
import { newObjectId } from "../core/ids";
import { loadProject, saveProject } from "../core/projectFs";
import { defaultTransform, staticProp, vec3 } from "../core/props";
import type {
  AnimatedProp,
  Easing,
  Frame,
  Keyframe,
  Project,
  SceneObject,
  TimelineComposition,
  Vec3,
} from "../core/schema";
import { IndexedDbFs } from "../fs/IndexedDbFs";
import { sampleVec3 } from "../runtime/interpolate";
import {
  cmdAddObject,
  cmdRemoveObject,
  cmdUpdateObject,
  emptyStack,
  pushCommand,
  redo,
  undo,
  type Command,
  type UndoRedoStack,
} from "./commands";

// §17: プロジェクトデータの正は FS（IndexedDbFs）。ストアはその投影。

const fs = new IndexedDbFs("mafter-effect-fs");

export interface EditorStore {
  // データ
  project: Project | null;
  currentCompId: string;
  currentFrame: Frame;
  selectedObjectIds: string[];

  // Undo/Redo スタック（セッション内のみ, §17）
  undoStack: UndoRedoStack;

  // FS 操作
  newProject: () => void;
  loadFromFs: () => Promise<void>;
  saveToFs: () => Promise<void>;

  // command 適用（内部 + 公開：command 層から使う）
  applyCommand: (cmd: Command) => void;

  // Undo/Redo
  undo: () => void;
  redo: () => void;

  // ナビゲーション
  setFrame: (frame: Frame) => void;
  setCurrentComp: (id: string) => void;
  selectObjects: (ids: string[]) => void;

  // 高レベル編集（→ commands.ts 経由でスタックに積む）
  addObject: (obj: SceneObject) => void;
  removeObject: (id: string) => void;
  updateObject: (id: string, patch: Partial<SceneObject>, label?: string) => void;

  // ショートカット: オブジェクトを新規追加して ID を返す
  addSolid: (name?: string) => string | null;
  addText: (name?: string) => string | null;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  project: null,
  currentCompId: "",
  currentFrame: 0,
  selectedObjectIds: [],
  undoStack: emptyStack(),

  newProject: () => {
    const p = createProject({ name: "Untitled" });
    set({
      project: p,
      currentCompId: p.rootComposition,
      currentFrame: 0,
      selectedObjectIds: [],
      undoStack: emptyStack(),
    });
  },

  loadFromFs: async () => {
    try {
      const { project: p } = await loadProject(fs);
      set({
        project: p,
        currentCompId: p.rootComposition,
        currentFrame: 0,
        selectedObjectIds: [],
        undoStack: emptyStack(),
      });
    } catch {
      // FS に project.json が無い場合など: 新規作成
      get().newProject();
    }
  },

  saveToFs: async () => {
    const p = get().project;
    if (!p) return;
    await saveProject(fs, p);
  },

  applyCommand: (cmd: Command) => {
    set((s) => ({
      project: cmd.after,
      undoStack: pushCommand(s.undoStack, cmd),
    }));
    // バックグラウンドで自動保存
    void saveProject(fs, cmd.after);
  },

  undo: () => {
    const result = undo(get().undoStack);
    if (!result) return;
    set({ project: result.project, undoStack: result.stack });
    void saveProject(fs, result.project);
  },

  redo: () => {
    const result = redo(get().undoStack);
    if (!result) return;
    set({ project: result.project, undoStack: result.stack });
    void saveProject(fs, result.project);
  },

  setFrame: (frame) => set({ currentFrame: frame }),
  setCurrentComp: (id) => set({ currentCompId: id }),
  selectObjects: (ids) => set({ selectedObjectIds: ids }),

  addObject: (obj) => cmdAddObject(get(), obj),
  removeObject: (id) => cmdRemoveObject(get(), id),
  updateObject: (id, patch, label) => cmdUpdateObject(get(), id, patch, label),

  addSolid: (name) => {
    const id = newObjectId();
    const p = get().project;
    const comp = p?.compositions.find((c) => c.id === get().currentCompId) as TimelineComposition | undefined;
    const duration = comp?.duration ?? 150;
    const obj: SceneObject = {
      id,
      name: name ?? "Solid",
      parent: null,
      zOrder: nextZOrder(comp),
      enabled: true,
      inPoint: 0,
      outPoint: duration,
      transform: defaultTransform(),
      opacity: staticProp(1),
      components: [
        {
          type: "solid",
          props: {
            color: { value: { r: 0.5, g: 0.5, b: 0.9, a: 1 }, keyframes: [] },
            size: staticProp(vec3(400, 300, 0)),
          },
        },
      ],
    };
    cmdAddObject(get(), obj);
    return id;
  },

  addText: (name) => {
    const id = newObjectId();
    const p = get().project;
    const comp = p?.compositions.find((c) => c.id === get().currentCompId) as TimelineComposition | undefined;
    const duration = comp?.duration ?? 150;
    const obj: SceneObject = {
      id,
      name: name ?? "Text",
      parent: null,
      zOrder: nextZOrder(comp),
      enabled: true,
      inPoint: 0,
      outPoint: duration,
      transform: defaultTransform(),
      opacity: staticProp(1),
      components: [
        {
          type: "text",
          props: {
            text: staticProp("Hello"),
            font: staticProp("sans-serif"),
            size: staticProp(48),
            color: { value: { r: 1, g: 1, b: 1, a: 1 }, keyframes: [] },
            align: staticProp("left"),
          },
        },
      ],
    };
    cmdAddObject(get(), obj);
    return id;
  },
}));

// ---- ユーティリティ ----

function nextZOrder(comp: TimelineComposition | undefined): number {
  if (!comp || comp.objects.length === 0) return 1;
  return Math.max(...comp.objects.map((o) => o.zOrder)) + 1;
}

/** 指定オブジェクトの AnimatedProp<number> に現 frame のキーフレームを追加/更新する。 */
export function setKeyframe<T>(
  prop: AnimatedProp<T>,
  frame: Frame,
  value: T,
  easing: Easing = { type: "linear" },
): AnimatedProp<T> {
  const existing = prop.keyframes.findIndex((k) => k.frame === frame);
  const kf: Keyframe<T> = { frame, value, easing };
  if (existing >= 0) {
    const kfs = [...prop.keyframes];
    kfs[existing] = kf;
    return { ...prop, keyframes: kfs };
  }
  const kfs = [...prop.keyframes, kf].sort((a, b) => a.frame - b.frame);
  return { ...prop, keyframes: kfs };
}

/** 現在の comp を取得する（型ガード付き）。 */
export function currentTimelineComp(
  project: Project | null,
  compId: string,
): TimelineComposition | null {
  if (!project) return null;
  const comp = project.compositions.find((c) => c.id === compId);
  if (!comp || comp.kind !== "timeline") return null;
  return comp;
}

/** 選択中オブジェクトを取得する。 */
export function selectedObjects(
  project: Project | null,
  compId: string,
  selectedIds: string[],
): SceneObject[] {
  const comp = currentTimelineComp(project, compId);
  if (!comp) return [];
  return comp.objects.filter((o) => selectedIds.includes(o.id));
}

/** AnimatedProp<Vec3> の value を表示用に返す。 */
export function propVec3ToDisplay(
  prop: AnimatedProp<Vec3>,
  frame: Frame,
): { x: string; y: string; z: string } {
  const v = sampleVec3(prop, frame);
  return { x: v.x.toFixed(1), y: v.y.toFixed(1), z: v.z.toFixed(1) };
}
