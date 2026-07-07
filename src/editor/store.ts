import { create } from "zustand";
import { createProject } from "../core/createProject";
import { newBinId, newCompId, newObjectId } from "../core/ids";
import { loadProject, saveProject } from "../core/projectFs";
import {
  createBinInProject,
  deleteBinFromProject,
  moveTreeEntries,
  registerNewProjectItem,
  renameBinInProject,
  unregisterProjectItem,
} from "../core/projectTree";
import { defaultTransform, staticProp, vec3 } from "../core/props";
import type {
  AnimatedProp,
  AssetEntry,
  BlendMode,
  TrackMatteMode,
  Easing,
  EffectInstance,
  ExpressionPresetInstance,
  Frame,
  HtmlComposition,
  Keyframe,
  LabelIndex,
  Project,
  ProjectTreeEntry,
  Renderer3d,
  RGBA,
  SceneObject,
  ThreeDMode,
  TimelineComposition,
} from "../core/schema";
import { IndexedDbFs } from "../fs/IndexedDbFs";
import { compositionDir, DIR_ASSETS, pluginEntryPath, pluginManifestPath } from "../core/paths";
import { compLayerDefaultOutPoint, compWouldCreateCycle } from "../runtime/compLayer";
import { rescaleCompFps, resizeCompCentered } from "./compEdit";
import { isLayerLocked } from "./layerLock";
import { registerBuiltinComponents } from "../runtime/builtinComponents";
import { registerBuiltinEffects } from "../runtime/builtinEffects";
import { sampleScalar } from "../runtime/interpolate";
import { ModuleLoader } from "../runtime/moduleLoader";
import type { PluginContext, PluginManifest, EffectDef } from "../runtime/plugin";
import { globalPluginRegistry } from "../runtime/pluginRegistry";
import {
  probeImageFile,
  evictPreviewMediaAsset,
  isPackedAlphaVideoMeta,
  packedAlphaLayoutFromMeta,
} from "../runtime/imageAssetCache";
import { buildPackedVideoProxy } from "../runtime/packedVideoProxy";
import {
  convertSplitAssetToPacked,
  isConvertError,
  resolveConversionFps,
} from "./subjectExtract/convertSplitToPacked";
import { probeVideoFile } from "../runtime/videoAssetProbe";
import { detectAnimatedRaster, type AnimatedRasterInfo } from "../runtime/animatedRasterDetect";
import { buildAnimatedRasterProxy } from "../runtime/animatedRasterProxy";
import { buildNativeVideoProxy } from "../runtime/footageVideoProxy";
import {
  isProxyTier,
  normalizeFootageQuality,
  type FootageQuality,
  type ProxyTier,
} from "../runtime/footageQuality";
import { footageKindOf, getProxyEntry, resolveOriginalPath } from "../runtime/footagePlayback";
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
import { buildGlyphDecomposeObjects, createCanvasMeasureContext, type GlyphDecomposeMode } from "./glyphDecompose";
import { bakeMergeShapeToPath } from "./shapeBake";
import { loadWorkArea, saveWorkArea } from "./workAreaStorage";
import { WAVEFORM_MODES, type WaveformMode } from "../audio/waveform";
import { probeAudioMeta, evictAudioBuffer } from "./audioBufferCache";
import { evictVideoPrimed } from "../runtime/videoWarmupCache";
import { globalWaveformCache } from "../fs/WaveformCacheDb";
import { videoLayerOutPoint } from "./videoLayerOutPoint";
import {
  EXPRESSION_PRESETS,
  buildDefaultPresetProps,
  ensureAllPresetScripts,
  ensurePresetScript,
  presetScriptPath,
  type ExpressionPresetId,
} from "./expressionPresets";
import { bindExpressionFs } from "./expressionModuleHub";
import { feedbackCollector } from "./feedbackCollector";

const WAVEFORM_MODE_KEY = "mafter:waveformMode";
function loadWaveformMode(): WaveformMode {
  try {
    const v = localStorage.getItem(WAVEFORM_MODE_KEY);
    if (v && (WAVEFORM_MODES as readonly string[]).includes(v)) return v as WaveformMode;
  } catch { /* ignore */ }
  return "transient";
}

/** スクラブ/カラーピッカー中に Preview へだけ反映する一時 patch。 */
export interface PreviewOverride {
  objectId: string;
  patch: Partial<SceneObject>;
}

registerBuiltinComponents();
registerBuiltinEffects();

// §17: プロジェクトデータの正は FS（IndexedDbFs）。ストアはその投影。

const fs = new IndexedDbFs("mafter-effect-fs");
bindExpressionFs(fs);
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

  // §26.3.3 box text のギズモ編集モード（true=ボックスリサイズ / false=通常 scale）。グローバル・非直列化
  boxGizmoEnabled: boolean;
  setBoxGizmoEnabled: (enabled: boolean) => void;

  /** Inspector Scale スクラブ時に X/Y を比例維持するか。グローバル・非直列化 */
  scaleLinkEnabled: boolean;
  setScaleLinkEnabled: (enabled: boolean) => void;

  // §11.5.1 タイムライン波形表示モード（グローバル・非直列化）
  waveformMode: WaveformMode;
  setWaveformMode: (mode: WaveformMode) => void;
  decomposeGlyphs: (objectId: string, mode?: GlyphDecomposeMode) => void;
  // §5.5d/§5.5e shape kind="merge" の Bake（Illustrator Expand 相当）。戻り値は Inspector が
  // フォールバック時のメッセージを表示するためだけに使う（永続 state には積まない）。
  bakeShapeMerge: (objectId: string) => { fallbackReason?: string } | null;

  // Undo/Redo スタック（セッション内のみ, §17）
  undoStack: UndoRedoStack;
  /** project スナップショットが変わるたびに増える。Preview 等が確実に再描画するための tick。 */
  projectRevision: number;

  /** Inspector/Timeline スクラブ中のプレビュー専用 patch（undo 対象外）。 */
  previewOverride: PreviewOverride | null;
  setPreviewOverride: (override: PreviewOverride | null) => void;
  clearPreviewOverride: () => void;

  /** §28.8 ワークエリア変更 tick（localStorage 永続・project.json 非汚染）。 */
  workAreaRevision: number;
  setWorkArea: (inPoint: Frame, outPoint: Frame) => void;
  setWorkAreaIn: () => void;
  setWorkAreaOut: () => void;

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
  addTimelineComp: (
    name?: string,
    opts?: { width?: number; height?: number; fps?: number; duration?: number },
  ) => string | null;
  // §20.2c フッテージ（image/video）から寸法・尺を合わせた comp を作成し、レイヤーとして配置する
  addCompositionFromAsset: (assetId: string) => string | null;
  // §16.2 プランv2 §2.4 — Project パネル（アセット単位）からの packed 化。レイヤー差し替えは
  // 行わない（対象レイヤーが一意に決まらないため）。新規 packed アセットを追加するのみ。
  convertSplitAssetToPackedFromAssetMenu: (assetId: string) => Promise<void>;
  removeComposition: (id: string) => void;
  renameComposition: (id: string, name: string) => void;
  // §20.5 Project Bin
  createBin: (parentBinId?: string | null, name?: string) => string | null;
  renameBin: (id: string, name: string) => void;
  deleteBin: (id: string) => void;
  moveProjectEntries: (
    entries: ProjectTreeEntry[],
    targetBinId: string | null,
    index: number,
  ) => void;
  // §21.9 レイヤー名リネーム
  renameObject: (id: string, name: string) => void;
  // §21.10 ラベル色
  setLayerLabelIndex: (ids: string[], index: LabelIndex | undefined) => void;

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
  // §5.5 / §5.5c shape レイヤー追加（既定 kind: rect）
  addShape: (name?: string) => string | null;
  // fs アクセス（外部公開：ExportDialog など）
  getFs: () => IndexedDbFs;
  addText: (name?: string) => string | null;
  // M2: HTML comp 追加（FS にスターターファイルを書き込む）
  // M3 実装はインターフェース末尾（importAudioAsset / addAudioLayer）
  addHtmlComp: (name?: string) => Promise<string | null>;
  // M2: HTML comp を現タイムラインに html component オブジェクトとして配置する
  addHtmlInstance: (compId: string) => string | null;
  // §9 Phase 0.5: expression プリセット（Effect 同型 UI + param KF）
  addExpressionPreset: (
    objectId: string,
    presetId: ExpressionPresetId,
    propsOverrides?: Record<string, unknown>,
  ) => Promise<void>;
  removeExpressionPreset: (objectId: string, instanceId: string) => void;
  toggleExpressionPreset: (objectId: string, instanceId: string, enabled: boolean) => void;
  // M3: 音声アセットをインポートして project.assets に追加する
  importAudioAsset: (file: File) => Promise<string | null>;
  // M3: audio component を持つ SceneObject を追加する
  addAudioLayer: (assetId: string, name?: string) => string | null;
  // 画像アセットをインポートして project.assets に追加する
  importImageAsset: (file: File) => Promise<string | null>;
  // image component を持つ SceneObject を追加する
  addImageLayer: (assetId: string, name?: string) => string | null;
  // 動画アセットをインポートして project.assets に追加する
  importVideoAsset: (file: File) => Promise<string | null>;
  // §11.4b アニメ WebP/GIF を animated-raster video asset として import（原本 + medium プロキシ）
  importAnimatedRasterAsset: (file: File, info: AnimatedRasterInfo) => Promise<string | null>;
  // §11.4b 指定 tier のプロキシを（無ければ）生成して meta.proxies に登録する
  ensureProxyTier: (assetId: string, quality: FootageQuality) => Promise<boolean>;
  // §11.4b animated-raster の medium proxy が無い（zip 再 import 後など）ものを再生成する
  rehydrateAnimatedRasters: () => Promise<void>;
  // video component を持つ SceneObject を追加する
  addVideoLayer: (assetId: string, name?: string) => string | null;
  // §20.1 Footage 削除（audio/image/video。参照レイヤーもまとめて削除・undo 可）
  removeAsset: (assetId: string) => void;

  // M4: plugin ロード・管理
  loadPlugins: () => Promise<void>;
  installSamplePlugin: () => Promise<void>;
  togglePlugin: (id: string, enabled: boolean) => void;
  addPluginObject: (componentType: string) => string | null;

  // §23 comp layer: timeline comp をアクティブコンプにレイヤーとして配置する
  addCompLayer: (compId: string, name?: string) => string | null;

  // §27 エフェクト & 調整レイヤー
  addEffect: (objId: string, type: string) => string | null;
  removeEffect: (objId: string, effectId: string) => void;
  reorderEffect: (objId: string, effectId: string, dir: "up" | "down") => void;
  toggleEffect: (objId: string, effectId: string) => void;
  addAdjustmentLayer: (name?: string) => string | null;
  addLiveAdjustmentLayer: (name?: string) => string | null;
  addRasterAdjustmentLayer: (name?: string) => string | null;
  setAdjustmentMode: (objId: string, mode: "live" | "raster") => void;
  toggleAdjustment: (objId: string) => void;
  addNullLayer: (name?: string) => string | null;

  // §5.4b / §6.5 3D レイヤー & カメラ
  addCamera: (name?: string) => string | null;
  /** §6.5 プレビュー視点 override（非永続）。null = 自動（最前面の可視カメラ）。"default" = デフォルト視点。 */
  previewCamera: string | "default" | null;
  setPreviewCamera: (cam: string | "default" | null) => void;
  setThreeD: (objId: string, enabled: boolean) => void;
  setThreeDMode: (objId: string, mode: ThreeDMode) => void;
  setCompRenderer3d: (mode: Renderer3d) => void;
  /** §5.6 コンポ背景色。null = 透明（未設定）。 */
  setCompBackground: (bg: RGBA | null) => void;
  /** §5.6 コンポサイズ変更（中央基準でレイヤーをオフセット）。 */
  resizeComp: (width: number, height: number) => void;
  /** §5.6 コンポ fps 変更（秒タイミング維持で KF/duration を再スケール）。 */
  setCompFps: (fps: number) => void;
  /** §5.6 コンポ duration 変更（再生ヘッド超過時はクランプ）。 */
  setCompDuration: (duration: number) => void;
  /** §21.1b 編集補助 BPM 設定（0 で無効化・beatsPerBar も undefined 化）。表示専用。 */
  setCompBpm: (bpm: number) => void;
  /** §21.1b 1 小節の拍数設定（bpm 無効時は no-op）。 */
  setCompBeatsPerBar: (n: number) => void;

  // §5.4d 描画モード
  setBlendMode: (objId: string, mode: BlendMode) => void;
  setTrackMatteMode: (objId: string, mode: TrackMatteMode | null) => void;

  /** §5.4d エディタ専用: 未知 blendMode の raw 名（load 時 validate が記録）。非直列化。 */
  missingBlendModes: Record<string, string>;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  project: null,
  currentCompId: "",
  currentFrame: 0,
  previewCamera: null,
  selectedObjectIds: [],
  selectedKfKeys: [],
  isPlaying: false,
  previewQuality: "draft",
  previewQualityEditing: false,
  boxGizmoEnabled: true,
  scaleLinkEnabled: true,
  waveformMode: loadWaveformMode(),
  pluginsVersion: 0,
  undoStack: emptyStack(),
  projectRevision: 0,
  previewOverride: null,
  workAreaRevision: 0,
  missingBlendModes: {},

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
      projectRevision: 0,
      previewOverride: null,
      missingBlendModes: {},
    });
    // メモリだけ切り替えて FS が旧プロジェクトのまま残ると zip が古い内容を書き出す（§20.4b 回帰）。
    void (async () => {
      try {
        for (const path of await fs.list("")) {
          await fs.delete(path);
        }
        await saveProject(fs, p);
      } catch {
        /* best-effort */
      }
    })();
  },

  loadFromFs: async () => {
    try {
      const { project: p, missingBlendModes } = await loadProject(fs);
      set({
        project: p,
        currentCompId: p.rootComposition,
        currentFrame: 0,
        selectedObjectIds: [],
        selectedKfKeys: [],
        undoStack: emptyStack(),
        projectRevision: get().projectRevision + 1,
        previewOverride: null,
        missingBlendModes,
      });
      await get().loadPlugins();
      await ensureAllPresetScripts(fs);
      // §11.4b zip re-import 後など、animated-raster の medium proxy が無ければ再生成。
      void get().rehydrateAnimatedRasters();
    } catch {
      // FS に project.json が無い場合など: 新規作成
      get().newProject();
    }
  },

  // §11.4b animated-raster で path が原本 raster（webp/gif）のまま＝proxy 未生成のものを
  // medium proxy へ再 hydrate する（zip 再 import 後・原本のみ復元された状態の復旧）。
  rehydrateAnimatedRasters: async () => {
    const p = get().project;
    if (!p) return;
    for (const asset of p.assets) {
      if (asset.kind !== "video") continue;
      if (footageKindOf(asset) !== "animated-raster") continue;
      const lower = asset.path.toLowerCase();
      const needsRebuild = lower.endsWith(".webp") || lower.endsWith(".gif");
      if (!needsRebuild) continue;
      try {
        const bytes = await fs.read(asset.path);
        const mime = lower.endsWith(".gif") ? "image/gif" : "image/webp";
        const part = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const file = new File([part], asset.path.split("/").pop() ?? "src", { type: mime });
        const info = await detectAnimatedRaster(file);
        if (!info) continue;
        const proxy = await buildAnimatedRasterProxy(file, info, "medium");
        const proxyPath = `${DIR_ASSETS}/${asset.id}.medium.webm`;
        await fs.write(proxyPath, proxy.bytes);
        const cur = get().project;
        if (!cur) return;
        const next = {
          ...cur,
          assets: cur.assets.map((a) => a.id !== asset.id ? a : {
            ...a,
            path: proxyPath,
            meta: {
              ...(a.meta ?? {}),
              originalPath: asset.path,
              proxies: { medium: { path: proxyPath, mime: proxy.mime, width: proxy.width, height: proxy.height } },
            },
          }),
        };
        set((s) => ({ project: next, projectRevision: s.projectRevision + 1 }));
        void saveProject(fs, next);
      } catch {
        /* 再生成失敗は best-effort（次回参照で再試行） */
      }
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
      projectRevision: s.projectRevision + 1,
      previewOverride: null,
    }));
    // バックグラウンドで自動保存
    void saveProject(fs, cmd.after);
  },

  undo: () => {
    const result = undo(get().undoStack);
    if (!result) return;
    set((s) => ({
      project: result.project,
      undoStack: result.stack,
      projectRevision: s.projectRevision + 1,
      previewOverride: null,
    }));
    void saveProject(fs, result.project);
    // フィードバックループ G9: undo バースト検知は undo() のみをフックする（applyCommand は対象外）。
    feedbackCollector.onUndo();
  },

  redo: () => {
    const result = redo(get().undoStack);
    if (!result) return;
    set((s) => ({
      project: result.project,
      undoStack: result.stack,
      projectRevision: s.projectRevision + 1,
      previewOverride: null,
    }));
    void saveProject(fs, result.project);
    feedbackCollector.onRedo();
  },

  setPlaying: (v) => set({ isPlaying: v }),
  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),

  setFrame: (frame) => set({ currentFrame: frame }),
  // §20.3 アクティブ comp 切替時は frame を 0・選択をクリア
  setCurrentComp: (id) =>
    set({ currentCompId: id, currentFrame: 0, selectedObjectIds: [], previewCamera: null }),
  selectObjects: (ids) => set({ selectedObjectIds: ids }),

  setSelectedKfKeys: (keys) =>
    set((s) => ({
      selectedKfKeys: typeof keys === "function" ? keys(s.selectedKfKeys) : keys,
    })),

  setPreviewQuality: (mode) => set({ previewQuality: mode }),
  setPreviewQualityEditing: (editing) => set({ previewQualityEditing: editing }),
  setBoxGizmoEnabled: (enabled) => set({ boxGizmoEnabled: enabled }),
  setScaleLinkEnabled: (enabled) => set({ scaleLinkEnabled: enabled }),

  setWaveformMode: (mode) => {
    try { localStorage.setItem(WAVEFORM_MODE_KEY, mode); } catch { /* ignore */ }
    set({ waveformMode: mode });
  },

  setPreviewOverride: (override) => set({ previewOverride: override }),
  clearPreviewOverride: () => set({ previewOverride: null }),

  setWorkArea: (inPoint, outPoint) => {
    const comp = currentTimelineComp(get().project, get().currentCompId);
    if (!comp) return;
    const duration = comp.duration;
    const inClamped = Math.max(0, Math.min(duration - 1, inPoint));
    const outClamped = Math.max(inClamped + 1, Math.min(duration, outPoint));
    saveWorkArea(comp.id, { inPoint: inClamped, outPoint: outClamped });
    set({ workAreaRevision: get().workAreaRevision + 1 });
  },

  setWorkAreaIn: () => {
    const comp = currentTimelineComp(get().project, get().currentCompId);
    if (!comp) return;
    const area = loadWorkArea(comp.id, comp.duration);
    get().setWorkArea(get().currentFrame, area.outPoint);
  },

  setWorkAreaOut: () => {
    const comp = currentTimelineComp(get().project, get().currentCompId);
    if (!comp) return;
    const area = loadWorkArea(comp.id, comp.duration);
    get().setWorkArea(area.inPoint, get().currentFrame + 1);
  },

  decomposeGlyphs: (objectId, mode = "keyframesOnNull") => {
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
    const nextObjects = buildGlyphDecomposeObjects(obj, comp, frame, measureCtx, mode);
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
    const label = mode === "keyframesOnChild"
      ? "Decompose Glyphs (child)"
      : "Decompose Glyphs (null)";
    get().applyCommand({ label, before, after });
  },

  bakeShapeMerge: (objectId) => {
    const before = get().project;
    if (!before) return null;
    const comp = currentTimelineComp(before, get().currentCompId);
    if (!comp) return null;
    const obj = comp.objects.find((o) => o.id === objectId);
    const shapeComp = obj?.components.find((c) => c.type === "shape");
    if (!obj || !shapeComp || shapeComp.props["kind"] !== "merge") return null;

    const frame = get().currentFrame;
    const result = bakeMergeShapeToPath(comp, objectId, obj.inPoint, obj.outPoint, frame);
    const { mergeInputs: _mi, vertices: _v, ...restProps } = shapeComp.props;
    const nextProps = { ...restProps, kind: "path", rings: result.rings };
    const nextComponents = obj.components.map((c) => (c.type === "shape" ? { ...c, props: nextProps } : c));
    const after: Project = {
      ...before,
      compositions: before.compositions.map((c) =>
        c.id === comp.id && c.kind === "timeline" ? { ...c, objects: c.objects.map((o) => (o.id === objectId ? { ...o, components: nextComponents } : o)) } : c,
      ),
    };
    const label = result.bakedFrameRange ? "Bake Merge Shape (keyframed)" : "Bake Merge Shape (static)";
    get().applyCommand({ label, before, after });
    return result.fallbackReason ? { fallbackReason: result.fallbackReason } : {};
  },

  // §20.2 コンポジション管理 ————————————————————————————————

  addTimelineComp: (name, opts) => {
    const before = get().project;
    if (!before) return null;
    const id = newCompId();
    // 既存 timeline comp 数から連番名（Comp N）を付与
    const timelineCount = before.compositions.filter((c) => c.kind === "timeline").length;
    const comp: TimelineComposition = {
      id,
      name: name ?? `Comp ${timelineCount + 1}`,
      kind: "timeline",
      width: opts?.width ?? 1920,
      height: opts?.height ?? 1080,
      fps: opts?.fps ?? 30,
      duration: opts?.duration ?? 150,
      // 背景は未設定 = 透明（§5.6）。色が要るなら setCompBackground で設定。
      objects: [],
    };
    const after = registerNewProjectItem(
      {
        ...before,
        compositions: [...before.compositions, comp].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        ),
      },
      { kind: "composition", id },
    );
    get().applyCommand({ label: "Add Composition", before, after });
    // 作成した comp をアクティブにする（エディタ状態, undo 対象外）
    set({ currentCompId: id, currentFrame: 0, selectedObjectIds: [], previewCamera: null });
    return id;
  },

  addCompositionFromAsset: (assetId) => {
    const project = get().project;
    if (!project) return null;
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset || (asset.kind !== "image" && asset.kind !== "video")) return null;

    const fps = 30;
    const meta = asset.meta ?? {};
    const metaWidth = meta["width"];
    const metaHeight = meta["height"];
    const width = typeof metaWidth === "number" && metaWidth > 0 ? Math.round(metaWidth) : 1920;
    const height = typeof metaHeight === "number" && metaHeight > 0 ? Math.round(metaHeight) : 1080;
    const metaDuration = meta["duration"];
    const duration = asset.kind === "video" && typeof metaDuration === "number" && metaDuration > 0
      ? Math.max(1, Math.round(metaDuration * fps))
      : 150;
    const baseName = asset.path.split("/").pop() ?? "";
    const dot = baseName.lastIndexOf(".");
    const name = (dot > 0 ? baseName.slice(0, dot) : baseName) || undefined;

    const compId = get().addTimelineComp(name, { width, height, fps, duration });
    if (!compId) return null;
    const objId = asset.kind === "image" ? get().addImageLayer(assetId) : get().addVideoLayer(assetId);
    if (objId) get().selectObjects([objId]);
    return compId;
  },

  convertSplitAssetToPackedFromAssetMenu: async (assetId) => {
    const project = get().project;
    if (!project) return;
    const fps = resolveConversionFps(project, assetId);
    if (fps === null) {
      window.alert(
        "この素材を参照しているレイヤーが見つからないか、参照している comp 間で fps が一致しないため packed 化できません（fps の当て推量はしません）。Inspector（レイヤーを選択した状態）から変換してください。",
      );
      return;
    }
    // decode/encode 経路は abort・decode 失敗・エンコーダエラー等で例外を投げうる
    // （isConvertError で拾えるのは事前バリデーションの分だけ）。ここで確実に拾って
    // ユーザーに見せないと、失敗が無言の unhandled rejection になる。
    let result: Awaited<ReturnType<typeof convertSplitAssetToPacked>>;
    try {
      result = await convertSplitAssetToPacked(project, get().getFs(), assetId, fps);
    } catch (e) {
      window.alert(`packed 化に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (isConvertError(result)) {
      window.alert(`packed 化に失敗しました: ${result.error}`);
      return;
    }
    const before = get().project;
    if (!before) return;
    const after: Project = { ...before, assets: [...before.assets, result.asset] };
    get().applyCommand({ label: "packed 化（split → packed、アセット追加のみ）", before, after });
    window.alert(
      "packed 化が完了しました。Project パネルに新しいアセットが追加されました（元の split アセットはそのまま残っています）。レイヤーに使うには Inspector の Source から切り替えてください。",
    );
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
    const after = unregisterProjectItem(
      { ...before, compositions: remaining, rootComposition },
      { kind: "composition", id },
    );
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
      set({ currentCompId: rootComposition, currentFrame: 0, selectedObjectIds: [], previewCamera: null });
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

  createBin: (parentBinId = null, name) => {
    const before = get().project;
    if (!before) return null;
    const id = newBinId();
    const count = (before.bins ?? []).length;
    const after = createBinInProject(before, id, name ?? `Folder ${count + 1}`, parentBinId ?? null);
    get().applyCommand({ label: "New Folder", before, after });
    return id;
  },

  renameBin: (id, name) => {
    const before = get().project;
    if (!before) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const after = renameBinInProject(before, id, trimmed);
    get().applyCommand({ label: "Rename Folder", before, after });
  },

  deleteBin: (id) => {
    const before = get().project;
    if (!before) return;
    if (!(before.bins ?? []).some((b) => b.id === id)) return;
    const after = deleteBinFromProject(before, id);
    get().applyCommand({ label: "Delete Folder", before, after });
  },

  moveProjectEntries: (entries, targetBinId, index) => {
    if (entries.length === 0) return;
    const before = get().project;
    if (!before) return;
    const after = moveTreeEntries(before, entries, targetBinId, index);
    get().applyCommand({ label: "Move Project Item", before, after });
  },

  renameObject: (id, name) => {
    const before = get().project;
    if (!before) return;
    const compId = get().currentCompId;
    const comp = before.compositions.find(
      (c) => c.id === compId && c.kind === "timeline",
    );
    const obj = comp?.kind === "timeline"
      ? comp.objects.find((o) => o.id === id)
      : undefined;
    if (obj && isLayerLocked(obj)) return;
    const after: Project = {
      ...before,
      compositions: before.compositions.map((c) => {
        if (c.kind !== "timeline" || c.id !== compId) return c;
        return {
          ...c,
          objects: c.objects.map((o) => (o.id === id ? { ...o, name } : o)),
        };
      }),
    };
    get().applyCommand({ label: "Rename layer", before, after });
  },

  setLayerLabelIndex: (ids, index) => {
    if (ids.length === 0) return;
    const patch: Partial<SceneObject> = { labelIndex: index };
    get().updateObjects(
      ids.map((id) => ({ id, patch })),
      index === undefined ? "Clear layer label" : "Set layer label",
    );
  },

  addObject: (obj) => cmdAddObject(get(), obj),
  removeObject: (id) => {
    cmdRemoveObject(get(), id);
    set((s) => {
      if (!(id in s.missingBlendModes)) return s;
      const { [id]: _removed, ...missingBlendModes } = s.missingBlendModes;
      return { missingBlendModes };
    });
  },
  removeObjects: (ids) => {
    cmdRemoveObjects(get(), ids);
    set((s) => {
      const idSet = new Set(ids);
      const missingBlendModes = Object.fromEntries(
        Object.entries(s.missingBlendModes).filter(([k]) => !idSet.has(k)),
      );
      return {
        selectedObjectIds: s.selectedObjectIds.filter((x) => !ids.includes(x)),
        missingBlendModes,
      };
    });
  },
  updateObject: (id, patch, label) => {
    cmdUpdateObject(get(), id, patch, label);
    // フィードバックループ G7: param 確定の全経路が通る 1 箇所（updateObject）で rapid_inspector_tweak を検知。
    if (label) feedbackCollector.onInspectorTweak(`${id}:${label}`);
  },
  updateObjects: (patches, label) => cmdUpdateObjects(get(), patches, label),

  duplicateSelected: () => {
    const s = get();
    const comp = currentTimelineComp(s.project, s.currentCompId);
    if (!comp) return;
    const targets = comp.objects.filter((o) => s.selectedObjectIds.includes(o.id));
    const newIds = cmdDuplicateObjects(s, targets);
    if (newIds.length > 0) {
      const missingBlendModes = { ...s.missingBlendModes };
      // cmdDuplicateObjects は入力順を保持し newIds[i] が targets[i] の複製（順序 1:1 前提）。
      targets.forEach((src, i) => {
        const raw = s.missingBlendModes[src.id];
        const newId = newIds[i];
        if (raw !== undefined && newId !== undefined) missingBlendModes[newId] = raw;
      });
      set({ selectedObjectIds: newIds, missingBlendModes });
    }
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
    if (newIds.length > 0) {
      const missingBlendModes = { ...s.missingBlendModes };
      objects.forEach((src, i) => {
        const raw = s.missingBlendModes[src.id];
        const newId = newIds[i];
        if (raw !== undefined && newId !== undefined) missingBlendModes[newId] = raw;
      });
      set({ selectedObjectIds: newIds, missingBlendModes });
    }
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
    const after = registerNewProjectItem(
      {
        ...before,
        compositions: [...before.compositions, htmlComp].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        ),
      },
      { kind: "composition", id },
    );
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

  addExpressionPreset: async (objectId, presetId, propsOverrides) => {
    const before = get().project;
    const comp = currentTimelineComp(before, get().currentCompId);
    const obj = comp?.objects.find((o) => o.id === objectId);
    const preset = EXPRESSION_PRESETS[presetId];
    if (!before || !comp || !obj || !preset) return;

    await ensurePresetScript(fs, presetId);

    const filtered = (obj.expressionPresets ?? []).filter((p) => {
      const def = EXPRESSION_PRESETS[p.presetId as ExpressionPresetId];
      return def?.param !== preset.param;
    });

    const instance: ExpressionPresetInstance = {
      id: newObjectId(),
      presetId,
      enabled: true,
      props: { ...buildDefaultPresetProps(presetId), ...propsOverrides },
    };

    const path = presetScriptPath(presetId);
    const exprRef = { path, enabled: true as const };
    const expressionPresets = [...filtered, instance];

    if (preset.param === "position") {
      get().updateObject(
        objectId,
        {
          expressionPresets,
          transform: {
            ...obj.transform,
            position: { ...obj.transform.position, expression: exprRef },
          },
        },
        `Add ${preset.label}`,
      );
    } else {
      get().updateObject(
        objectId,
        {
          expressionPresets,
          transform: {
            ...obj.transform,
            scale: { ...obj.transform.scale, expression: exprRef },
          },
        },
        `Add ${preset.label}`,
      );
    }
  },

  removeExpressionPreset: (objectId, instanceId) => {
    const before = get().project;
    const comp = currentTimelineComp(before, get().currentCompId);
    const obj = comp?.objects.find((o) => o.id === objectId);
    if (!before || !comp || !obj) return;

    const inst = obj.expressionPresets?.find((p) => p.id === instanceId);
    if (!inst) return;
    const preset = EXPRESSION_PRESETS[inst.presetId as ExpressionPresetId];
    if (!preset) return;

    const expressionPresets = (obj.expressionPresets ?? []).filter((p) => p.id !== instanceId);
    const patch: Partial<SceneObject> = {
      expressionPresets: expressionPresets.length > 0 ? expressionPresets : undefined,
    };

    if (preset.param === "position") {
      const { expression: _ex, ...posRest } = obj.transform.position;
      patch.transform = { ...obj.transform, position: posRest };
    } else {
      const { expression: _ex, ...scaleRest } = obj.transform.scale;
      patch.transform = { ...obj.transform, scale: scaleRest };
    }

    get().updateObject(objectId, patch, `Remove ${preset.label}`);
  },

  toggleExpressionPreset: (objectId, instanceId, enabled) => {
    const before = get().project;
    const comp = currentTimelineComp(before, get().currentCompId);
    const obj = comp?.objects.find((o) => o.id === objectId);
    if (!before || !comp || !obj) return;

    const inst = obj.expressionPresets?.find((p) => p.id === instanceId);
    if (!inst) return;
    const preset = EXPRESSION_PRESETS[inst.presetId as ExpressionPresetId];
    if (!preset) return;

    const expressionPresets = (obj.expressionPresets ?? []).map((p) =>
      p.id === instanceId ? { ...p, enabled } : p,
    );

    const path =
      (preset.param === "position"
        ? obj.transform.position.expression?.path
        : obj.transform.scale.expression?.path) ?? presetScriptPath(inst.presetId as ExpressionPresetId);

    const exprRef = { path, enabled: enabled as boolean };

    if (preset.param === "position") {
      get().updateObject(
        objectId,
        {
          expressionPresets,
          transform: {
            ...obj.transform,
            position: { ...obj.transform.position, expression: exprRef },
          },
        },
        enabled ? `Enable ${preset.label}` : `Disable ${preset.label}`,
      );
    } else {
      get().updateObject(
        objectId,
        {
          expressionPresets,
          transform: {
            ...obj.transform,
            scale: { ...obj.transform.scale, expression: exprRef },
          },
        },
        enabled ? `Enable ${preset.label}` : `Disable ${preset.label}`,
      );
    }
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

  addShape: (name) => {
    const id = newObjectId();
    const p = get().project;
    const comp = p?.compositions.find((c) => c.id === get().currentCompId) as TimelineComposition | undefined;
    const duration = comp?.duration ?? 150;
    const obj: SceneObject = {
      id,
      name: name ?? "Shape",
      parent: null,
      zOrder: nextZOrder(comp),
      enabled: true,
      inPoint: 0,
      outPoint: duration,
      transform: defaultTransform(),
      opacity: staticProp(1),
      components: [
        {
          type: "shape",
          props: {
            kind: "rect",
            fill: { value: { r: 0.5, g: 0.7, b: 0.9, a: 1 }, keyframes: [] },
            radiusTL: staticProp(0),
            radiusTR: staticProp(0),
            radiusBR: staticProp(0),
            radiusBL: staticProp(0),
            size: staticProp(vec3(200, 200, 0)),
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
            boxWidth: staticProp(0),
            boxHeight: staticProp(0),
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
    const bytes = new Uint8Array(buf);
    await fs.write(assetPath, bytes);
    // §11.5: import 時に 1 回だけ decode して尺(秒)を meta に焼く（波形マッピング用）+ プリロード。
    let meta: Record<string, unknown> = {};
    try {
      const probe = await probeAudioMeta(id, async () => bytes);
      if (probe) meta = { duration: probe.duration, sampleRate: probe.sampleRate, channels: probe.channels };
    } catch {
      /* meta optional — 失敗時は尺フォールバック */
    }
    const asset: AssetEntry = { id, path: assetPath, kind: "audio", meta };
    const after = registerNewProjectItem(
      {
        ...before,
        assets: [...before.assets, asset].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      },
      { kind: "asset", id },
    );
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
      components: [{ type: "audio", props: { asset: assetId, gain: staticProp(1), trimStart: 0 } }],
    };
    cmdAddObject(get(), obj);
    return id;
  },

  importImageAsset: async (file) => {
    const before = get().project;
    if (!before) return null;
    // §11.4b アニメ WebP/GIF は video footage（animated-raster）として import しプロキシ生成。
    try {
      const rasterInfo = await detectAnimatedRaster(file);
      if (rasterInfo) {
        return await get().importAnimatedRasterAsset(file, rasterInfo);
      }
    } catch {
      /* 検出失敗時は静止画として通常 import */
    }
    const id = newObjectId();
    const ext = file.name.split(".").pop() ?? "png";
    const assetPath = `${DIR_ASSETS}/${id}.${ext}`;
    const buf = await file.arrayBuffer();
    await fs.write(assetPath, new Uint8Array(buf));
    let meta: Record<string, unknown> = {};
    try {
      const probe = await probeImageFile(file);
      meta = { width: probe.width, height: probe.height, mime: probe.mime };
    } catch {
      /* meta optional */
    }
    const asset: AssetEntry = { id, path: assetPath, kind: "image", meta };
    const after = registerNewProjectItem(
      {
        ...before,
        assets: [...before.assets, asset].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      },
      { kind: "asset", id },
    );
    get().applyCommand({ label: "Import Image", before, after });
    return id;
  },

  addImageLayer: (assetId, name) => {
    const p = get().project;
    const comp = p?.compositions.find((c) => c.id === get().currentCompId) as TimelineComposition | undefined;
    if (!p || !comp) return null;
    const asset = p.assets.find((a) => a.id === assetId);
    if (!asset || asset.kind !== "image") return null;
    const id = newObjectId();
    const obj: SceneObject = {
      id,
      name: name ?? asset.path.split("/").pop() ?? "Image",
      parent: null,
      zOrder: nextZOrder(comp),
      enabled: true,
      inPoint: 0,
      outPoint: comp.duration,
      transform: defaultTransform(),
      opacity: staticProp(1),
      components: [{ type: "image", props: { asset: assetId, fit: "contain" } }],
    };
    cmdAddObject(get(), obj);
    return id;
  },

  importVideoAsset: async (file) => {
    const before = get().project;
    if (!before) return null;
    const id = newObjectId();
    const ext = file.name.split(".").pop() ?? "mp4";
    const assetPath = `${DIR_ASSETS}/${id}.${ext}`;
    const buf = await file.arrayBuffer();
    await fs.write(assetPath, new Uint8Array(buf));
    let meta: Record<string, unknown> = { footageKind: "native" };
    try {
      const probe = await probeVideoFile(file);
      meta = {
        footageKind: "native",
        width: probe.width,
        height: probe.height,
        duration: probe.duration,
        mime: probe.mime,
      };
    } catch {
      /* meta optional */
    }
    const asset: AssetEntry = { id, path: assetPath, kind: "video", meta };
    const after = registerNewProjectItem(
      {
        ...before,
        assets: [...before.assets, asset].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      },
      { kind: "asset", id },
    );
    get().applyCommand({ label: "Import Video", before, after });
    return id;
  },

  // §11.4b アニメ WebP/GIF を animated-raster video asset として import（原本保持 + medium プロキシ生成）。
  importAnimatedRasterAsset: async (file, info) => {
    const before = get().project;
    if (!before) return null;
    const id = newObjectId();
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "webp";
    const originalPath = `${DIR_ASSETS}/${id}.${ext}`;
    const buf = await file.arrayBuffer();
    await fs.write(originalPath, new Uint8Array(buf));

    // medium プロキシを生成（失敗時は原本を path にして後で lazy 再生成）。
    let path = originalPath;
    const proxies: Record<string, unknown> = {};
    let proxyW = info.width;
    let proxyH = info.height;
    try {
      const proxy = await buildAnimatedRasterProxy(file, info, "medium");
      const proxyPath = `${DIR_ASSETS}/${id}.medium.webm`;
      await fs.write(proxyPath, proxy.bytes);
      proxies["medium"] = { path: proxyPath, mime: proxy.mime, width: proxy.width, height: proxy.height };
      path = proxyPath;
      proxyW = proxy.width;
      proxyH = proxy.height;
    } catch {
      /* プロキシ生成失敗 → 原本を path に（DomRenderer は webp/gif を <video> 不可だが lazy 再生成で復帰） */
    }

    const meta: Record<string, unknown> = {
      footageKind: "animated-raster",
      originalPath,
      width: info.width,
      height: info.height,
      duration: info.durationSec,
      mime: "video/webm",
      proxies,
    };
    void proxyW; void proxyH;
    const asset: AssetEntry = { id, path, kind: "video", meta };
    const after = registerNewProjectItem(
      {
        ...before,
        assets: [...before.assets, asset].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      },
      { kind: "asset", id },
    );
    get().applyCommand({ label: "Import Animated Raster", before, after });
    return id;
  },

  // §11.4b 指定 tier のプロキシを（無ければ）生成して meta.proxies に登録。生成済みなら即 true。
  ensureProxyTier: async (assetId, quality) => {
    const tier = normalizeFootageQuality(quality);
    if (!isProxyTier(tier)) return true;
    const p0 = get().project;
    const asset0 = p0?.assets.find((a) => a.id === assetId);
    if (!p0 || !asset0 || asset0.kind !== "video") return false;
    if (getProxyEntry(asset0, tier)) return true;

    // 原本を FS から読み出して File を再構成。
    const originalPath = resolveOriginalPath(asset0);
    let bytes: Uint8Array;
    try {
      bytes = await fs.read(originalPath);
    } catch {
      feedbackCollector.onProxyFailed();
      return false;
    }
    const origMime = typeof asset0.meta?.["mime"] === "string" ? (asset0.meta["mime"] as string) : "";
    const kind = footageKindOf(asset0);
    const fileMime = kind === "animated-raster"
      ? (originalPath.toLowerCase().endsWith(".gif") ? "image/gif" : "image/webp")
      : (origMime || "video/mp4");
    const blobPart = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const file = new File([blobPart], originalPath.split("/").pop() ?? "src", { type: fileMime });

    let proxyBytes: Uint8Array;
    let proxyMime = "video/webm";
    let pw = 0;
    let ph = 0;
    // §16.2b packed alpha proxy — レイアウト（contentHeight/gutterPx）を保った縮小版。
    // 通常 native proxy（buildNativeVideoProxy）に通すと packed の上下パック構造が単純にリサイズ
    // されるだけで color/mask 帯の比率が崩れ、合成時に mask 帯からズレたピクセルを拾ってしまう
    // ため、packed 資産は必ずこちらの専用分岐を通す（isPackedAlphaVideoMeta を kind 判定より先に見る
    // — footageKindOf は alphaMode を見ないため packed も "native" と分類される）。
    let packedProxyLayout: { contentHeight: number; gutterPx: number } | undefined;
    try {
      if (isPackedAlphaVideoMeta(asset0.meta)) {
        const srcLayout = packedAlphaLayoutFromMeta(asset0.meta);
        if (!srcLayout) { feedbackCollector.onProxyFailed(); return false; }
        const proxy = await buildPackedVideoProxy(file, tier as ProxyTier, srcLayout);
        proxyBytes = proxy.bytes; proxyMime = proxy.mime; pw = proxy.width; ph = proxy.height;
        packedProxyLayout = { contentHeight: proxy.contentHeight, gutterPx: proxy.gutterPx };
      } else if (kind === "animated-raster") {
        const info = await detectAnimatedRaster(file);
        if (!info) { feedbackCollector.onProxyFailed(); return false; }
        const proxy = await buildAnimatedRasterProxy(file, info, tier as ProxyTier);
        proxyBytes = proxy.bytes; proxyMime = proxy.mime; pw = proxy.width; ph = proxy.height;
      } else {
        const proxy = await buildNativeVideoProxy(file, tier as ProxyTier);
        proxyBytes = proxy.bytes; proxyMime = proxy.mime; pw = proxy.width; ph = proxy.height;
      }
    } catch {
      feedbackCollector.onProxyFailed();
      return false;
    }

    const proxyPath = `${DIR_ASSETS}/${assetId}.${tier}.webm`;
    try {
      await fs.write(proxyPath, proxyBytes);
    } catch {
      feedbackCollector.onProxyFailed();
      return false;
    }

    // meta.proxies を更新（生成キャッシュなので undo スタックには積まない）。
    const cur = get().project;
    if (!cur) return false;
    const next = {
      ...cur,
      assets: cur.assets.map((a) => {
        if (a.id !== assetId) return a;
        const existing = (a.meta?.proxies && typeof a.meta.proxies === "object")
          ? (a.meta.proxies as Record<string, unknown>)
          : {};
        return {
          ...a,
          meta: {
            ...(a.meta ?? {}),
            proxies: {
              ...existing,
              [tier]: {
                path: proxyPath,
                mime: proxyMime,
                width: pw,
                height: ph,
                // §16.2b — packed proxy のみ縮小後 layout を併記（getPackedAlphaLayoutForQuality が読む）。
                ...(packedProxyLayout
                  ? { contentHeight: packedProxyLayout.contentHeight, gutterPx: packedProxyLayout.gutterPx }
                  : {}),
              },
            },
          },
        };
      }),
    };
    set((s) => ({ project: next, projectRevision: s.projectRevision + 1 }));
    void saveProject(fs, next);
    // 画質切替に伴う warm-up のズレを防ぐため primed 状態を破棄。
    evictVideoPrimed(assetId);
    return true;
  },

  addVideoLayer: (assetId, name) => {
    const p = get().project;
    const comp = p?.compositions.find((c) => c.id === get().currentCompId) as TimelineComposition | undefined;
    if (!p || !comp) return null;
    const asset = p.assets.find((a) => a.id === assetId);
    if (!asset || asset.kind !== "video") return null;
    const outPoint = videoLayerOutPoint(asset.meta, comp.fps, comp.duration);
    const id = newObjectId();
    const obj: SceneObject = {
      id,
      name: name ?? asset.path.split("/").pop() ?? "Video",
      parent: null,
      zOrder: nextZOrder(comp),
      enabled: true,
      inPoint: 0,
      outPoint,
      transform: defaultTransform(),
      opacity: staticProp(1),
      components: [{ type: "video", props: { asset: assetId, fit: "contain", trimStart: 0, gain: staticProp(1) } }],
    };
    cmdAddObject(get(), obj);
    return id;
  },

  removeAsset: (assetId) => {
    const before = get().project;
    if (!before) return;
    const asset = before.assets.find((a) => a.id === assetId);
    if (!asset || (asset.kind !== "audio" && asset.kind !== "image" && asset.kind !== "video")) return;

    const removedLayerIds = new Set<string>();
    const compositions = before.compositions.map((c) => {
      if (c.kind !== "timeline") return c;
      const objects = c.objects.filter((o) => {
        const uses = o.components.some(
          (cmp) =>
            (cmp.type === "audio" || cmp.type === "image" || cmp.type === "video") &&
            cmp.props["asset"] === assetId,
        );
        if (uses) removedLayerIds.add(o.id);
        return !uses;
      });
      return objects.length === c.objects.length ? c : { ...c, objects };
    });

    const after = unregisterProjectItem(
      {
        ...before,
        compositions,
        assets: before.assets.filter((a) => a.id !== assetId),
      },
      { kind: "asset", id: assetId },
    );
    get().applyCommand({ label: "Remove Footage", before, after });

    if (removedLayerIds.size > 0) {
      set((s) => ({
        selectedObjectIds: s.selectedObjectIds.filter((id) => !removedLayerIds.has(id)),
      }));
    }

    const assetPath = asset.path;
    // §11.4b 原本 + 全プロキシファイルを FS から削除（path / originalPath / meta.proxies.*）。
    const filesToDelete = new Set<string>([assetPath]);
    if (typeof asset.meta?.["originalPath"] === "string") filesToDelete.add(asset.meta["originalPath"] as string);
    const proxies = asset.meta?.["proxies"];
    if (proxies && typeof proxies === "object") {
      for (const raw of Object.values(proxies as Record<string, unknown>)) {
        const pp = (raw as { path?: unknown })?.path;
        if (typeof pp === "string") filesToDelete.add(pp);
      }
    }
    void (async () => {
      for (const f of filesToDelete) {
        try {
          await fs.delete(f);
        } catch {
          /* 掃除失敗は無視 */
        }
      }
      if (asset.kind === "audio") {
        evictAudioBuffer(assetId);
        globalWaveformCache.evict(assetId);
      }
      if (asset.kind === "video") {
        evictPreviewMediaAsset(assetId);
        evictVideoPrimed(assetId);
      }
    })();
  },

  // M4: plugin ロード —————————————————————————————————————————————

  loadPlugins: async () => {
    const p = get().project;
    if (!p) return;

    globalPluginRegistry.clear();
    pluginLoader.clear();
    registerBuiltinComponents();
    registerBuiltinEffects();

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
      outPoint: compLayerDefaultOutPoint(
        0,
        0,
        srcComp.duration,
        currentComp.fps,
        srcComp.fps,
        currentComp.duration,
      ),
      transform: defaultTransform(),
      opacity: staticProp(1),
      components: [{ type: "comp", props: { compId, trimStart: 0 } }],
    };
    cmdAddObject(get(), obj);
    return id;
  },

  addEffect: (objId, type) => {
    const def = globalPluginRegistry.getEffectDef(type);
    if (!def) return null;
    const comp = currentTimelineComp(get().project, get().currentCompId);
    const obj = comp?.objects.find((o) => o.id === objId);
    if (!obj) return null;
    const effect: EffectInstance = {
      id: newObjectId(),
      type,
      enabled: true,
      props: defaultEffectProps(def),
    };
    get().updateObject(objId, { effects: [...(obj.effects ?? []), effect] }, `Add ${def.label}`);
    return effect.id;
  },

  removeEffect: (objId, effectId) => {
    const comp = currentTimelineComp(get().project, get().currentCompId);
    const obj = comp?.objects.find((o) => o.id === objId);
    if (!obj?.effects) return;
    const next = obj.effects.filter((e) => e.id !== effectId);
    get().updateObject(objId, { effects: next.length > 0 ? next : undefined }, "Remove effect");
  },

  reorderEffect: (objId, effectId, dir) => {
    const comp = currentTimelineComp(get().project, get().currentCompId);
    const obj = comp?.objects.find((o) => o.id === objId);
    if (!obj?.effects) return;
    const idx = obj.effects.findIndex((e) => e.id === effectId);
    if (idx < 0) return;
    const swap = dir === "up" ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= obj.effects.length) return;
    const next = [...obj.effects];
    [next[idx], next[swap]] = [next[swap]!, next[idx]!];
    get().updateObject(objId, { effects: next }, "Reorder effect");
  },

  toggleEffect: (objId, effectId) => {
    const comp = currentTimelineComp(get().project, get().currentCompId);
    const obj = comp?.objects.find((o) => o.id === objId);
    if (!obj?.effects) return;
    get().updateObject(objId, {
      effects: obj.effects.map((e) =>
        e.id === effectId ? { ...e, enabled: !e.enabled } : e,
      ),
    }, "Toggle effect");
  },

  // 旧 API: live 別名（§27.4・後方互換）
  addAdjustmentLayer: (name) => get().addLiveAdjustmentLayer(name),

  addLiveAdjustmentLayer: (name) => {
    const id = newObjectId();
    const p = get().project;
    const comp = p?.compositions.find((c) => c.id === get().currentCompId) as TimelineComposition | undefined;
    const duration = comp?.duration ?? 150;
    const obj: SceneObject = {
      id,
      name: name ?? "Adjustment",
      parent: null,
      zOrder: nextZOrder(comp),
      enabled: true,
      inPoint: 0,
      outPoint: duration,
      transform: defaultTransform(),
      opacity: staticProp(1),
      components: [],
      isAdjustment: true,
      // adjustmentMode 省略 = live（canonical で省略・byte 等価）
    };
    cmdAddObject(get(), obj);
    return id;
  },

  addRasterAdjustmentLayer: (name) => {
    const id = newObjectId();
    const p = get().project;
    const comp = p?.compositions.find((c) => c.id === get().currentCompId) as TimelineComposition | undefined;
    const duration = comp?.duration ?? 150;
    const obj: SceneObject = {
      id,
      name: name ?? "Adjustment (Raster)",
      parent: null,
      zOrder: nextZOrder(comp),
      enabled: true,
      inPoint: 0,
      outPoint: duration,
      transform: defaultTransform(),
      opacity: staticProp(1),
      components: [],
      isAdjustment: true,
      adjustmentMode: "raster",
    };
    cmdAddObject(get(), obj);
    return id;
  },

  setAdjustmentMode: (objId, mode) => {
    const comp = currentTimelineComp(get().project, get().currentCompId);
    const obj = comp?.objects.find((o) => o.id === objId);
    if (!obj || !obj.isAdjustment) return;
    get().updateObject(objId, {
      adjustmentMode: mode === "raster" ? "raster" : undefined,
    }, mode === "raster" ? "Raster 調整に変更" : "Live 調整に変更");
  },

  toggleAdjustment: (objId) => {
    const comp = currentTimelineComp(get().project, get().currentCompId);
    const obj = comp?.objects.find((o) => o.id === objId);
    if (!obj) return;
    // §30.1: Null と Adjustment は排他。Null レイヤーは調整レイヤーにできない。
    if (obj.isNull) return;
    const next = !obj.isAdjustment;
    get().updateObject(objId, {
      isAdjustment: next ? true : undefined,
      isNull: next ? undefined : obj.isNull,
      components: next ? [] : obj.components,
    }, next ? "Make adjustment layer" : "Make normal layer");
  },

  addNullLayer: (name) => {
    const id = newObjectId();
    const p = get().project;
    const comp = p?.compositions.find((c) => c.id === get().currentCompId) as TimelineComposition | undefined;
    const duration = comp?.duration ?? 150;
    const transform = defaultTransform();
    if (comp) {
      transform.position = staticProp(vec3(comp.width / 2, comp.height / 2, 0));
    }
    const obj: SceneObject = {
      id,
      name: name ?? defaultNullLayerName(comp),
      parent: null,
      zOrder: nextZOrder(comp),
      enabled: true,
      inPoint: 0,
      outPoint: duration,
      transform,
      opacity: staticProp(1),
      components: [],
      isNull: true,
    };
    cmdAddObject(get(), obj);
    return id;
  },

  // §6.5b カメラ（AE 準拠・two-node 既定）。comp 中央を注視し、自然なパースになる距離に置く。
  addCamera: (name) => {
    const id = newObjectId();
    const p = get().project;
    const comp = p?.compositions.find((c) => c.id === get().currentCompId) as TimelineComposition | undefined;
    if (!p || !comp) return null;
    const duration = comp.duration;
    const cx = comp.width / 2;
    const cy = comp.height / 2;
    // 既定 fov 50° に対応する zoom(px) = (h/2)/tan(25°)。その距離に前置きすると content が等倍に見える。
    const zoom = comp.height / 2 / Math.tan((25 * Math.PI) / 180);
    const transform = defaultTransform();
    transform.position = staticProp(vec3(cx, cy, zoom)); // comp 中央の正面（+z は視点側）
    const camName = name ?? defaultCameraName(comp);
    const obj: SceneObject = {
      id,
      name: camName,
      parent: null,
      zOrder: nextZOrder(comp),
      enabled: true,
      inPoint: 0,
      outPoint: duration,
      transform,
      opacity: staticProp(1),
      components: [
        {
          type: "camera",
          props: {
            cameraType: "two-node",
            pointOfInterest: staticProp(vec3(cx, cy, 0)),
            zoom: staticProp(zoom),
            filmSize: 36,
            near: 1,
            far: 10000,
          },
        },
      ],
    };
    // §6.5: active camera は永続しない。追加するだけで最前面ならその frame で自動採用される。
    const before = get().project!;
    const withObj: Project = {
      ...before,
      compositions: before.compositions.map((c) =>
        c.id === comp.id && c.kind === "timeline"
          ? { ...c, objects: [...c.objects, obj] }
          : c,
      ),
    };
    get().applyCommand({ label: "Add Camera", before, after: withObj });
    return id;
  },

  // §6.5: プレビュー視点 override（非永続・undo に積まない・project.json に書かない）。
  // null = 自動（最前面の可視カメラ）。ObjectId = そのカメラを強制。"default" = デフォルト視点。
  setPreviewCamera: (cam) => set({ previewCamera: cam }),

  setThreeD: (objId, enabled) => {
    const comp = currentTimelineComp(get().project, get().currentCompId);
    const obj = comp?.objects.find((o) => o.id === objId);
    if (!obj) return;
    get().updateObject(objId, { threeD: enabled ? true : undefined }, enabled ? "Enable 3D layer" : "Disable 3D layer");
  },

  setThreeDMode: (objId, mode) => {
    const comp = currentTimelineComp(get().project, get().currentCompId);
    const obj = comp?.objects.find((o) => o.id === objId);
    if (!obj) return;
    get().updateObject(objId, { threeDMode: mode === "auto" ? undefined : mode }, `3D mode: ${mode}`);
  },

  // §5.4d: normal は undefined にして直列化省略（byte 等価）。
  setBlendMode: (objId, mode) => {
    const comp = currentTimelineComp(get().project, get().currentCompId);
    const obj = comp?.objects.find((o) => o.id === objId);
    if (!obj) return;
    get().updateObject(objId, { blendMode: mode === "normal" ? undefined : mode }, `Blend mode: ${mode}`);
    set((s) => {
      if (!(objId in s.missingBlendModes)) return s;
      const { [objId]: _removed, ...missingBlendModes } = s.missingBlendModes;
      return { missingBlendModes };
    });
  },

  // §5.4f: 未設定は undefined にして直列化省略。
  setTrackMatteMode: (objId, mode) => {
    const comp = currentTimelineComp(get().project, get().currentCompId);
    const obj = comp?.objects.find((o) => o.id === objId);
    if (!obj) return;
    get().updateObject(
      objId,
      { trackMatteMode: mode === null ? undefined : mode },
      mode === null ? "Clear track matte" : `Track matte: ${mode}`,
    );
  },

  setCompRenderer3d: (mode) => {
    const before = get().project;
    if (!before) return;
    const compId = get().currentCompId;
    const after: Project = {
      ...before,
      compositions: before.compositions.map((c) =>
        c.id === compId && c.kind === "timeline"
          ? { ...c, renderer3d: mode === "classic" ? undefined : mode }
          : c,
      ),
    };
    get().applyCommand({ label: `3D Renderer: ${mode}`, before, after });
  },

  setCompBackground: (bg) => {
    const before = get().project;
    if (!before) return;
    const compId = get().currentCompId;
    const after: Project = {
      ...before,
      compositions: before.compositions.map((c) =>
        c.id === compId
          ? { ...c, background: bg ?? undefined }
          : c,
      ),
    };
    get().applyCommand({ label: bg ? "Set Background" : "Clear Background (transparent)", before, after });
  },

  resizeComp: (width, height) => {
    const before = get().project;
    if (!before) return;
    const compId = get().currentCompId;
    const target = before.compositions.find((c) => c.id === compId);
    if (!target || target.kind !== "timeline") return;
    const resized = resizeCompCentered(target, width, height);
    if (resized.width === target.width && resized.height === target.height) return;
    const after: Project = {
      ...before,
      compositions: before.compositions.map((c) => (c.id === compId ? resized : c)),
    };
    get().applyCommand({ label: `Comp Size ${resized.width}×${resized.height}`, before, after });
  },

  setCompFps: (fps) => {
    const before = get().project;
    if (!before) return;
    const compId = get().currentCompId;
    const target = before.compositions.find((c) => c.id === compId);
    if (!target || target.kind !== "timeline") return;
    const newFps = Math.max(1, Math.round(fps));
    if (newFps === target.fps) return;
    const rescaled = rescaleCompFps(target, newFps);
    const after: Project = {
      ...before,
      compositions: before.compositions.map((c) => (c.id === compId ? rescaled : c)),
    };
    get().applyCommand({ label: `Comp FPS ${newFps}`, before, after });
    // 再生ヘッドも秒維持で再配置（プロジェクト外の transient 状態）。
    const ratio = newFps / target.fps;
    set({ currentFrame: Math.max(0, Math.min(Math.round(get().currentFrame * ratio), rescaled.duration - 1)) });
  },

  setCompDuration: (duration) => {
    const before = get().project;
    if (!before) return;
    const compId = get().currentCompId;
    const target = before.compositions.find((c) => c.id === compId);
    if (!target) return;
    const newDur = Math.max(1, Math.round(duration));
    if (newDur === target.duration) return;
    const after: Project = {
      ...before,
      compositions: before.compositions.map((c) => (c.id === compId ? { ...c, duration: newDur } : c)),
    };
    get().applyCommand({ label: `Comp Duration ${newDur}f`, before, after });
    if (get().currentFrame > newDur - 1) set({ currentFrame: newDur - 1 });
  },

  setCompBpm: (bpm) => {
    const before = get().project;
    if (!before) return;
    const compId = get().currentCompId;
    const target = before.compositions.find((c) => c.id === compId);
    if (!target) return;
    const v = Number.isFinite(bpm) ? Math.max(0, bpm) : 0;
    const nextBpm = v > 0 ? v : undefined;
    if ((target.bpm ?? 0) === (nextBpm ?? 0)) return;
    const after: Project = {
      ...before,
      compositions: before.compositions.map((c) =>
        c.id === compId
          ? // 無効化時は beatsPerBar も落とす（§21.1b 正準化）。
            { ...c, bpm: nextBpm, beatsPerBar: nextBpm !== undefined ? c.beatsPerBar : undefined }
          : c,
      ),
    };
    get().applyCommand({ label: nextBpm !== undefined ? `Set BPM ${nextBpm}` : "Clear BPM", before, after });
  },

  setCompBeatsPerBar: (n) => {
    const before = get().project;
    if (!before) return;
    const compId = get().currentCompId;
    const target = before.compositions.find((c) => c.id === compId);
    if (!target || !(typeof target.bpm === "number" && target.bpm > 0)) return; // bpm 無効時 no-op
    const v = Math.max(1, Math.round(n));
    if ((target.beatsPerBar ?? 4) === v) return;
    const after: Project = {
      ...before,
      compositions: before.compositions.map((c) => (c.id === compId ? { ...c, beatsPerBar: v } : c)),
    };
    get().applyCommand({ label: `Set Beats/Bar ${v}`, before, after });
  },
}));

declare global {
  interface Window {
    /** Playwright 実機検証用（dev のみ）。dynamic import だと別 Zustand インスタンスになるため正を window に置く。 */
    __mafterEditorStore?: typeof useEditorStore;
  }
}

if (typeof window !== "undefined") {
  window.__mafterEditorStore = useEditorStore;
}

// ---- ユーティリティ ----

function nextZOrder(comp: TimelineComposition | undefined): number {
  if (!comp || comp.objects.length === 0) return 1;
  return Math.max(...comp.objects.map((o) => o.zOrder)) + 1;
}

function defaultNullLayerName(comp: TimelineComposition | undefined): string {
  if (!comp) return "Null";
  const count = comp.objects.filter((o) => o.isNull === true).length;
  return count === 0 ? "Null" : `Null ${count + 1}`;
}

function defaultCameraName(comp: TimelineComposition | undefined): string {
  if (!comp) return "Camera 1";
  const count = comp.objects.filter((o) => o.components.some((c) => c.type === "camera")).length;
  return `Camera ${count + 1}`;
}

function defaultEffectProps(def: EffectDef): Record<string, AnimatedProp<unknown> | unknown> {
  const props: Record<string, AnimatedProp<unknown> | unknown> = {};
  for (const p of def.params) {
    props[p.key] = p.animatable ? staticProp(p.default) : p.default;
  }
  return props;
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

