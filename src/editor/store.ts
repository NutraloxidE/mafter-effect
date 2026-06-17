import { create } from "zustand";
import { createProject } from "../core/createProject";
import { newCompId, newObjectId } from "../core/ids";
import { loadProject, saveProject } from "../core/projectFs";
import { defaultTransform, staticProp, vec3 } from "../core/props";
import type {
  AnimatedProp,
  AssetEntry,
  Easing,
  Frame,
  HtmlComposition,
  Keyframe,
  Project,
  SceneObject,
  TimelineComposition,
  Vec3,
} from "../core/schema";
import { IndexedDbFs } from "../fs/IndexedDbFs";
import { compositionDir, DIR_ASSETS, pluginEntryPath, pluginManifestPath, scriptPath } from "../core/paths";
import { compWouldCreateCycle } from "../runtime/compLayer";
import { registerBuiltinComponents } from "../runtime/builtinComponents";
import { sampleScalar, sampleVec3 } from "../runtime/interpolate";
import { ModuleLoader } from "../runtime/moduleLoader";
import type { PluginContext, PluginManifest } from "../runtime/plugin";
import { globalPluginRegistry } from "../runtime/pluginRegistry";
import {
  cmdAddObject,
  cmdDuplicateObjects,
  cmdRemoveObject,
  cmdRemoveObjects,
  cmdSplitObjects,
  cmdUpdateObject,
  cmdUpdateObjects,
  emptyStack,
  pushCommand,
  redo,
  undo,
  type Command,
  type UndoRedoStack,
} from "./commands";
import { buildGlyphDecomposeObjects, createCanvasMeasureContext } from "./glyphDecompose";

registerBuiltinComponents();

// §17: プロジェクトデータの正は FS（IndexedDbFs）。ストアはその投影。

const fs = new IndexedDbFs("mafter-effect-fs");
const pluginLoader = new ModuleLoader(fs);

// §12 サンプルプラグイン JS（gradient-rect component）。installSamplePlugin() で FS に書き込む。
const SAMPLE_PLUGIN_JS = `// Mafter Effect Sample Plugin — gradient-rect component
export default function activate(ctx) {
  ctx.registerComponent({
    type: "gradient-rect",
    label: "Gradient Rect",
    params: [
      { key: "width",  label: "Width",   kind: "scalar", default: 400, animatable: true, min: 1 },
      { key: "height", label: "Height",  kind: "scalar", default: 300, animatable: true, min: 1 },
      { key: "colorA", label: "Color A", kind: "color",  default: { r: 1, g: 0.2, b: 0.5, a: 1 }, animatable: true },
      { key: "colorB", label: "Color B", kind: "color",  default: { r: 0.1, g: 0.5, b: 1, a: 1 }, animatable: true },
      { key: "angle",  label: "Angle",   kind: "scalar", default: 90, animatable: true, min: 0, max: 360 },
    ],
    render({ el, props }) {
      const w = typeof props.width === "number" ? props.width : 400;
      const h = typeof props.height === "number" ? props.height : 300;
      const a = props.colorA && typeof props.colorA === "object" ? props.colorA : { r: 1, g: 0.2, b: 0.5, a: 1 };
      const b = props.colorB && typeof props.colorB === "object" ? props.colorB : { r: 0.1, g: 0.5, b: 1, a: 1 };
      const angle = typeof props.angle === "number" ? props.angle : 90;
      const rgba = (c) => \`rgba(\${Math.round(c.r*255)},\${Math.round(c.g*255)},\${Math.round(c.b*255)},\${c.a ?? 1})\`;
      el.style.width = w + "px";
      el.style.height = h + "px";
      el.style.background = \`linear-gradient(\${angle}deg, \${rgba(a)}, \${rgba(b)})\`;
    },
  });
}
`;

export interface EditorStore {
  // データ
  project: Project | null;
  currentCompId: string;
  currentFrame: Frame;
  selectedObjectIds: string[];
  isPlaying: boolean;

  // §12 Plugin 管理
  pluginsVersion: number; // loadPlugins() 完了のたびにインクリメント。PreviewPanel が subscribe して再描画する。

  // §21.5 KF 複数選択（タイムライン ↔ Ease パネル共有）
  selectedKfKeys: string[];
  setSelectedKfKeys: (keys: string[] | ((prev: string[]) => string[])) => void;

  // §26.4 プレビュー品質（グローバル。永続化は previewViewerStorage）
  previewQuality: "draft" | "precise";
  previewQualityEditing: boolean;
  setPreviewQuality: (mode: "draft" | "precise") => void;
  setPreviewQualityEditing: (editing: boolean) => void;
  decomposeGlyphs: (objectId: string) => void;

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

  // 再生制御
  setPlaying: (v: boolean) => void;
  togglePlay: () => void;

  // ナビゲーション
  setFrame: (frame: Frame) => void;
  setCurrentComp: (id: string) => void;
  selectObjects: (ids: string[]) => void;

  // §20.2 コンポジション管理
  addTimelineComp: (name?: string) => string | null;
  removeComposition: (id: string) => void;
  renameComposition: (id: string, name: string) => void;

  // 高レベル編集（→ commands.ts 経由でスタックに積む）
  addObject: (obj: SceneObject) => void;
  removeObject: (id: string) => void;
  removeObjects: (ids: string[]) => void;
  updateObject: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  // §21.5 複数オブジェクト横断の patch を 1 command（1 undo）で確定する。
  updateObjects: (patches: { id: string; patch: Partial<SceneObject> }[], label?: string) => void;
  // §21.7 Duplicate (Ctrl+D): 選択レイヤーを複製し、複製先を選択状態にする。
  duplicateSelected: () => void;
  // §21.7 Split Layer (Ctrl+Shift+D): 選択レイヤーをプレイヘッド位置で分割し、後半レイヤーを選択する。
  splitSelected: () => void;
  // P1-9 Paste (Ctrl+V): クリップボードのレイヤーを新 ID で貼り付け、選択状態にする。
  pasteObjects: (objects: SceneObject[]) => string[];

  // ショートカット: オブジェクトを新規追加して ID を返す
  addSolid: (name?: string) => string | null;
  // fs アクセス（外部公開：ExportDialog など）
  getFs: () => IndexedDbFs;
  addText: (name?: string) => string | null;
  // M2: HTML comp 追加（FS にスターターファイルを書き込む）
  // M3 実装はインターフェース末尾（importAudioAsset / addAudioLayer）
  addHtmlComp: (name?: string) => Promise<string | null>;
  // M2: HTML comp を現タイムラインに html component オブジェクトとして配置する
  addHtmlInstance: (compId: string) => string | null;
  // M2: 選択プロパティに wiggle expression を付与する（FS に式ファイルを書き込む）
  addWiggleExpression: (objectId: string) => Promise<void>;
  // M3: 音声アセットをインポートして project.assets に追加する
  importAudioAsset: (file: File) => Promise<string | null>;
  // M3: audio component を持つ SceneObject を追加する
  addAudioLayer: (assetId: string, name?: string) => string | null;

  // M4: plugin ロード・管理
  loadPlugins: () => Promise<void>;
  installSamplePlugin: () => Promise<void>;
  togglePlugin: (id: string, enabled: boolean) => void;
  addPluginObject: (componentType: string) => string | null;

  // §23 comp layer: timeline comp をアクティブコンプにレイヤーとして配置する
  addCompLayer: (compId: string, name?: string) => string | null;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  project: null,
  currentCompId: "",
  currentFrame: 0,
  selectedObjectIds: [],
  selectedKfKeys: [],
  isPlaying: false,
  previewQuality: "draft",
  previewQualityEditing: false,
  pluginsVersion: 0,
  undoStack: emptyStack(),

  newProject: () => {
    const p = createProject({ name: "Untitled" });
    set({
      project: p,
      currentCompId: p.rootComposition,
      currentFrame: 0,
      selectedObjectIds: [],
      selectedKfKeys: [],
      isPlaying: false,
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
        selectedKfKeys: [],
        undoStack: emptyStack(),
      });
      await get().loadPlugins();
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

  setPlaying: (v) => set({ isPlaying: v }),
  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),

  setFrame: (frame) => set({ currentFrame: frame }),
  // §20.3 アクティブ comp 切替時は frame を 0・選択をクリア
  setCurrentComp: (id) => set({ currentCompId: id, currentFrame: 0, selectedObjectIds: [] }),
  selectObjects: (ids) => set({ selectedObjectIds: ids }),

  setSelectedKfKeys: (keys) =>
    set((s) => ({
      selectedKfKeys: typeof keys === "function" ? keys(s.selectedKfKeys) : keys,
    })),

  setPreviewQuality: (mode) => set({ previewQuality: mode }),
  setPreviewQualityEditing: (editing) => set({ previewQualityEditing: editing }),

  decomposeGlyphs: (objectId) => {
    const before = get().project;
    if (!before) return;
    const comp = currentTimelineComp(before, get().currentCompId);
    if (!comp) return;
    const obj = comp.objects.find((o) => o.id === objectId);
    if (!obj) return;
    const textComp = obj.components.find((c) => c.type === "text");
    if (!textComp) return;
    const props = textComp.props;
    const font = typeof props["font"] === "string" ? props["font"] : "sans-serif";
    const weight = typeof props["weight"] === "number" ? props["weight"] : 400;
    const italic = props["italic"] === true;
    const sizeRaw = props["size"];
    const frame = get().currentFrame;
    const size = typeof sizeRaw === "object" && sizeRaw !== null && "value" in sizeRaw
      ? sampleScalar(sizeRaw as AnimatedProp<number>, frame)
      : 48;
    const measureCtx = createCanvasMeasureContext(font, size, weight, italic);
    const nextObjects = buildGlyphDecomposeObjects(obj, comp, frame, measureCtx);
    if (!nextObjects) return;
    const afterObjects = comp.objects
      .filter((o) => o.id !== objectId)
      .concat(nextObjects)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const after: Project = {
      ...before,
      compositions: before.compositions.map((c) =>
        c.id === comp.id && c.kind === "timeline" ? { ...c, objects: afterObjects } : c,
      ),
    };
    get().applyCommand({ label: "Decompose Glyphs", before, after });
  },

  // §20.2 コンポジション管理 ————————————————————————————————

  addTimelineComp: (name) => {
    const before = get().project;
    if (!before) return null;
    const id = newCompId();
    // 既存 timeline comp 数から連番名（Comp N）を付与
    const timelineCount = before.compositions.filter((c) => c.kind === "timeline").length;
    const comp: TimelineComposition = {
      id,
      name: name ?? `Comp ${timelineCount + 1}`,
      kind: "timeline",
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 150,
      background: { r: 0, g: 0, b: 0, a: 1 },
      objects: [],
    };
    const after: Project = {
      ...before,
      compositions: [...before.compositions, comp].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      ),
    };
    get().applyCommand({ label: "Add Composition", before, after });
    // 作成した comp をアクティブにする（エディタ状態, undo 対象外）
    set({ currentCompId: id, currentFrame: 0, selectedObjectIds: [] });
    return id;
  },

  removeComposition: (id) => {
    const before = get().project;
    if (!before) return;
    const target = before.compositions.find((c) => c.id === id);
    if (!target) return;
    // 最後の timeline comp は削除不可（§20.2）
    const timelineComps = before.compositions.filter((c) => c.kind === "timeline");
    if (target.kind === "timeline" && timelineComps.length <= 1) return;

    const remaining = before.compositions.filter((c) => c.id !== id);
    // rootComposition が消えるなら、残った timeline comp（id 昇順先頭）に張り替える
    let rootComposition = before.rootComposition;
    if (rootComposition === id) {
      const firstTimeline = remaining.find((c) => c.kind === "timeline");
      if (!firstTimeline) return; // ガード（上の不変条件で到達しないはず）
      rootComposition = firstTimeline.id;
    }
    const after: Project = { ...before, compositions: remaining, rootComposition };
    get().applyCommand({ label: "Remove Composition", before, after });

    // html comp の FS ファイルを掃除（best-effort, §20.2）
    if (target.kind === "html") {
      void (async () => {
        try {
          for (const f of await fs.list(compositionDir(id))) await fs.delete(f);
        } catch {
          // 掃除失敗は無視
        }
      })();
    }

    // currentCompId が消えたら rootComposition に移す
    if (get().currentCompId === id) {
      set({ currentCompId: rootComposition, currentFrame: 0, selectedObjectIds: [] });
    }
  },

  renameComposition: (id, name) => {
    const before = get().project;
    if (!before) return;
    const after: Project = {
      ...before,
      compositions: before.compositions.map((c) => (c.id === id ? { ...c, name } : c)),
    };
    get().applyCommand({ label: "Rename Composition", before, after });
  },

  addObject: (obj) => cmdAddObject(get(), obj),
  removeObject: (id) => cmdRemoveObject(get(), id),
  removeObjects: (ids) => {
    cmdRemoveObjects(get(), ids);
    set((s) => ({ selectedObjectIds: s.selectedObjectIds.filter((x) => !ids.includes(x)) }));
  },
  updateObject: (id, patch, label) => cmdUpdateObject(get(), id, patch, label),
  updateObjects: (patches, label) => cmdUpdateObjects(get(), patches, label),

  duplicateSelected: () => {
    const s = get();
    const comp = currentTimelineComp(s.project, s.currentCompId);
    if (!comp) return;
    const targets = comp.objects.filter((o) => s.selectedObjectIds.includes(o.id));
    const newIds = cmdDuplicateObjects(s, targets);
    if (newIds.length > 0) set({ selectedObjectIds: newIds });
  },

  splitSelected: () => {
    const s = get();
    const comp = currentTimelineComp(s.project, s.currentCompId);
    if (!comp) return;
    const targets = comp.objects.filter((o) => s.selectedObjectIds.includes(o.id));
    const newIds = cmdSplitObjects(s, targets, s.currentFrame);
    if (newIds.length > 0) set({ selectedObjectIds: newIds });
  },

  pasteObjects: (objects) => {
    const s = get();
    const comp = currentTimelineComp(s.project, s.currentCompId);
    if (!comp || objects.length === 0) return [];
    // cmdDuplicateObjects は新 ULID 付与 + append + 1 undo（zOrder は元 +0.5）。
    const newIds = cmdDuplicateObjects(s, objects);
    if (newIds.length > 0) set({ selectedObjectIds: newIds });
    return newIds;
  },

  addHtmlComp: async (name) => {
    const before = get().project;
    if (!before) return null;
    const id = newObjectId();
    const compDir = compositionDir(id);
    // §3 HTML comp ファイル構成: compositions/<compId>/index.html/style.css/script.js
    await fs.write(`${compDir}/index.html`, `<!DOCTYPE html>\n<html><head><link rel="stylesheet" href="style.css"></head><body></body></html>\n`);
    await fs.write(`${compDir}/style.css`, `/* HTML Composition: ${name ?? id} */\nbody { margin: 0; }\n`);
    // script.js: §7 CompositionModule default export
    const label = name ?? "HTML Comp";
    await fs.write(
      `${compDir}/script.js`,
      [
        `// Mafter Effect HTML Composition — §7 CompositionModule`,
        `export default {`,
        `  manifest: { id: "${id}", params: [] },`,
        `  mount(root) {`,
        `    root.innerHTML =`,
        `      '<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#1d2b4a;color:#fff;font-family:sans-serif">'`,
        `      + '<div style="font-size:48px;font-weight:700">${label}</div>'`,
        `      + '<div class="frame" style="font-size:24px;opacity:.7;margin-top:8px"></div>'`,
        `      + '</div>';`,
        `  },`,
        `  render(ctx) {`,
        `    const el = ctx.root.querySelector(".frame");`,
        `    if (el) el.textContent = "frame " + ctx.frame;`,
        `  },`,
        `};`,
        ``,
      ].join("\n"),
    );
    const htmlComp: HtmlComposition = {
      id,
      name: name ?? "HTML Comp",
      kind: "html",
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 150,
    };
    const after: Project = {
      ...before,
      compositions: [...before.compositions, htmlComp].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      ),
    };
    get().applyCommand({ label: "Add HTML Comp", before, after });
    return id;
  },

  addHtmlInstance: (compId) => {
    const p = get().project;
    const htmlComp = p?.compositions.find((c) => c.id === compId && c.kind === "html");
    if (!htmlComp) return null;
    const comp = currentTimelineComp(p, get().currentCompId);
    const duration = comp?.duration ?? 150;
    const id = newObjectId();
    const obj: SceneObject = {
      id,
      name: htmlComp.name,
      parent: null,
      zOrder: nextZOrder(comp ?? undefined),
      enabled: true,
      inPoint: 0,
      outPoint: duration,
      transform: defaultTransform(),
      opacity: staticProp(1),
      // §7 html component: compId 参照 + 内部時間用 inPoint（plain value, AnimatedProp ではない）
      components: [{ type: "html", props: { compId, inPoint: 0 } }],
    };
    cmdAddObject(get(), obj);
    return id;
  },

  addWiggleExpression: async (objectId) => {
    const before = get().project;
    const comp = currentTimelineComp(before, get().currentCompId);
    const obj = comp?.objects.find((o) => o.id === objectId);
    if (!before || !comp || !obj) return;
    // §9 expression ファイル: scripts/<objectId>/position.js（純関数 default export）
    const path = scriptPath(objectId, "position");
    await fs.write(
      path,
      `// Mafter Effect expression — wiggle position (§9)\nexport default (ctx) => ctx.wiggle(2, 60);\n`,
    );
    const nextObj: SceneObject = {
      ...obj,
      transform: {
        ...obj.transform,
        position: { ...obj.transform.position, expression: { path, enabled: true } },
      },
    };
    get().updateObject(objectId, { transform: nextObj.transform }, "Add wiggle expression");
  },

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
            text: staticProp("Text"),
            size: staticProp(48),
            color: staticProp({ r: 1, g: 1, b: 1, a: 1 }),
            tracking: staticProp(0),
            leading: staticProp(0),
            strokeColor: staticProp({ r: 0, g: 0, b: 0, a: 1 }),
            strokeWidth: staticProp(0),
            font: "sans-serif",
            align: "left",
            weight: 400,
            italic: false,
          },
        },
      ],
    };
    cmdAddObject(get(), obj);
    return id;
  },

  getFs: () => fs,

  importAudioAsset: async (file) => {
    const before = get().project;
    if (!before) return null;
    const id = newObjectId();
    const ext = file.name.split(".").pop() ?? "audio";
    const assetPath = `${DIR_ASSETS}/${id}.${ext}`;
    const buf = await file.arrayBuffer();
    await fs.write(assetPath, new Uint8Array(buf));
    const asset: AssetEntry = { id, path: assetPath, kind: "audio" };
    const after: Project = {
      ...before,
      assets: [...before.assets, asset].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    };
    get().applyCommand({ label: "Import Audio", before, after });
    return id;
  },

  addAudioLayer: (assetId, name) => {
    const p = get().project;
    const comp = p?.compositions.find((c) => c.id === get().currentCompId) as TimelineComposition | undefined;
    if (!p || !comp) return null;
    const asset = p.assets.find((a) => a.id === assetId);
    if (!asset) return null;
    const id = newObjectId();
    const obj: SceneObject = {
      id,
      name: name ?? asset.path.split("/").pop() ?? "Audio",
      parent: null,
      zOrder: nextZOrder(comp),
      enabled: true,
      inPoint: 0,
      outPoint: comp.duration,
      transform: defaultTransform(),
      opacity: staticProp(1),
      components: [{ type: "audio", props: { asset: assetId, gain: 1, trimStart: 0 } }],
    };
    cmdAddObject(get(), obj);
    return id;
  },

  // M4: plugin ロード —————————————————————————————————————————————

  loadPlugins: async () => {
    const p = get().project;
    if (!p) return;

    globalPluginRegistry.clear();
    pluginLoader.clear();
    registerBuiltinComponents();

    const activeRefs = p.pluginRefs.filter((r) => r.enabled);
    for (const ref of activeRefs) {
      try {
        const manifestText = await fs.readText(pluginManifestPath(ref.id));
        const manifest = JSON.parse(manifestText) as PluginManifest;
        if (manifest.apiVersion !== 1) continue;

        const entryPath = pluginEntryPath(ref.id, manifest.entry);
        const loaded = await pluginLoader.load(entryPath);
        if (typeof loaded !== "function") continue;

        globalPluginRegistry.activate(manifest, loaded as (ctx: PluginContext) => void, fs);
      } catch {
        // plugin のロード失敗はスキップ（エラーをバブルさせない）
      }
    }

    set((s) => ({ pluginsVersion: s.pluginsVersion + 1 }));
  },

  installSamplePlugin: async () => {
    const before = get().project;
    if (!before) return;

    const sampleId = "com.example.sample";
    const manifest: PluginManifest = {
      id: sampleId,
      name: "Sample Gradient Plugin",
      version: "1.0.0",
      apiVersion: 1,
      entry: "entry.js",
      capabilities: ["component"],
    };
    await fs.write(pluginManifestPath(sampleId), JSON.stringify(manifest, null, 2) + "\n");
    await fs.write(pluginEntryPath(sampleId, "entry.js"), SAMPLE_PLUGIN_JS);

    // pluginRefs に未登録なら追加
    const existing = before.pluginRefs.find((r) => r.id === sampleId);
    if (!existing) {
      const after: Project = {
        ...before,
        pluginRefs: [...before.pluginRefs, { id: sampleId, version: "1.0.0", enabled: true }]
          .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      };
      get().applyCommand({ label: "Install Sample Plugin", before, after });
    } else if (!existing.enabled) {
      get().togglePlugin(sampleId, true);
    }

    await get().loadPlugins();
  },

  togglePlugin: (id, enabled) => {
    const before = get().project;
    if (!before) return;
    const refs = before.pluginRefs.map((r) => r.id === id ? { ...r, enabled } : r);
    const after: Project = { ...before, pluginRefs: refs };
    get().applyCommand({ label: enabled ? "Enable Plugin" : "Disable Plugin", before, after });
    void get().loadPlugins();
  },

  addPluginObject: (componentType) => {
    const componentDef = globalPluginRegistry.getComponentDef(componentType);
    if (!componentDef) return null;
    const p = get().project;
    const comp = p?.compositions.find((c) => c.id === get().currentCompId) as TimelineComposition | undefined;
    if (!p || !comp) return null;

    const id = newObjectId();
    const props: Record<string, AnimatedProp<unknown> | unknown> = {};
    for (const param of componentDef.params) {
      props[param.key] = param.animatable
        ? { value: param.default, keyframes: [] }
        : param.default;
    }
    const obj: SceneObject = {
      id,
      name: componentDef.label,
      parent: null,
      zOrder: nextZOrder(comp),
      enabled: true,
      inPoint: 0,
      outPoint: comp.duration,
      transform: defaultTransform(),
      opacity: staticProp(1),
      components: [{ type: componentType, props }],
    };
    cmdAddObject(get(), obj);
    return id;
  },

  addCompLayer: (compId, name) => {
    const p = get().project;
    if (!p) return null;
    const srcComp = p.compositions.find((c) => c.id === compId && c.kind === "timeline") as TimelineComposition | undefined;
    if (!srcComp) return null;
    const currentComp = currentTimelineComp(p, get().currentCompId);
    if (!currentComp) return null;
    if (currentComp.id === compId) return null; // 自己参照は直接ブロック
    if (compWouldCreateCycle(p, currentComp.id, compId)) return null;

    const id = newObjectId();
    const obj: SceneObject = {
      id,
      name: name ?? srcComp.name,
      parent: null,
      zOrder: nextZOrder(currentComp),
      enabled: true,
      inPoint: 0,
      outPoint: currentComp.duration,
      transform: defaultTransform(),
      opacity: staticProp(1),
      components: [{ type: "comp", props: { compId, trimStart: 0 } }],
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
