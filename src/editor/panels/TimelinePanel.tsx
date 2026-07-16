import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyKfEasing,
  buildKfPatches,
  collectKfFrames,
  deleteKfFrames,
  getPropByPath,
  groupSelectedKfs,
  isAnimatedProp,
  kfKey,
  moveKfFrames,
  parseKfKey,
  type PropPath,
} from "../keyframeEdit";
import { currentTimelineComp, setKeyframe, useEditorStore } from "../store";
import { useContextMenuStore, type ContextMenuItem } from "../contextMenu/contextMenuStore";
import { EXPRESSED_VALUE_COLOR, isPropExpressed } from "../../core/props";
import { framesToTimecode } from "../timecode";
import { formatTimeWithBeat } from "../beatTimecode";
import { isRgba } from "../ColorSwatch";
import { getLayerSourceExtent, rescaleFootageSourceOffset, shiftFootageSourceOffset, type LayerSourceExtent } from "../layerSourceOffset";
import { DRAG_MIME } from "./dragMime";
import { ScrubNumber } from "../ScrubNumber";
import { labelBarColor, labelColorTitle, labelRowTint, LAYER_LABEL_COLORS, timelineBarFill } from "../layerLabels";
import type {
  AnimatedProp,
  Component,
  Easing,
  Frame,
  LabelIndex,
  ParamKind,
  RGBA,
  SceneObject,
  Transform,
  Vec3,
} from "../../core/schema";
import { sampleAny, sampleScalar, sampleVec3 } from "../../runtime/interpolate";
import { activeCameraAt } from "../../runtime/resolve";
import { resolveTrackMattePairs } from "../../core/trackMatte";
import { globalPluginRegistry } from "../../runtime/pluginRegistry";
import { EXPRESSION_PRESETS, type ExpressionPresetId } from "../expressionPresets";
import { previewCacheService } from "../previewCacheService";
import { framesToSegments } from "../cacheSegments";
import { precompChildToParentFrame } from "../../cache/precompFrameKey";
import { feedbackCollector } from "../feedbackCollector";
import { loadWorkArea } from "../workAreaStorage";
import { isValidParent, listParentCandidates } from "../parentLink";
import { isLayerLocked, unlockedVisibilityPatches } from "../layerLock";
import { buildReparentPatch } from "../reparent";
import { loadAudioBuffer, peekAudioBuffer } from "../audioBufferCache";
import { computePeaksForFrameRange, type WaveformMode } from "../../audio/waveform";
import type { FileSystem } from "../../fs/FileSystem";

// トラックのラベル列幅（左パネル）。グラフ領域はこれを引いた残り。
const LABEL_W = 310;

type TransformVecKey = "anchor" | "position" | "rotation" | "scale";

// §21.6 U キー展開モード。"kf"=KF あり行のみ / "uu"=変更済み行のみ / "all"=全行。
type ExpandMode = "all" | "kf" | "uu";

const VEC3_DEFAULTS: Record<TransformVecKey, Vec3> = {
  anchor:   { x: 0, y: 0, z: 0 },
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale:    { x: 1, y: 1, z: 1 },
};

// P0-3: イージングプリセット
const EASY_EASE: Easing = { type: "bezier", bezier: [0.33, 0, 0.66, 1] };
const EASE_IN: Easing   = { type: "bezier", bezier: [0.42, 0, 1, 1] };
const EASE_OUT: Easing  = { type: "bezier", bezier: [0, 0, 0.58, 1] };

// KF ダイヤの色: easing type によって色分け（選択・現フレームは別途上書き）。
function easingColor(easing: Easing): string {
  if (easing.type === "bezier" || easing.type === "preset") return "#6c9";
  if (easing.type === "hold") return "#99c";
  return "#caa"; // linear
}

function vec3Modified(prop: AnimatedProp<Vec3>, def: Vec3): boolean {
  if (prop.keyframes.length > 0) return true;
  const v = prop.value;
  return v.x !== def.x || v.y !== def.y || v.z !== def.z;
}

function scalarModified(prop: AnimatedProp<number>, def: number): boolean {
  return prop.keyframes.length > 0 || prop.value !== def;
}

function showInMode(mode: ExpandMode, animated: boolean, modified: boolean): boolean {
  if (mode === "all") return true;
  if (animated) return true;
  return mode === "uu" && modified;
}

interface SelectBox { x0: number; y0: number; x1: number; y1: number }
interface KfDragState { keys: Set<string>; delta: number }
// P1-9: コピーしたKFデータ
interface CopiedKf { objId: string; path: PropPath; kf: { frame: number; value: unknown; easing: Easing } }
// P1-5: レイヤードラッグ状態
interface LayerDragState { dragIdx: number; dropIdx: number }

export function TimelinePanel() {
  const project = useEditorStore((s) => s.project);
  const compId = useEditorStore((s) => s.currentCompId);
  const frame = useEditorStore((s) => s.currentFrame);
  const selectedIds = useEditorStore((s) => s.selectedObjectIds);
  const setFrame = useEditorStore((s) => s.setFrame);
  const updateObject = useEditorStore((s) => s.updateObject);
  const renameObject = useEditorStore((s) => s.renameObject);
  const setLayerLabelIndex = useEditorStore((s) => s.setLayerLabelIndex);
  const addSolid = useEditorStore((s) => s.addSolid);
  const addShape = useEditorStore((s) => s.addShape);
  const addText = useEditorStore((s) => s.addText);
  const addAdjustmentLayer = useEditorStore((s) => s.addAdjustmentLayer);
  const addNullLayer = useEditorStore((s) => s.addNullLayer);
  const addCamera = useEditorStore((s) => s.addCamera);
  const previewCamera = useEditorStore((s) => s.previewCamera);
  const setPreviewCamera = useEditorStore((s) => s.setPreviewCamera);
  const setCompRenderer3d = useEditorStore((s) => s.setCompRenderer3d);
  const removeObject = useEditorStore((s) => s.removeObject);
  const selectObjects = useEditorStore((s) => s.selectObjects);
  const updateObjects = useEditorStore((s) => s.updateObjects);
  const setPreviewOverride = useEditorStore((s) => s.setPreviewOverride);
  const removeObjects = useEditorStore((s) => s.removeObjects);
  const pasteObjects = useEditorStore((s) => s.pasteObjects);
  const addHtmlInstance = useEditorStore((s) => s.addHtmlInstance);
  const addAudioLayer = useEditorStore((s) => s.addAudioLayer);
  const importAudioAsset = useEditorStore((s) => s.importAudioAsset);
  const addImageLayer = useEditorStore((s) => s.addImageLayer);
  const importImageAsset = useEditorStore((s) => s.importImageAsset);
  const importVideoAsset = useEditorStore((s) => s.importVideoAsset);
  const addVideoLayer = useEditorStore((s) => s.addVideoLayer);
  const addPluginObject = useEditorStore((s) => s.addPluginObject);
  const addCompLayer = useEditorStore((s) => s.addCompLayer);
  const waveformMode = useEditorStore((s) => s.waveformMode);
  const setWaveformMode = useEditorStore((s) => s.setWaveformMode);
  const getFs = useEditorStore((s) => s.getFs);
  // P0-2: 再生制御はストアで共有
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const togglePlay = useEditorStore((s) => s.togglePlay);
  const workAreaRevision = useEditorStore((s) => s.workAreaRevision);

  const comp = currentTimelineComp(project, compId);
  const duration = comp?.duration ?? 150;
  const fps = comp?.fps ?? 30;
  // §21.1b BPM 併記（無効時は undefined でタイムコードのみ）。
  const bpm = comp?.bpm;
  const beatsPerBar = comp?.beatsPerBar;
  const workArea = useMemo(
    () => (comp ? loadWorkArea(comp.id, comp.duration) : { inPoint: 0, outPoint: duration }),
    [comp, duration, workAreaRevision],
  );
  const [cachedFrames, setCachedFrames] = useState<Set<number>>(() => new Set());
  const [cachedLayerFrames, setCachedLayerFrames] = useState<Map<string, Set<number>>>(() => new Map());
  const [cachedPrecompFrames, setCachedPrecompFrames] = useState<Map<string, Set<number>>>(() => new Map());

  useEffect(() => {
    return previewCacheService.subscribe(setCachedFrames);
  }, [compId, workAreaRevision]);

  useEffect(() => {
    return previewCacheService.subscribeLayerFrames(setCachedLayerFrames);
  }, [compId, workAreaRevision]);

  useEffect(() => {
    return previewCacheService.subscribePrecompFrames(setCachedPrecompFrames);
  }, [compId, workAreaRevision]);
  // P1-5: タイムラインは zOrder 降順で表示（最前面=最上段, AE 準拠）。配列順ではなく描画順に並べる。
  const objects = [...(comp?.objects ?? [])].sort((a, b) => b.zOrder - a.zOrder);

  // §6.5: 現フレームで実際に出力に使われるカメラ（最前面の可視カメラ）。CAM● バッジに使う。
  const autoActiveCameraId = comp ? (activeCameraAt(comp, frame)?.id ?? null) : null;

  // P0-1: ズーム/スクロール状態 — viewRange は表示フレーム範囲（UI 状態, project 非保存）。
  const [viewRange, setViewRange] = useState<{ start: number; end: number }>({ start: 0, end: duration });
  const prevCompIdRef = useRef<string | null>(null);

  const [expandMode, setExpandMode] = useState<Map<string, ExpandMode>>(new Map());
  const graphRef = useRef<HTMLDivElement>(null);
  const timelineContainerRef = useRef<HTMLDivElement>(null);

  const [dropActive, setDropActive] = useState(false);
  const selectedKfKeys = useEditorStore((s) => s.selectedKfKeys);
  const setSelectedKfKeys = useEditorStore((s) => s.setSelectedKfKeys);
  const selectedKfs = useMemo(() => new Set(selectedKfKeys), [selectedKfKeys]);

  const [kfDrag, setKfDrag] = useState<KfDragState | null>(null);
  const [box, setBox] = useState<SelectBox | null>(null);
  const openContextMenu = useContextMenuStore((s) => s.openContextMenu);
  const closeContextMenu = useContextMenuStore((s) => s.closeContextMenu);
  const rowsRef = useRef<HTMLDivElement>(null);
  const dragMovedRef = useRef(false);
  const lastUPressRef = useRef<number>(0);
  // P1-6: 複数レイヤー選択用
  const lastSelectedIdRef = useRef<string | null>(null);
  // P1-5: レイヤードラッグ並べ替え（ref が正本。dragOver は dragStart より先に来ることがあり state だけだと null になる）
  const [layerDrag, setLayerDrag] = useState<LayerDragState | null>(null);
  const layerDragRef = useRef<LayerDragState | null>(null);
  const layerDragIdRef = useRef<string | null>(null);
  // P1-8: スナップ
  const [snapEnabled, setSnapEnabled] = useState(false);
  // §22 グラフエディタモード（エディタ一時状態, project 非保存）
  const [graphMode, setGraphMode] = useState(false);
  // P1-9: クリップボード（AE 同様、KF 選択中は KF を / それ以外はレイヤーを対象）。
  const clipboardRef = useRef<
    | { kind: "kf"; data: CopiedKf[] }
    | { kind: "layers"; data: SceneObject[]; fps: number }
    | null
  >(null);
  // P1-6: レイヤーバードラッグ（trim/slide）をパネルにリフトアップ。複数選択を一括移動するため。
  const [barDrag, setBarDrag] = useState<{ ids: Set<string>; mode: "in" | "out" | "move"; delta: number } | null>(null);
  // 操作フィードバック（コピー/ペースト等）。一定時間で消える。
  // 表示（statusMsg の読み出し）は WIP でコメントアウト中のため setter のみ使用。
  const [, setStatusMsg] = useState<string>("");
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashStatus = (msg: string) => {
    setStatusMsg(msg);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatusMsg(""), 1800);
  };

  // comp 切替 / duration 変更時の viewRange と UI 状態
  useEffect(() => {
    const compSwitched = prevCompIdRef.current !== compId;
    prevCompIdRef.current = compId;

    if (compSwitched) {
      setSelectedKfKeys([]);
      setExpandMode(new Map());
      setViewRange({ start: 0, end: duration });
      closeContextMenu();
      layerDragRef.current = null;
      setLayerDrag(null);
      setBarDrag(null);
      lastSelectedIdRef.current = null;
      return;
    }

    // 同一 comp 内で duration が短くなったときだけ end をクランプ（comp 切替直後は上で全リセット済み）
    setViewRange((prev) => ({
      start: prev.start,
      end: Math.max(prev.start + 5, Math.min(prev.end, duration)),
    }));
  }, [compId, duration]); // eslint-disable-line react-hooks/exhaustive-deps

  // P0-1: frame → % 変換（viewRange 基準）。
  const frameToPercent = (f: number): number => {
    const span = viewRange.end - viewRange.start;
    return span > 0 ? ((f - viewRange.start) / span) * 100 : 0;
  };

  // P0-1: グラフ列の px → frame 変換（viewRange 基準）。生のフレーム値（スナップは snapFrame で別途適用）。
  const pxToFrame = (clientX: number): Frame => {
    const el = graphRef.current;
    if (!el) return frame;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const raw = viewRange.start + ratio * (viewRange.end - viewRange.start);
    return Math.max(0, Math.min(duration, Math.round(raw)));
  };

  // P1-8: スナップ。snapEnabled 時、近接する候補（再生ヘッド・秒境界・0・終端）へ吸着する。
  // 半径は表示ピクセル ~10px 相当のフレーム数。exclude は自分自身（吸着対象から除外）。
  const snapFrame = (f: number, exclude?: number): number => {
    if (!snapEnabled) return Math.round(f);
    const el = graphRef.current;
    const span = viewRange.end - viewRange.start;
    const w = el ? el.getBoundingClientRect().width : 1;
    const radius = Math.max(1, (span * 10) / Math.max(1, w));
    const cands: number[] = [0, duration, frame];
    const fpsR = Math.max(1, Math.round(fps));
    for (let s = Math.ceil(viewRange.start / fpsR) * fpsR; s <= viewRange.end; s += fpsR) cands.push(s);
    let best = Math.round(f);
    let bestD = radius;
    for (const c of cands) {
      if (c === exclude) continue;
      const d = Math.abs(c - f);
      if (d <= bestD) { bestD = d; best = c; }
    }
    return Math.max(0, Math.min(duration, best));
  };

  // Project パネルからの D&D ドロップ
  const onTimelineDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);

    // レイヤー並べ替え DnD が ruler/空エリア上でドロップされた場合
    // (LayerRow.onDrop は stopPropagation するのでここには ruler 上またはレイヤー行がない空エリアのみ来る)
    if (e.dataTransfer.types.includes("text/x-layer-drag")) {
      handleLayerDrop(layerDragRef.current?.dropIdx ?? 0);
      return;
    }

    // OS からのメディアファイルドロップ（Windows Explorer 等）
    const droppedFiles = Array.from(e.dataTransfer.files);
    const audioFiles = droppedFiles.filter((f) => f.type.startsWith("audio/") || /\.(mp3|wav|ogg|flac|aac|m4a)$/i.test(f.name));
    const imageFiles = droppedFiles.filter((f) => f.type.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif|bmp|svg)$/i.test(f.name));
    const videoFiles = droppedFiles.filter((f) => f.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(f.name));
    if (audioFiles.length > 0 || imageFiles.length > 0 || videoFiles.length > 0) {
      void (async () => {
        for (const file of audioFiles) {
          const assetId = await importAudioAsset(file);
          if (assetId) {
            const layerId = addAudioLayer(assetId, file.name.replace(/\.[^.]+$/, ""));
            if (layerId) selectObjects([layerId]);
          }
        }
        for (const file of imageFiles) {
          const assetId = await importImageAsset(file);
          if (assetId) {
            const layerId = addImageLayer(assetId, file.name.replace(/\.[^.]+$/, ""));
            if (layerId) selectObjects([layerId]);
          }
        }
        for (const file of videoFiles) {
          const assetId = await importVideoAsset(file);
          if (assetId) {
            const layerId = addVideoLayer(assetId, file.name.replace(/\.[^.]+$/, ""));
            if (layerId) selectObjects([layerId]);
          }
        }
      })();
      return;
    }

    // ProjectPanel からのアイテムドロップ
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    try {
      const item = JSON.parse(raw) as { kind: string; id?: string; componentType?: string };
      let newId: string | null = null;
      if (item.kind === "html-comp" && item.id) newId = addHtmlInstance(item.id);
      else if (item.kind === "audio-asset" && item.id) newId = addAudioLayer(item.id);
      else if (item.kind === "image-asset" && item.id) newId = addImageLayer(item.id);
      else if (item.kind === "video-asset" && item.id) newId = addVideoLayer(item.id);
      else if (item.kind === "plugin-component" && item.componentType) newId = addPluginObject(item.componentType);
      else if (item.kind === "timeline-comp" && item.id) newId = addCompLayer(item.id);
      if (newId) selectObjects([newId]);
    } catch { /* ignore */ }
  };

  const toggleExpand = (id: string) =>
    setExpandMode((prev) => {
      const next = new Map(prev);
      if (next.get(id) === "all") next.delete(id);
      else next.set(id, "all");
      return next;
    });

  // P0-3: 選択 KF のイージングをまとめて変更（1 command）。
  // keysOverride: コンテキストメニュー項目のクロージャが右クリック時点の対象 KF を保持するため
  // （メニュー項目は基盤 store にスナップショットされ、後の selectedKfs 更新を読めない）。
  const applyEasingToSelectedKfs = (easing: Easing, keysOverride?: Set<string>) => {
    const keys = keysOverride ?? selectedKfs;
    if (keys.size === 0) return;
    const group = groupSelectedKfs(keys);
    const patches = buildKfPatches(objects, group, (prop, frames) => applyKfEasing(prop, frames, easing));
    updateObjects(patches, `Apply ${easing.type} easing`);
  };

  // §21.5 選択中 KF を Δframe でまとめて移動。
  const applyMultiKfMove = (keys: Set<string>, delta: number) => {
    if (delta === 0 || keys.size === 0) return;
    const group = groupSelectedKfs(keys);
    const patches = buildKfPatches(objects, group, (prop, frames) => moveKfFrames(prop, frames, delta));
    updateObjects(patches, "Move keyframes");
    const next = new Set<string>();
    keys.forEach((k) => {
      const { objId, path, frame: kff } = parseKfKey(k);
      next.add(kfKey(objId, path, kff + delta));
    });
    setSelectedKfKeys([...next]);
  };

  const applyMultiKfDelete = (keys: Set<string>) => {
    if (keys.size === 0) return;
    const group = groupSelectedKfs(keys);
    const patches = buildKfPatches(objects, group, (prop, frames) => deleteKfFrames(prop, frames));
    updateObjects(patches, "Delete keyframes");
    setSelectedKfKeys([]);
  };

  // P1-9: 選択 KF をクリップボードへ。コピー数を返す。
  const copySelectedKfsToClipboard = (): number => {
    const copied: CopiedKf[] = [];
    for (const key of selectedKfs) {
      const { objId, path, frame: kfFrame } = parseKfKey(key);
      const obj = objects.find((o) => o.id === objId);
      if (!obj) continue;
      const prop = getPropByPath(obj, path);
      const kf = prop.keyframes.find((k) => k.frame === kfFrame);
      if (kf) copied.push({ objId, path, kf: { frame: kf.frame, value: kf.value, easing: kf.easing } });
    }
    clipboardRef.current = { kind: "kf", data: copied };
    return copied.length;
  };

  // P1-9: 選択レイヤーをクリップボードへ。コピー数を返す。
  const copySelectedLayersToClipboard = (): number => {
    const layers = objects.filter((o) => selectedIds.includes(o.id)).map((o) => cloneObject(o));
    clipboardRef.current = { kind: "layers", data: layers, fps };
    return layers.length;
  };

  // P1-9: クリップボードの KF を現フレーム基準で貼り付け。
  const pasteKfsAtPlayhead = () => {
    const clip = clipboardRef.current;
    if (!clip || clip.kind !== "kf" || clip.data.length === 0) return;
    const copied = clip.data;
    const minKfFrame = Math.min(...copied.map((c) => c.kf.frame));
    const offset = frame - minKfFrame;
    const byObjPath = new Map<string, Map<PropPath, { frame: number; value: unknown; easing: Easing }[]>>();
    for (const { objId, path, kf } of copied) {
      let pm = byObjPath.get(objId);
      if (!pm) { pm = new Map(); byObjPath.set(objId, pm); }
      let arr = pm.get(path);
      if (!arr) { arr = []; pm.set(path, arr); }
      arr.push({ ...kf, frame: Math.max(0, Math.min(duration, kf.frame + offset)) });
    }
    const patches: { id: string; patch: Partial<SceneObject> }[] = [];
    for (const [objId, pm] of byObjPath) {
      const obj = objects.find((o) => o.id === objId);
      if (!obj) continue;
      const patch: Partial<SceneObject> = {};
      let transform = obj.transform;
      let touchedTransform = false;
      const compMods = new Map<number, Map<string, AnimatedProp<unknown>>>();
      const effectMods = new Map<string, Map<string, AnimatedProp<unknown>>>();
      const exprPresetMods = new Map<string, Map<string, AnimatedProp<unknown>>>();
      for (const [path, newKfs] of pm) {
        const prop = getPropByPath(obj, path);
        const merged = [
          ...prop.keyframes.filter((k) => !newKfs.some((nk) => nk.frame === k.frame)),
          ...newKfs,
        ].sort((a, b) => a.frame - b.frame) as typeof prop.keyframes;
        const nextProp = { ...prop, keyframes: merged };
        if (path === "opacity") { patch.opacity = nextProp as AnimatedProp<number>; }
        else if (path.startsWith("transform.")) {
          const k = path.slice("transform.".length) as TransformVecKey;
          transform = { ...transform, [k]: nextProp as AnimatedProp<Vec3> };
          touchedTransform = true;
        } else if (path.startsWith("comp_")) {
          const rest = path.slice(5);
          const sep = rest.indexOf("_");
          const idx = Number(rest.slice(0, sep));
          const key = rest.slice(sep + 1);
          if (!compMods.has(idx)) compMods.set(idx, new Map());
          compMods.get(idx)!.set(key, nextProp);
        } else if (path.startsWith("effects.")) {
          const rest = path.slice("effects.".length);
          const dot = rest.indexOf(".");
          if (dot < 0) continue;
          const effectId = rest.slice(0, dot);
          const key = rest.slice(dot + 1);
          if (!effectMods.has(effectId)) effectMods.set(effectId, new Map());
          effectMods.get(effectId)!.set(key, nextProp);
        } else if (path.startsWith("expressionPresets.")) {
          const rest = path.slice("expressionPresets.".length);
          const dot = rest.indexOf(".");
          if (dot < 0) continue;
          const instanceId = rest.slice(0, dot);
          const key = rest.slice(dot + 1);
          if (!exprPresetMods.has(instanceId)) exprPresetMods.set(instanceId, new Map());
          exprPresetMods.get(instanceId)!.set(key, nextProp);
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
    if (patches.length > 0) {
      updateObjects(patches, "Paste keyframes");
      setSelectedKfKeys(copied.map(({ objId, path, kf }) =>
        kfKey(objId, path, Math.max(0, Math.min(duration, kf.frame + offset))),
      ));
      // WIP: コピペ通知は上部ツールバーのレイアウトを分厚くするため一時無効。後でどうにかする必要がある。
      // flashStatus(`📋 ${copied.length} キーフレームを F${frame} に貼り付け`);
    }
  };

  // P1-9: クリップボードのレイヤーを現フレーム（再生ヘッド）位置へ貼り付け。
  // 相対オフセットを保ったまま、最も早い inPoint が現フレームに来るよう全体を時間シフトする。
  const pasteLayersAtPlayhead = () => {
    const clip = clipboardRef.current;
    if (!clip || clip.kind !== "layers" || clip.data.length === 0) return;
    const minIn = Math.min(...clip.data.map((o) => o.inPoint));
    const delta = frame - minIn;
    const shifted = clip.data.map((o) => {
      const c = cloneObject(o);
      c.inPoint = Math.max(0, Math.min(duration, o.inPoint + delta));
      c.outPoint = Math.max(c.inPoint + 1, Math.min(duration, o.outPoint + delta));
      // fps の違うコンプから持ち込んだ footage は、trimStart を貼り付け先の fps 単位へ換算する
      // （生の frame 数のままだと fps 比の分だけ違う位置から再生される）。
      const rescaled = rescaleFootageSourceOffset(c.components, clip.fps, fps);
      if (rescaled) c.components = rescaled;
      // スライドと同様、キーフレームもレイヤーと一緒に移動（footage 源オフセットは変えない）。
      Object.assign(c, shiftObjectKeyframes(c, delta));
      return c;
    });
    const newIds = pasteObjects(shifted);
    if (newIds.length > 0) selectObjects(newIds);
    // WIP: コピペ通知は上部ツールバーのレイアウトを分厚くするため一時無効。後でどうにかする必要がある。
    // flashStatus(`📋 ${shifted.length} レイヤーを F${frame} に貼り付け`);
  };

  // §21.5 KF ダイヤの mousedown。
  const beginKfDrag = (objId: string, path: PropPath, kfFrame: number, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const key = kfKey(objId, path, kfFrame);
    if (e.shiftKey) {
      setSelectedKfKeys((prev) => {
        const n = new Set(prev);
        if (n.has(key)) n.delete(key);
        else n.add(key);
        return [...n];
      });
      return;
    }
    let dragKeys: Set<string>;
    if (selectedKfs.has(key)) {
      dragKeys = new Set(selectedKfs);
    } else {
      dragKeys = new Set([key]);
      setSelectedKfKeys([...dragKeys]);
    }
    const frames = [...dragKeys].map((k) => parseKfKey(k).frame);
    const minF = Math.min(...frames);
    const maxF = Math.max(...frames);
    const el = graphRef.current;
    const width = el ? el.getBoundingClientRect().width : 1;
    const viewSpan = viewRange.end - viewRange.start;
    const originX = e.clientX;
    let delta = 0;
    const move = (ev: MouseEvent) => {
      let raw = Math.round(((ev.clientX - originX) / width) * viewSpan);
      // P1-8: 掴んだ KF のフレームをスナップ → delta に逆算
      const snapped = snapFrame(kfFrame + raw, kfFrame);
      raw = snapped - kfFrame;
      delta = Math.max(-minF, Math.min(duration - maxF, raw));
      setKfDrag({ keys: dragKeys, delta });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setKfDrag(null);
      applyMultiKfMove(dragKeys, delta);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // P1-6: Shift/Ctrl クリックで複数レイヤー選択。
  const handleLayerSelect = (id: string, e: React.MouseEvent) => {
    if (dragMovedRef.current) return;
    const target = objects.find((o) => o.id === id);
    const locked = target ? isLayerLocked(target) : false;
    if (e.shiftKey && lastSelectedIdRef.current) {
      const ids = objects.map((o) => o.id);
      const lastIdx = ids.indexOf(lastSelectedIdRef.current);
      const thisIdx = ids.indexOf(id);
      if (lastIdx >= 0 && thisIdx >= 0) {
        const lo = Math.min(lastIdx, thisIdx);
        const hi = Math.max(lastIdx, thisIdx);
        const range = ids.slice(lo, hi + 1).filter((rid) => {
          if (selectedIds.includes(rid)) return true;
          const o = objects.find((x) => x.id === rid);
          return !o || !isLayerLocked(o);
        });
        selectObjects([...new Set([...selectedIds, ...range])]);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      if (selectedIds.includes(id)) selectObjects(selectedIds.filter((s) => s !== id));
      else {
        if (locked) return;
        selectObjects([...selectedIds, id]);
        lastSelectedIdRef.current = id;
      }
      return;
    }
    if (locked && !selectedIds.includes(id)) return;
    selectObjects([id]);
    lastSelectedIdRef.current = id;
  };

  const handleToggleLayersLock = (clickedId: string, targetIds: string[]) => {
    const clicked = objects.find((o) => o.id === clickedId);
    if (!clicked) return;
    const nextLocked = !isLayerLocked(clicked);
    updateObjects(
      targetIds.map((tid) => ({ id: tid, patch: { locked: nextLocked ? true : undefined } })),
      nextLocked ? "Lock layers" : "Unlock layers",
    );
  };

  // P1-5: レイヤードラッグ並べ替え。objects は zOrder 降順表示なので、
  // 並べ替え後に「最上段=最大 zOrder」となるよう zOrder を再採番する。
  const handleLayerDrop = (dropIdx: number) => {
    const drag = layerDragRef.current;
    if (drag === null || drag.dragIdx === dropIdx) {
      layerDragRef.current = null;
      layerDragIdRef.current = null;
      setLayerDrag(null);
      return;
    }
    const reordered = [...objects];
    const dragged = reordered.splice(drag.dragIdx, 1)[0];
    if (!dragged || isLayerLocked(dragged)) {
      layerDragRef.current = null;
      layerDragIdRef.current = null;
      setLayerDrag(null);
      return;
    }
    const actualDrop = drag.dragIdx < dropIdx ? dropIdx - 1 : dropIdx;
    reordered.splice(actualDrop, 0, dragged);
    // 表示は降順なので index 0(最上段) に最大 zOrder を割り当てる。
    const n = reordered.length;
    const patches = reordered
      .map((obj, i) => ({ id: obj.id, newZ: n - i, origZ: obj.zOrder }))
      .filter(({ newZ, origZ }) => newZ !== origZ)
      .map(({ id, newZ }) => ({ id, patch: { zOrder: newZ } as Partial<SceneObject> }));
    if (patches.length > 0) updateObjects(patches, "Reorder layers");
    layerDragRef.current = null;
    layerDragIdRef.current = null;
    setLayerDrag(null);
  };

  // P1-6: レイヤーバーの trim/slide ドラッグ（パネル管理）。
  // 掴んだレイヤーが複数選択に含まれていれば選択全体を、そうでなければ単独で動かす。
  const beginLayerBarDrag = (grabbedId: string, mode: "in" | "out" | "move", e: React.MouseEvent) => {
    e.stopPropagation();
    const ids = selectedIds.includes(grabbedId) && selectedIds.length > 1 ? [...selectedIds] : [grabbedId];
    const idSet = new Set(ids);
    const moving = objects.filter((o) => idSet.has(o.id) && !isLayerLocked(o));
    if (moving.length === 0) return;
    const grabbed = moving.find((o) => o.id === grabbedId) ?? moving[0]!;
    const repEdge = mode === "out" ? grabbed.outPoint : grabbed.inPoint;
    // 全 moving で delta 範囲を制限
    let minD = -Infinity;
    let maxD = Infinity;
    for (const o of moving) {
      if (mode === "move") { minD = Math.max(minD, -o.inPoint); maxD = Math.min(maxD, duration - o.outPoint); }
      else if (mode === "in") { minD = Math.max(minD, -o.inPoint); maxD = Math.min(maxD, (o.outPoint - 1) - o.inPoint); }
      else { minD = Math.max(minD, (o.inPoint + 1) - o.outPoint); maxD = Math.min(maxD, duration - o.outPoint); }
    }
    const origin = pxToFrame(e.clientX);
    let last = 0;
    const move = (ev: MouseEvent) => {
      let d = pxToFrame(ev.clientX) - origin;
      // P1-8: 代表エッジをスナップ → delta に逆算
      const snapped = snapFrame(repEdge + d, repEdge);
      d = snapped - repEdge;
      d = Math.max(minD, Math.min(maxD, d));
      last = d;
      setBarDrag({ ids: idSet, mode, delta: d });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setBarDrag(null);
      commitLayerBarDrag(moving, mode, last);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const commitLayerBarDrag = (moving: SceneObject[], mode: "in" | "out" | "move", delta: number) => {
    if (delta === 0) return;
    const patches = moving.map((o) => {
      const nin = mode === "out" ? o.inPoint : o.inPoint + delta;
      const nout = mode === "in" ? o.outPoint : o.outPoint + delta;
      const patch: Partial<SceneObject> = { inPoint: nin, outPoint: nout };
      if (mode === "in") {
        const next = shiftFootageSourceOffset(o.components, delta);
        if (next) patch.components = next;
      } else if (mode === "move") {
        Object.assign(patch, shiftObjectKeyframes(o, delta));
      }
      return { id: o.id, patch };
    });
    updateObjects(patches, mode === "move" ? "Slide layer(s)" : "Trim layer(s)");
  };

  // §22 グラフエディタ: propPath が指すプロパティを丸ごと差し替える（1 command）。
  const setPropByPath = (objId: string, propPath: PropPath, next: AnimatedProp<unknown>, label: string) => {
    const obj = objects.find((o) => o.id === objId);
    if (!obj) return;
    const patch: Partial<SceneObject> = {};
    if (propPath === "opacity") {
      patch.opacity = next as AnimatedProp<number>;
    } else if (propPath.startsWith("transform.")) {
      const k = propPath.slice("transform.".length) as TransformVecKey;
      patch.transform = { ...obj.transform, [k]: next as AnimatedProp<Vec3> };
    } else if (propPath.startsWith("comp_")) {
      const rest = propPath.slice(5);
      const sep = rest.indexOf("_");
      const idx = Number(rest.slice(0, sep));
      const key = rest.slice(sep + 1);
      patch.components = obj.components.map((c, i) => i === idx ? { ...c, props: { ...c.props, [key]: next } } : c);
    } else if (propPath.startsWith("effects.")) {
      const rest = propPath.slice("effects.".length);
      const dot = rest.indexOf(".");
      if (dot < 0) return;
      const effectId = rest.slice(0, dot);
      const key = rest.slice(dot + 1);
      patch.effects = (obj.effects ?? []).map((e) =>
        e.id === effectId ? { ...e, props: { ...e.props, [key]: next } } : e,
      );
    } else if (propPath.startsWith("expressionPresets.")) {
      const rest = propPath.slice("expressionPresets.".length);
      const dot = rest.indexOf(".");
      if (dot < 0) return;
      const instanceId = rest.slice(0, dot);
      const key = rest.slice(dot + 1);
      patch.expressionPresets = (obj.expressionPresets ?? []).map((p) =>
        p.id === instanceId ? { ...p, props: { ...p.props, [key]: next } } : p,
      );
    } else return;
    updateObject(objId, patch, label);
  };

  const handleSetParent = (sourceObjId: string, newParentId: string | null) => {
    if (!comp) return;
    const targetIds = selectedIds.includes(sourceObjId) ? selectedIds : [sourceObjId];
    const patches: { id: string; patch: Partial<SceneObject> }[] = [];
    let rejected = 0;
    for (const id of targetIds) {
      const obj = comp.objects.find((o) => o.id === id);
      if (!obj) continue;
      if (!isValidParent(comp.objects, id, newParentId)) {
        rejected += 1;
        continue;
      }
      const patch = buildReparentPatch(comp, obj, newParentId, frame);
      if (!patch) continue;
      patches.push({ id, patch });
    }
    if (patches.length > 0) {
      updateObjects(patches, "Set parent");
    }
    if (rejected > 0) {
      flashStatus("Cannot set parent: would create cycle");
    }
  };

  // P0-3: KF 右クリックでコンテキストメニュー（汎用基盤へ移行）。
  const handleKfRightClick = (key: string, x: number, y: number) => {
    // 右クリック対象の KF を確定（未選択なら単独選択）。メニュー項目のクロージャは
    // この時点のキー集合を明示的に保持する（後続の re-render を待たない）。
    const targetKeys = selectedKfs.has(key) ? new Set(selectedKfs) : new Set([key]);
    if (!selectedKfs.has(key)) setSelectedKfKeys([key]);
    const easingMenu: { label: string; easing: Easing }[] = [
      { label: "Linear          (Ctrl+F9)", easing: { type: "linear" } as Easing },
      { label: "Easy Ease            (F9)", easing: EASY_EASE },
      { label: "Ease In", easing: EASE_IN },
      { label: "Ease Out", easing: EASE_OUT },
      { label: "Hold         (Shift+F9)", easing: { type: "hold" } as Easing },
    ];
    const items: ContextMenuItem[] = easingMenu.map(({ label, easing }) => ({
      kind: "action",
      label,
      icon: (
        <span style={{ display: "inline-block", width: 10, height: 10, background: easingColor(easing), borderRadius: easing.type === "hold" ? 0 : "50%" }} />
      ),
      onSelect: () => applyEasingToSelectedKfs(easing, targetKeys),
    }));
    openContextMenu(x, y, items);
  };

  // §21.5 ラバーバンド選択。
  const onRowsMouseDown = (e: React.MouseEvent) => {
    dragMovedRef.current = false;
    if (e.button !== 0) return;
    const g = graphRef.current?.getBoundingClientRect();
    if (!g || e.clientX < g.left) return;
    e.preventDefault();
    const base = e.shiftKey ? new Set(selectedKfs) : new Set<string>();
    const x0 = e.clientX;
    const y0 = e.clientY;
    setSelectedKfKeys([...base]);
    setBox({ x0, y0, x1: x0, y1: y0 });
    const move = (ev: MouseEvent) => {
      dragMovedRef.current = true;
      const b: SelectBox = { x0, y0, x1: ev.clientX, y1: ev.clientY };
      setBox(b);
      setSelectedKfKeys([...hitTestBox(b, base)]);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setBox(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const hitTestBox = (b: SelectBox, base: Set<string>): Set<string> => {
    const container = rowsRef.current;
    if (!container) return base;
    const minX = Math.min(b.x0, b.x1), maxX = Math.max(b.x0, b.x1);
    const minY = Math.min(b.y0, b.y1), maxY = Math.max(b.y0, b.y1);
    const next = new Set(base);
    container.querySelectorAll<HTMLElement>("[data-kf-key]").forEach((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) {
        const k = el.getAttribute("data-kf-key");
        if (k) next.add(k);
      }
    });
    return next;
  };

  // プレイヘッドドラッグ
  const startScrub = (e: React.MouseEvent) => {
    const scrubStart = frame;
    // フィードバックループ G8: ruler scrub の方向反転検知（scrub_oscillation）用。
    let lastScrubFrame = scrubStart;
    const applyScrubFrame = (next: number) => {
      const delta = next - lastScrubFrame;
      if (delta !== 0) feedbackCollector.onScrubFrame(delta);
      lastScrubFrame = next;
      setFrame(next);
    };
    applyScrubFrame(snapFrame(pxToFrame(e.clientX), scrubStart));
    const move = (ev: MouseEvent) => applyScrubFrame(snapFrame(pxToFrame(ev.clientX), scrubStart));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // P0-1: ホイールでズーム（Ctrl）・パン（Shift）。ref パターンで stale closure を回避。
  const wheelHandlerRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelHandlerRef.current = (e: WheelEvent) => {
    const graphEl = graphRef.current;
    if (!graphEl) return;
    const graphRect = graphEl.getBoundingClientRect();
    if (e.clientX < graphRect.left) return; // ラベル列では無視

    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const ratio = Math.max(0, Math.min(1, (e.clientX - graphRect.left) / graphRect.width));
      const span = viewRange.end - viewRange.start;
      const mouseFrame = viewRange.start + ratio * span;
      const factor = e.deltaY > 0 ? 1.3 : 1 / 1.3;
      const newSpan = Math.round(Math.max(5, Math.min(duration, span * factor)));
      const newStart = Math.round(Math.max(0, mouseFrame - ratio * newSpan));
      const newEnd = Math.round(Math.min(duration, newStart + newSpan));
      setViewRange({ start: newStart, end: newEnd });
    } else if (e.shiftKey) {
      e.preventDefault();
      const span = viewRange.end - viewRange.start;
      const panDelta = Math.round(e.deltaY * span / 300);
      const newStart = Math.max(0, Math.min(duration - span, viewRange.start + panDelta));
      setViewRange({ start: newStart, end: newStart + span });
    }
    // else: 縦スクロールは rows コンテナのデフォルト動作に任せる
  };

  useEffect(() => {
    const el = timelineContainerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => wheelHandlerRef.current(e);
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // P0-2/P0-4/P0-3: 統合キーボードハンドラ（ref パターン）。
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    const inInput = !!(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable));

    if (!inInput) {
      const {
        project,
        currentCompId,
        currentFrame,
        selectedObjectIds,
        setFrame: setStoreFrame,
        togglePlay: storeTogglePlay,
      } = useEditorStore.getState();
      const comp = currentTimelineComp(project, currentCompId);
      const compDuration = comp?.duration ?? duration;
      const compObjects = [...(comp?.objects ?? [])].sort((a, b) => b.zOrder - a.zOrder);

      // P0-2: Space = 再生/停止
      if (e.code === "Space") { e.preventDefault(); storeTogglePlay(); return; }

      // §21: Escape = レイヤー選択解除（Composition インスペクター表示）
      if (e.key === "Escape" && selectedObjectIds.length > 0) {
        e.preventDefault();
        useEditorStore.getState().selectObjects([]);
        return;
      }

      // P0-4: フレームナビゲーション（store 正本 — ref ハンドラの stale closure を避ける）
      if (e.key === "ArrowLeft")  { e.preventDefault(); setStoreFrame(Math.max(0, currentFrame - (e.shiftKey ? 10 : 1))); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); setStoreFrame(Math.min(compDuration, currentFrame + (e.shiftKey ? 10 : 1))); return; }
      if (e.key === "Home") { e.preventDefault(); setStoreFrame(0); return; }
      if (e.key === "End")  { e.preventDefault(); setStoreFrame(compDuration); return; }

      const bareLetter = !e.ctrlKey && !e.metaKey && !e.altKey;

      // §28.8 ワークエリア（AE: B/N, [/]）
      if (bareLetter && (e.code === "KeyB" || e.key === "b" || e.key === "B")) {
        e.preventDefault();
        useEditorStore.getState().setWorkAreaIn();
        return;
      }
      if (bareLetter && (e.code === "KeyN" || e.key === "n" || e.key === "N")) {
        e.preventDefault();
        useEditorStore.getState().setWorkAreaOut();
        return;
      }
      if (e.key === "[") {
        e.preventDefault();
        if (comp) setStoreFrame(loadWorkArea(comp.id, comp.duration).inPoint);
        return;
      }
      if (e.key === "]") {
        e.preventDefault();
        if (comp) setStoreFrame(Math.max(0, loadWorkArea(comp.id, comp.duration).outPoint - 1));
        return;
      }

      // J/K: 前後 KF ジャンプ（AE 準拠）。
      // e.code（物理キー）でも判定 → IME 入力中（e.key="Process"）やレイアウト差でも効く。
      // Ctrl/Cmd/Alt 併用時はコピペ等と衝突しないよう無視。
      if (bareLetter && (e.code === "KeyJ" || e.key === "j" || e.key === "J")) {
        e.preventDefault();
        const frames = collectKfFrames(compObjects, selectedObjectIds);
        const prev = [...frames].filter((f) => f < currentFrame).pop();
        if (prev !== undefined) setStoreFrame(prev);
        return;
      }
      if (bareLetter && (e.code === "KeyK" || e.key === "k" || e.key === "K")) {
        e.preventDefault();
        const frames = collectKfFrames(compObjects, selectedObjectIds);
        const next = frames.find((f) => f > currentFrame);
        if (next !== undefined) setStoreFrame(next);
        return;
      }

      // P0-3: F9 = イージング変更（選択 KF）
      if (e.key === "F9") {
        e.preventDefault();
        const easing = e.shiftKey
          ? ({ type: "hold" } as Easing)
          : (e.ctrlKey || e.metaKey)
          ? ({ type: "linear" } as Easing)
          : EASY_EASE;
        applyEasingToSelectedKfs(easing);
        return;
      }

      // P0-1: \ = ビューをリセット（fit all）。JIS では ¥ キー（IntlBackslash）も同物理キー。
      const isFitViewKey =
        e.key === "\\" || e.key === "|" || e.key === "¥" ||
        e.code === "Backslash" || e.code === "IntlBackslash";
      if (isFitViewKey) {
        e.preventDefault();
        setViewRange({ start: 0, end: compDuration });
        return;
      }

      // P1-9: Cmd/Ctrl+C でコピー（AE 同様: KF 選択中は KF を / それ以外は選択レイヤーを）
      if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
        if (selectedKfs.size > 0) {
          e.preventDefault();
          // WIP: コピペ通知は上部ツールバーのレイアウトを分厚くするため一時無効。後でどうにかする必要がある。
          copySelectedKfsToClipboard();
          // flashStatus(`📋 ${copySelectedKfsToClipboard()} キーフレームをコピー`);
          return;
        }
        if (selectedIds.length > 0) {
          e.preventDefault();
          // WIP: コピペ通知は上部ツールバーのレイアウトを分厚くするため一時無効。後でどうにかする必要がある。
          copySelectedLayersToClipboard();
          // flashStatus(`📋 ${copySelectedLayersToClipboard()} レイヤーをコピー`);
          return;
        }
        return;
      }

      // P1-9: Cmd/Ctrl+X でカット（コピー + 削除）
      if ((e.ctrlKey || e.metaKey) && (e.key === "x" || e.key === "X")) {
        if (selectedKfs.size > 0) {
          e.preventDefault();
          copySelectedKfsToClipboard();
          applyMultiKfDelete(selectedKfs);
          // WIP: コピペ通知は上部ツールバーのレイアウトを分厚くするため一時無効。後でどうにかする必要がある。
          // flashStatus(`✂ ${copySelectedKfsToClipboard()} キーフレームをカット`);
          return;
        }
        if (selectedIds.length > 0) {
          e.preventDefault();
          copySelectedLayersToClipboard();
          removeObjects(selectedIds);
          // WIP: コピペ通知は上部ツールバーのレイアウトを分厚くするため一時無効。後でどうにかする必要がある。
          // flashStatus(`✂ ${copySelectedLayersToClipboard()} レイヤーをカット`);
          return;
        }
        return;
      }

      // P1-9: Cmd/Ctrl+V でペースト（現フレーム位置へ。クリップボードの種別で分岐）
      if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) {
        const clip = clipboardRef.current;
        if (!clip) return;
        e.preventDefault();
        if (clip.kind === "layers") pasteLayersAtPlayhead();
        else pasteKfsAtPlayhead();
        return;
      }

      // KF 削除 → 無ければ選択レイヤー削除（P1-6: 一括削除, 1 undo）
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedKfs.size > 0) { e.preventDefault(); applyMultiKfDelete(selectedKfs); return; }
        if (selectedIds.length > 0) { e.preventDefault(); removeObjects(selectedIds); return; }
      }

      // §21.6 U / UU キー（e.code でも判定 = IME/レイアウト耐性）
      if (bareLetter && (e.code === "KeyU" || e.key === "u" || e.key === "U")) {
        if (selectedIds.length === 0) return;
        e.preventDefault();
        const now = Date.now();
        const isUU = now - lastUPressRef.current < 300;
        lastUPressRef.current = now;
        const target: ExpandMode = isUU ? "uu" : "kf";
        setExpandMode((prev) => {
          const next = new Map(prev);
          for (const id of selectedIds) {
            if (next.get(id) === target) next.delete(id);
            else next.set(id, target);
          }
          return next;
        });
      }
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div ref={timelineContainerRef} style={{ display: "flex", flexDirection: "column", height: "100%", background: "#1c1c1c", color: "#ccc", fontSize: 12, userSelect: "none" }}>
      {/* toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", background: "#222", borderBottom: "1px solid #333", flexShrink: 0 }}>
        {/* P0-2: 再生ボタン */}
        <button onClick={togglePlay} style={{ ...btnStyle, width: 30, height: 22, padding: 0, fontSize: 12, display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 1, boxSizing: "border-box", alignSelf: "center" }} title="再生/停止 (Space)">{isPlaying ? "⏸" : "▶"}</button>
        <button onClick={() => setFrame(0)} style={btnStyle} title="先頭へ (Home)">⏮</button>
        <span style={{ color: "#888" }}>Timeline</span>
        {comp && <span style={{ color: "#9bd", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>· {comp.name}</span>}
        {/* §21.1 SMPTE timecode */}
        <span data-testid="tl-timecode" style={{ color: "#7fb8f0", fontVariantNumeric: "tabular-nums", fontWeight: 600, marginLeft: 4 }}>
          {formatTimeWithBeat(frame, fps, bpm, beatsPerBar)}
        </span>
        <span style={{ color: "#555", fontSize: 10 }}>({fps.toFixed(2)} fps)</span>
        <div style={{ width: 8 }} />
        <button onClick={() => { const id = addSolid(); if (id) selectObjects([id]); }} disabled={!comp} style={btnStyle}>+ Solid</button>
        <button onClick={() => { const id = addShape(); if (id) selectObjects([id]); }} disabled={!comp} style={btnStyle}>+ Shape</button>
        <button onClick={() => { const id = addText(); if (id) selectObjects([id]); }} disabled={!comp} style={btnStyle}>+ Text</button>
        <button onClick={() => { const id = addAdjustmentLayer(); if (id) selectObjects([id]); }} disabled={!comp} style={{ ...btnStyle, color: "#c9a227" }} title="調整レイヤーを追加">+ Adj</button>
        <button onClick={() => { const id = addNullLayer(); if (id) selectObjects([id]); }} disabled={!comp} style={{ ...btnStyle, color: "#e07070" }} title="Null レイヤーを追加">+ Null</button>
        <button onClick={() => { const id = addCamera(); if (id) selectObjects([id]); }} disabled={!comp} style={{ ...btnStyle, color: "#7fb8f0" }} title="カメラを追加（§6.5b）">+ Cam</button>
        {comp && (
          <>
            <select
              value={previewCamera ?? ""}
              onChange={(e) =>
                setPreviewCamera(e.target.value === "" ? null : e.target.value)
              }
              title="プレビュー視点（§6.5・AE の 3D View 相当）。出力カメラは常にその時刻で最前面の可視カメラ。これは表示視点だけを変え、export には影響しない。"
              style={{ ...btnStyle, fontSize: 10, padding: "1px 4px", color: previewCamera ? "#f0c060" : "#7fb8f0" }}
            >
              <option value="">View: Active Camera</option>
              {objects.filter((o) => o.components.some((c) => c.type === "camera")).map((o) => (
                <option key={o.id} value={o.id}>View: {o.name}</option>
              ))}
              <option value="default">View: Default (no camera)</option>
            </select>
            <select
              value={comp.renderer3d ?? "classic"}
              onChange={(e) => setCompRenderer3d(e.target.value as "classic" | "advanced")}
              title="3D レンダラー（§5.4b）— classic=DOM疑似3D / advanced=raster3d(GL, Phase2)"
              style={{ ...btnStyle, fontSize: 10, padding: "1px 4px", color: "#7fd0a8" }}
            >
              <option value="classic">3D: Classic</option>
              <option value="advanced">3D: Advanced</option>
            </select>
          </>
        )}
        <div style={{ flex: 1 }} />
        {/* P1-8: スナップトグル */}
        <button
          onClick={() => setSnapEnabled((v) => !v)}
          style={{ ...btnStyle, fontSize: 10, padding: "1px 5px", background: snapEnabled ? "#3a5a3a" : "#333", color: snapEnabled ? "#8d8" : "#ccc" }}
          title={`スナップ ${snapEnabled ? "ON" : "OFF"} — 秒単位に吸着`}
        >⊡</button>
        {/* §22 グラフエディタトグル */}
        <button
          onClick={() => setGraphMode((v) => !v)}
          style={{ ...btnStyle, fontSize: 10, padding: "1px 5px", background: graphMode ? "#3a4a5a" : "#333", color: graphMode ? "#8cf" : "#ccc" }}
          title={`グラフエディタ ${graphMode ? "ON" : "OFF"} — 値カーブを編集（展開中のプロパティ）`}
        >📈</button>
        {/* §11.5.1 波形表示モード（raw → donshari → transient を循環） */}
        <button
          onClick={() => {
            const order: WaveformMode[] = ["raw", "donshari", "transient"];
            const next = order[(order.indexOf(waveformMode) + 1) % order.length] ?? "transient";
            setWaveformMode(next);
          }}
          style={{ ...btnStyle, fontSize: 10, padding: "1px 5px", color: "#9cc8ff" }}
          title={`波形表示モード: ${waveformMode}（クリックで切替: raw→donshari→transient）`}
        >〰 {waveformMode === "raw" ? "RAW" : waveformMode === "donshari" ? "DON" : "TRN"}</button>
        {/* P0-1: ズームリセット */}
        <button
          onClick={() => setViewRange({ start: 0, end: duration })}
          style={{ ...btnStyle, fontSize: 10, padding: "1px 5px" }}
          title="ビューを全尺表示 (\ / ¥ キー)"
        >fit</button>
        <span style={{ color: "#555", fontVariantNumeric: "tabular-nums" }} title={`F${frame} / ${duration}`}>{formatTimeWithBeat(frame, fps, bpm, beatsPerBar)} / {formatTimeWithBeat(duration, fps, bpm, beatsPerBar)}</span>
        {/* WIP: コピペ通知は上部ツールバーのレイアウトを分厚くするため一時無効。後でどうにかする必要がある。
        {statusMsg && <span style={{ color: "#8d8", fontSize: 10, marginLeft: 4 }}>{statusMsg}</span>}
        */}
      </div>

      {/* rows — ruler is sticky first-child so it shares the scroll container's content width with layer rows.
           This ensures the graph column widths match and the playhead cursor aligns correctly when zoomed. */}
      <div
        ref={rowsRef}
        onMouseDown={onRowsMouseDown}
        onDragOver={(e) => {
          const t = [...e.dataTransfer.types];
          if (t.includes("text/x-layer-drag")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            return;
          }
          if (t.includes(DRAG_MIME) || t.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDropActive(true); }
        }}
        onDragLeave={(e) => { const rt = e.relatedTarget as Node | null; if (!rt || !rowsRef.current?.contains(rt)) setDropActive(false); }}
        onDrop={onTimelineDrop}
        style={{ flex: 1, overflowY: "auto", overflowX: "hidden", position: "relative", outline: dropActive ? "2px solid #5a8fd0" : "none", outlineOffset: -2 }}
      >
        {/* time ruler — sticky so it stays visible while layers scroll */}
        <div style={{ position: "sticky", top: 0, zIndex: 10, display: "flex", flexShrink: 0, borderBottom: "1px solid #2a2a2a", background: "#202020" }}>
          <div
            style={{ width: LABEL_W, boxSizing: "border-box", flexShrink: 0, borderRight: "1px solid #333", cursor: "default" }}
            onMouseDown={(e) => {
              e.stopPropagation();
              if (selectedIds.length > 0) selectObjects([]);
            }}
            title="クリックでレイヤー選択解除"
          />
          <div
            ref={graphRef}
            style={{ position: "relative", flex: 1, height: 22, cursor: "pointer", overflow: "hidden" }}
            onMouseDown={(e) => { e.stopPropagation(); startScrub(e); }}
          >
            <WorkAreaBar workArea={workArea} duration={duration} frameToPercent={frameToPercent} />
            <PreviewCacheBar cachedFrames={cachedFrames} viewRange={viewRange} duration={duration} frameToPercent={frameToPercent} />
            <Ruler viewRange={viewRange} duration={duration} fps={fps} bpm={bpm} beatsPerBar={beatsPerBar} frameToPercent={frameToPercent} />
            <Playhead frame={frame} frameToPercent={frameToPercent} />
          </div>
        </div>
        {objects.length === 0 && (
          <div style={{ padding: 16, color: "#444", textAlign: "center" }}>
            No layers — add one with + Solid / + Text above
          </div>
        )}
        {objects.map((obj, i) => (
          <LayerRow
            key={obj.id}
            obj={obj}
            index={i + 1}
            arrayIdx={i}
            duration={duration}
            frame={frame}
            selected={selectedIds.includes(obj.id)}
            expandMode={expandMode.get(obj.id)}
            graphRef={graphRef}
            selectedKfs={selectedKfs}
            kfDrag={kfDrag}
            isDropTarget={layerDrag !== null && layerDrag.dropIdx === i}
            barDrag={barDrag && barDrag.ids.has(obj.id) ? { mode: barDrag.mode, delta: barDrag.delta } : null}
            graphMode={graphMode}
            viewRange={viewRange}
            cachedLocalFrames={cachedLayerFrames.get(obj.id)}
            cachedPrecompFrames={cachedPrecompFrames}
            onSetProp={setPropByPath}
            beginKfDrag={beginKfDrag}
            beginLayerBarDrag={beginLayerBarDrag}
            onKfRightClick={handleKfRightClick}
            onToggleExpand={() => toggleExpand(obj.id)}
            onSelectLayer={(e) => handleLayerSelect(obj.id, e)}
            onRemove={() => removeObject(obj.id)}
            onUpdate={updateObject}
            onRename={(name) => renameObject(obj.id, name)}
            labelTargetIds={selectedIds.includes(obj.id) && selectedIds.length > 1 ? selectedIds : [obj.id]}
            onSetLabelIndex={setLayerLabelIndex}
            onSetParent={handleSetParent}
            onToggleLayersLock={handleToggleLayersLock}
            allObjects={objects}
            activeCameraId={autoActiveCameraId}
            onPreviewPatch={(id, patch) => setPreviewOverride({ objectId: id, patch })}
            frameToPercent={frameToPercent}
            sourceExtent={project ? getLayerSourceExtent(obj, project, fps) : null}
            audio={project ? getAudioLayerInfo(obj, project, getLayerSourceExtent(obj, project, fps)) : null}
            waveformMode={waveformMode}
            fps={fps}
            getFs={getFs}
            onLayerDragStart={() => {
              if (isLayerLocked(obj)) return;
              layerDragIdRef.current = obj.id;
              layerDragRef.current = { dragIdx: i, dropIdx: i };
              setLayerDrag(layerDragRef.current);
            }}
            onLayerDragOver={() => {
              if (layerDragRef.current === null) return;
              layerDragRef.current = { ...layerDragRef.current, dropIdx: i };
              setLayerDrag(layerDragRef.current);
            }}
            onLayerDrop={() => handleLayerDrop(i)}
            onLayerDragEnd={() => {
              layerDragIdRef.current = null;
              layerDragRef.current = null;
              setLayerDrag(null);
            }}
          />
        ))}
        {/* §21.5 ラバーバンド選択の矩形 */}
        {box && (() => {
          const rc = rowsRef.current;
          if (!rc) return null;
          const cr = rc.getBoundingClientRect();
          const left = Math.min(box.x0, box.x1) - cr.left + rc.scrollLeft;
          const top = Math.min(box.y0, box.y1) - cr.top + rc.scrollTop;
          const w = Math.abs(box.x1 - box.x0);
          const h = Math.abs(box.y1 - box.y0);
          return (
            <div style={{ position: "absolute", left, top, width: w, height: h, border: "1px solid #5a8fd0", background: "rgba(90,143,208,0.15)", pointerEvents: "none", zIndex: 6 }} />
          );
        })()}
      </div>

      {/* P0-1: ズーム/スクロールバー */}
      <TimelineScrollbar
        viewRange={viewRange}
        duration={duration}
        onViewChange={setViewRange}
      />
    </div>
  );
}

// P0-1: タイムライン下部のズーム/スクロールバー。
// サム幅 = 現在の表示フレーム / 全フレーム。サム位置 = viewRange.start / duration。
// サム本体ドラッグ = パン、端ドラッグ = ズーム（リサイズ）。
function TimelineScrollbar({
  viewRange,
  duration,
  onViewChange,
}: {
  viewRange: { start: number; end: number };
  duration: number;
  onViewChange: (v: { start: number; end: number }) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  const thumbLeft  = (viewRange.start / duration) * 100;
  const thumbWidth = ((viewRange.end - viewRange.start) / duration) * 100;

  const span = viewRange.end - viewRange.start;

  // トラック上の clientX → frame
  const clientXToFrame = (clientX: number): number => {
    const t = trackRef.current;
    if (!t) return 0;
    const r = t.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration)));
  };

  // サム本体ドラッグ = パン
  const startPan = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const t = trackRef.current;
    if (!t) return;
    const trackW = t.getBoundingClientRect().width;
    const startX = e.clientX;
    const capturedStart = viewRange.start;
    const capturedSpan  = viewRange.end - viewRange.start;
    const move = (ev: MouseEvent) => {
      const delta = Math.round(((ev.clientX - startX) / trackW) * duration);
      const ns = Math.max(0, Math.min(duration - capturedSpan, capturedStart + delta));
      onViewChange({ start: ns, end: ns + capturedSpan });
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // 左端ドラッグ = 左境界を動かすズーム
  const startLeftResize = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const t = trackRef.current;
    if (!t) return;
    const trackW = t.getBoundingClientRect().width;
    const startX = e.clientX;
    const capturedStart = viewRange.start;
    const capturedEnd   = viewRange.end;
    const move = (ev: MouseEvent) => {
      const delta = Math.round(((ev.clientX - startX) / trackW) * duration);
      const ns = Math.max(0, Math.min(capturedEnd - 5, capturedStart + delta));
      onViewChange({ start: ns, end: capturedEnd });
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // 右端ドラッグ = 右境界を動かすズーム
  const startRightResize = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const t = trackRef.current;
    if (!t) return;
    const trackW = t.getBoundingClientRect().width;
    const startX = e.clientX;
    const capturedStart = viewRange.start;
    const capturedEnd   = viewRange.end;
    const move = (ev: MouseEvent) => {
      const delta = Math.round(((ev.clientX - startX) / trackW) * duration);
      const ne = Math.min(duration, Math.max(capturedStart + 5, capturedEnd + delta));
      onViewChange({ start: capturedStart, end: ne });
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // トラックの空白クリック = その位置へジャンプ（中心に合わせてパン）
  const onTrackClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement) !== trackRef.current) return; // サムのクリックは無視
    const f = clientXToFrame(e.clientX);
    const half = Math.round(span / 2);
    const ns = Math.max(0, Math.min(duration - span, f - half));
    onViewChange({ start: ns, end: ns + span });
  };

  const panStep = Math.max(1, Math.round(span * 0.1));
  const canLeft  = viewRange.start > 0;
  const canRight = viewRange.end < duration;

  return (
    <div style={{ display: "flex", alignItems: "center", height: 18, background: "#181818", borderTop: "1px solid #252525", flexShrink: 0, paddingRight: 4 }}>
      {/* ラベル列と揃える */}
      <div style={{ width: LABEL_W, flexShrink: 0 }} />
      {/* 左矢印 */}
      <button
        onMouseDown={(e) => { e.preventDefault(); if (canLeft) { const ns = Math.max(0, viewRange.start - panStep); onViewChange({ start: ns, end: ns + span }); } }}
        disabled={!canLeft}
        style={scrollArrowStyle}
        title="左へスクロール"
      >◀</button>
      {/* トラック */}
      <div
        ref={trackRef}
        onClick={onTrackClick}
        style={{ flex: 1, height: 8, background: "#282828", borderRadius: 4, position: "relative", cursor: "default", margin: "0 2px" }}
      >
        {/* サム */}
        <div
          style={{
            position: "absolute",
            left: `${thumbLeft}%`,
            width: `${Math.max(4, thumbWidth)}%`,
            height: "100%",
            background: "#4a6a8a",
            borderRadius: 4,
            display: "flex",
            alignItems: "stretch",
            cursor: "grab",
            minWidth: 8,
          }}
          onMouseDown={startPan}
        >
          {/* 左リサイズハンドル */}
          <div
            onMouseDown={startLeftResize}
            style={{ width: 5, cursor: "ew-resize", background: "#6a9ac4", borderRadius: "4px 0 0 4px", flexShrink: 0 }}
          />
          <div style={{ flex: 1 }} />
          {/* 右リサイズハンドル */}
          <div
            onMouseDown={startRightResize}
            style={{ width: 5, cursor: "ew-resize", background: "#6a9ac4", borderRadius: "0 4px 4px 0", flexShrink: 0 }}
          />
        </div>
      </div>
      {/* 右矢印 */}
      <button
        onMouseDown={(e) => { e.preventDefault(); if (canRight) { const ns = Math.min(duration - span, viewRange.start + panStep); onViewChange({ start: ns, end: ns + span }); } }}
        disabled={!canRight}
        style={scrollArrowStyle}
        title="右へスクロール"
      >▶</button>
    </div>
  );
}

const scrollArrowStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#666",
  cursor: "pointer",
  fontSize: 8,
  padding: "0 3px",
  lineHeight: 1,
  flexShrink: 0,
};

function WorkAreaBar({
  workArea,
  frameToPercent,
}: {
  workArea: { inPoint: number; outPoint: number };
  duration: number;
  frameToPercent: (f: number) => number;
}) {
  const left = frameToPercent(workArea.inPoint);
  const right = frameToPercent(workArea.outPoint);
  const width = Math.max(0, right - left);
  if (width <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: `${left}%`,
        width: `${width}%`,
        top: 0,
        height: "100%",
        background: "rgba(120,120,120,0.18)",
        borderLeft: "2px solid #888",
        borderRight: "2px solid #888",
        pointerEvents: "none",
        zIndex: 1,
      }}
    />
  );
}

function PreviewCacheBar({
  cachedFrames,
  viewRange,
  frameToPercent,
}: {
  cachedFrames: Set<number>;
  viewRange: { start: number; end: number };
  duration: number;
  frameToPercent: (f: number) => number;
}) {
  if (cachedFrames.size === 0) return null;
  const segments = framesToSegments(cachedFrames, viewRange, frameToPercent);
  return (
    <>
      {segments.map((seg, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: `${seg.left}%`,
            width: `${seg.width}%`,
            bottom: 0,
            height: 4,
            background: "#3a8f3a",
            pointerEvents: "none",
            zIndex: 2,
          }}
        />
      ))}
    </>
  );
}

/**
 * §28.10: レイヤーバー直上の per-layer 緑線。local frame を inPoint で comp 位置へ写像し、
 * [inPoint, outPoint) 内をバーのすぐ上（top:1, 高さ 2px）に緑表示。
 */
function LayerCacheLine({
  frames,
  mapToComp,
  inPoint,
  outPoint,
  viewRange,
  frameToPercent,
}: {
  frames: Set<number> | undefined;
  /** キャッシュキーのフレーム（local/child）→ comp(B) フレームへの写像（§28.10/§28.11）。 */
  mapToComp: (f: number) => number;
  inPoint: number;
  outPoint: number;
  viewRange: { start: number; end: number };
  frameToPercent: (f: number) => number;
}) {
  if (!frames || frames.size === 0) return null;
  const compFrames: number[] = [];
  for (const f of frames) {
    const cf = mapToComp(f);
    if (cf >= inPoint && cf < outPoint) compFrames.push(cf);
  }
  if (compFrames.length === 0) return null;
  const segments = framesToSegments(compFrames, viewRange, frameToPercent);
  return (
    <>
      {segments.map((seg, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: `${seg.left}%`,
            width: `${seg.width}%`,
            top: 1,
            height: 2,
            background: "#3a8f3a",
            pointerEvents: "none",
            zIndex: 2,
          }}
        />
      ))}
    </>
  );
}

interface AudioLayerDisplayInfo {
  assetId: string;
  path: string;
  sourceDurationFrames: number;
}

/** audio component を持つレイヤーの波形表示情報。なければ null。 */
function getAudioLayerInfo(obj: SceneObject, project: { assets: { id: string; path: string }[] }, sourceExtent: LayerSourceExtent | null): AudioLayerDisplayInfo | null {
  const cmp = obj.components.find((c) => c.type === "audio");
  if (!cmp) return null;
  const assetId = cmp.props["asset"];
  if (typeof assetId !== "string") return null;
  const asset = project.assets.find((a) => a.id === assetId);
  if (!asset) return null;
  const sourceDurationFrames = sourceExtent?.sourceDuration ?? Math.max(1, obj.outPoint - obj.inPoint);
  return { assetId, path: asset.path, sourceDurationFrames };
}

/**
 * §11.5.1 — オーディオレイヤーバー上の波形描画（Canvas）。
 * source の [trimStart, trimStart+可視尺) を [inPoint, outPoint) のバー範囲へマッピングする。
 */
function WaveformOverlay({ audio, mode, fps, getFs, inPoint, outPoint, trimStart, frameToPercent, selected }: {
  audio: AudioLayerDisplayInfo;
  mode: WaveformMode;
  fps: number;
  getFs: () => FileSystem;
  inPoint: number;
  outPoint: number;
  trimStart: number;
  frameToPercent: (f: number) => number;
  selected: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [audioData, setAudioData] = useState<{ channels: Float32Array[]; sampleRate: number } | null>(null);

  useEffect(() => {
    const have = peekAudioBuffer(audio.assetId);
    if (have) {
      const channels: Float32Array[] = [];
      for (let ch = 0; ch < have.numberOfChannels; ch++) channels.push(have.getChannelData(ch));
      setAudioData({ channels, sampleRate: have.sampleRate });
      return;
    }
    let cancelled = false;
    void loadAudioBuffer(audio.assetId, () => getFs().read(audio.path))
      .then((buf) => {
        if (cancelled || !buf) return;
        const channels: Float32Array[] = [];
        for (let ch = 0; ch < buf.numberOfChannels; ch++) channels.push(buf.getChannelData(ch));
        setAudioData({ channels, sampleRate: buf.sampleRate });
      })
      .catch(() => { /* decode 失敗時は無描画 */ });
    return () => { cancelled = true; };
  }, [audio.assetId, audio.path, getFs]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !audioData) return;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (W === 0 || H === 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const visDur = Math.max(1, outPoint - inPoint);
    const leftPx = (frameToPercent(inPoint) / 100) * W;
    const rightPx = (frameToPercent(outPoint) / 100) * W;
    const barW = rightPx - leftPx;
    if (barW <= 0) return;
    const srcStart = trimStart;
    const srcEnd = trimStart + visDur;
    const bucketCount = Math.max(1, Math.ceil(barW));
    const peaks = computePeaksForFrameRange(
      audioData.channels,
      audioData.sampleRate,
      fps,
      mode,
      srcStart,
      srcEnd,
      bucketCount,
    );
    const mid = H / 2;
    const amp = H / 2 - 1;
    ctx.fillStyle = selected ? "#9cc8ff" : "#6f9fd0";
    const x0 = Math.max(0, Math.floor(leftPx));
    const x1 = Math.min(W, Math.ceil(rightPx));
    for (let x = x0; x < x1; x++) {
      const frac = (x - leftPx) / barW;
      let b = Math.floor(frac * bucketCount);
      if (b < 0) b = 0;
      if (b >= bucketCount) b = bucketCount - 1;
      const yTop = mid - (peaks[b * 2 + 1] ?? 0) * amp;
      const yBot = mid - (peaks[b * 2] ?? 0) * amp;
      ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
    }
  }, [audioData, inPoint, outPoint, trimStart, frameToPercent, selected, fps, mode]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 1 }}
    />
  );
}

function Ruler({ viewRange, duration, fps, bpm, beatsPerBar, frameToPercent }: {
  viewRange: { start: number; end: number };
  duration: number;
  fps: number;
  bpm?: number;
  beatsPerBar?: number;
  frameToPercent: (f: number) => number;
}) {
  const viewSpan = viewRange.end - viewRange.start;
  // 適応的な目盛り間隔: 表示フレーム数から ~8 目盛りを目安に選択。
  const niceSteps = [1, 2, 3, 5, 10, 15, Math.round(fps / 2), Math.round(fps), Math.round(fps * 2), Math.round(fps * 5), Math.round(fps * 10), Math.round(fps * 30), Math.round(fps * 60)].filter((v, i, a) => v > 0 && a.indexOf(v) === i);
  const roughStep = Math.max(1, viewSpan / 8);
  const stepFrames = niceSteps.find((s) => s >= roughStep) ?? Math.round(fps * 60);

  const ticks: number[] = [];
  const firstTick = Math.ceil(viewRange.start / stepFrames) * stepFrames;
  for (let f = firstTick; f <= Math.min(viewRange.end, duration); f += stepFrames) ticks.push(f);

  // §21.1b: bpm 有効時はルーラーを上下二段にする（上＝タイムコード / 下＝Bar.Beat）。
  // 下段は拍に整列した独自目盛り（タイムコード間隔だと中途半端な拍値になるため）。表示のみ。
  const bpmActive = bpm !== undefined && bpm > 0;
  const beatTicks: { left: number; label: string; isBar: boolean }[] = [];
  if (bpmActive) {
    const f0 = Math.max(1, Math.round(fps));
    const bpb = Math.max(1, Math.round(beatsPerBar ?? 4));
    const framesPerBeat = (f0 * 60) / (bpm as number);
    // 拍ステップ候補: 1 拍 / 1 小節 / 数小節。表示幅から ~8 目盛りを目安に選ぶ。
    const beatCandidates = Array.from(
      new Set([1, 2, bpb, bpb * 2, bpb * 4, bpb * 8, bpb * 16]),
    ).filter((v) => v > 0).sort((a, b) => a - b);
    const viewSpanBeats = viewSpan / framesPerBeat;
    // 下段は上段タイムコードより細かく（~16 目盛り目安）。広い範囲でも拍/小節が読める。
    const roughBeatStep = Math.max(1, viewSpanBeats / 16);
    const stepBeats = beatCandidates.find((s) => s >= roughBeatStep) ?? bpb * 16;
    const maxFrame = Math.min(viewRange.end, duration);
    const firstBeat = Math.max(
      0,
      Math.ceil(viewRange.start / framesPerBeat / stepBeats) * stepBeats,
    );
    for (let b = firstBeat; b * framesPerBeat <= maxFrame + 1e-6; b += stepBeats) {
      const beatIndex = Math.round(b);
      const left = frameToPercent(beatIndex * framesPerBeat);
      if (left < 0 || left > 100) continue;
      const barNo = Math.floor(beatIndex / bpb) + 1;
      const beatNo = (beatIndex % bpb) + 1;
      beatTicks.push({ left, label: `${barNo}.${beatNo}`, isBar: beatNo === 1 });
    }
  }

  return (
    <>
      {ticks.map((f) => {
        const left = frameToPercent(f);
        if (left < 0 || left > 100) return null;
        return (
          <div key={f} style={{ position: "absolute", left: `${left}%`, top: 0, height: bpmActive ? "50%" : "100%", borderLeft: "1px solid #3a3a3a", pointerEvents: "none" }}>
            <span style={{ position: "absolute", left: 3, top: 1, fontSize: 9, color: "#777", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
              {framesToTimecode(f, fps)}
            </span>
          </div>
        );
      })}
      {bpmActive && (
        <>
          {/* 中央分割線 */}
          <div style={{ position: "absolute", left: 0, right: 0, top: "50%", borderTop: "1px solid #2f3a2f", pointerEvents: "none" }} />
          {/* 下段: Bar.Beat（小節頭は明色） */}
          {beatTicks.map((t, i) => (
            <div key={`bb-${i}`} style={{ position: "absolute", left: `${t.left}%`, top: "50%", height: "50%", borderLeft: `1px solid ${t.isBar ? "#4a6a4a" : "#33402f"}`, pointerEvents: "none" }}>
              <span style={{ position: "absolute", left: 3, bottom: 1, fontSize: 9, color: t.isBar ? "#7aa97a" : "#5d7a5d", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                {t.label}
              </span>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function Playhead({ frame, frameToPercent }: { frame: number; frameToPercent: (f: number) => number }) {
  const left = frameToPercent(frame);
  return (
    <div
      style={{
        position: "absolute",
        left: `${left}%`,
        top: 0,
        width: 1,
        height: "100%",
        background: "#f04",
        zIndex: 5,
        pointerEvents: "none",
      }}
    >
      <div style={{ position: "absolute", top: 0, left: -3, width: 7, height: 7, background: "#f04" }} />
    </div>
  );
}

function PlayheadTick({ frame, frameToPercent }: { frame: number; frameToPercent: (f: number) => number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: `${frameToPercent(frame)}%`,
        top: 0,
        width: 1,
        height: "100%",
        background: "#f04",
        pointerEvents: "none",
        zIndex: 4,
      }}
    />
  );
}

interface LayerRowProps {
  obj: SceneObject;
  index: number;
  arrayIdx: number;
  duration: number;
  frame: Frame;
  selected: boolean;
  expandMode: ExpandMode | undefined;
  graphRef: React.RefObject<HTMLDivElement | null>;
  selectedKfs: Set<string>;
  kfDrag: KfDragState | null;
  isDropTarget: boolean;
  barDrag: { mode: "in" | "out" | "move"; delta: number } | null;
  graphMode: boolean;
  viewRange: { start: number; end: number };
  cachedLocalFrames: Set<number> | undefined;
  cachedPrecompFrames: Map<string, Set<number>>;
  onSetProp: (objId: string, path: PropPath, next: AnimatedProp<unknown>, label: string) => void;
  beginKfDrag: (objId: string, path: PropPath, frame: number, e: React.MouseEvent) => void;
  beginLayerBarDrag: (objId: string, mode: "in" | "out" | "move", e: React.MouseEvent) => void;
  onKfRightClick: (key: string, x: number, y: number) => void;
  onToggleExpand: () => void;
  onSelectLayer: (e: React.MouseEvent) => void;
  onRemove: () => void;
  onUpdate: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  onRename: (name: string) => void;
  labelTargetIds: string[];
  onSetLabelIndex: (ids: string[], index: LabelIndex | undefined) => void;
  onToggleLayersLock: (clickedId: string, targetIds: string[]) => void;
  onSetParent: (sourceObjId: string, newParentId: string | null) => void;
  allObjects: SceneObject[];
  activeCameraId: string | null;
  onPreviewPatch?: (id: string, patch: Partial<SceneObject>) => void;
  frameToPercent: (f: number) => number;
  sourceExtent: LayerSourceExtent | null;
  audio: AudioLayerDisplayInfo | null;
  waveformMode: WaveformMode;
  fps: number;
  getFs: () => FileSystem;
  onLayerDragStart: () => void;
  onLayerDragOver: () => void;
  onLayerDrop: () => void;
  onLayerDragEnd: () => void;
}

function LabelColorPalette({
  anchorEl,
  current,
  onSelect,
  onClose,
}: {
  anchorEl: HTMLElement;
  current: LabelIndex | undefined;
  onSelect: (index: LabelIndex | undefined) => void;
  onClose: () => void;
}) {
  const paletteRef = useRef<HTMLDivElement>(null);
  const rect = anchorEl.getBoundingClientRect();

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (paletteRef.current?.contains(t) || anchorEl.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [anchorEl, onClose]);

  return (
    <div
      ref={paletteRef}
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.bottom + 2,
        zIndex: 10000,
        display: "grid",
        gridTemplateColumns: "repeat(8, 18px)",
        gap: 3,
        padding: 6,
        background: "#2a2a2a",
        border: "1px solid #555",
        borderRadius: 4,
        boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        title="ラベル色なし"
        onClick={() => { onSelect(undefined); onClose(); }}
        style={{
          width: 18,
          height: 18,
          padding: 0,
          border: current === undefined ? "2px solid #fff" : "1px solid #666",
          borderRadius: 2,
          background: "#3a3a3a",
          cursor: "pointer",
          fontSize: 8,
          color: "#aaa",
        }}
      >
        —
      </button>
      {LAYER_LABEL_COLORS.map((color, i) => (
        <button
          key={i}
          type="button"
          title={labelColorTitle(i)}
          onClick={() => { onSelect(i as LabelIndex); onClose(); }}
          style={{
            width: 18,
            height: 18,
            padding: 0,
            border: current === i ? "2px solid #fff" : "1px solid #444",
            borderRadius: 2,
            background: color,
            cursor: "pointer",
          }}
        />
      ))}
    </div>
  );
}

function LabelColorBar({
  labelIndex,
  onPick,
}: {
  labelIndex: LabelIndex | undefined;
  onPick: (index: LabelIndex | undefined) => void;
}) {
  const barRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const hasLabel = labelIndex !== undefined;

  return (
    <>
      <button
        ref={barRef}
        type="button"
        title="レイヤーラベル色（組織用。Solid の塗り色とは別）"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          flexShrink: 0,
          width: 12,
          alignSelf: "stretch",
          margin: 0,
          padding: 0,
          border: "none",
          borderRight: `1px solid ${hasLabel ? labelBarColor(labelIndex) : "#555"}`,
          boxShadow: hasLabel ? "inset 0 0 0 1px rgba(0,0,0,0.35)" : "inset 0 0 0 1px #666",
          background: labelBarColor(labelIndex),
          cursor: "pointer",
        }}
      />
      {open && barRef.current && (
        <LabelColorPalette
          anchorEl={barRef.current}
          current={labelIndex}
          onSelect={onPick}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ParentSelect({
  obj,
  candidates,
  onChange,
  disabled = false,
}: {
  obj: SceneObject;
  candidates: SceneObject[];
  onChange: (parentId: string | null) => void;
  disabled?: boolean;
}) {
  const currentName = obj.parent
    ? candidates.find((c) => c.id === obj.parent)?.name ?? obj.parent.slice(0, 6)
    : "None";
  return (
    <select
      value={obj.parent ?? ""}
      disabled={disabled}
      title={`Parent: ${currentName}`}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation();
        const v = e.target.value;
        onChange(v === "" ? null : v);
      }}
      style={{
        flexShrink: 0,
        width: 64,
        maxWidth: 64,
        fontSize: 10,
        padding: "0 2px",
        background: "#2a2a2a",
        color: "#aaa",
        border: "1px solid #444",
        borderRadius: 2,
        cursor: "pointer",
      }}
    >
      <option value="">None</option>
      {candidates.map((c) => (
        <option key={c.id} value={c.id}>{c.name}</option>
      ))}
    </select>
  );
}

function LayerRow(props: LayerRowProps) {
  const { obj, index, frame, selected, expandMode, selectedKfs, kfDrag, isDropTarget, barDrag, graphMode, viewRange, cachedLocalFrames, cachedPrecompFrames, sourceExtent, audio, waveformMode, fps, getFs, onSetProp, beginKfDrag, beginLayerBarDrag, onKfRightClick, onToggleExpand, onSelectLayer, onRemove, onUpdate, onRename, labelTargetIds, onSetLabelIndex, onToggleLayersLock, onSetParent, allObjects, activeCameraId, onPreviewPatch, frameToPercent, onLayerDragStart, onLayerDragOver, onLayerDrop, onLayerDragEnd } = props;
  const [renaming, setRenaming] = useState(false);
  const locked = isLayerLocked(obj);

  // レイヤー行の右クリックメニュー（汎用基盤の実例）。既存ストアアクションを再利用する。
  const openContextMenu = useContextMenuStore((s) => s.openContextMenu);
  const selectObjects = useEditorStore((s) => s.selectObjects);
  const selectedObjectIds = useEditorStore((s) => s.selectedObjectIds);
  const updateObjects = useEditorStore((s) => s.updateObjects);
  const duplicateSelected = useEditorStore((s) => s.duplicateSelected);
  const splitSelected = useEditorStore((s) => s.splitSelected);
  const removeObjects = useEditorStore((s) => s.removeObjects);

  const handleRowContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // 未選択行を右クリックしたら先に単独選択（AE 挙動）。ロック中は選択しない。
    if (!selected && !locked) selectObjects([obj.id]);
    if (!selected && locked) return;
    const targetIds = selected && selectedObjectIds.length > 0 ? selectedObjectIds : [obj.id];
    const multi = targetIds.length > 1;
    const items: ContextMenuItem[] = [
      { kind: "action", label: "名前を変更", disabled: multi || locked, onSelect: () => setRenaming(true) },
      { kind: "action", label: multi ? `複製 (${targetIds.length})` : "複製", shortcut: "Ctrl+D", onSelect: () => duplicateSelected() },
      { kind: "action", label: "レイヤーを分割", shortcut: "Ctrl+Shift+D", onSelect: () => splitSelected() },
      { kind: "separator" },
      { kind: "action", label: multi ? `削除 (${targetIds.length})` : "削除", danger: true, onSelect: () => removeObjects(targetIds) },
    ];
    openContextMenu(e.clientX, e.clientY, items);
  };
  // P1-6: バードラッグのプレビューはパネル管理の barDrag から導出（複数選択を一括移動するため）。
  const dDelta = barDrag ? barDrag.delta : 0;
  const inPoint = barDrag && barDrag.mode !== "out" ? obj.inPoint + dDelta : obj.inPoint;
  const outPoint = barDrag && barDrag.mode !== "in" ? obj.outPoint + dDelta : obj.outPoint;
  const kfPreviewShift = barDrag && barDrag.mode === "move" ? dDelta : 0;
  const trimStart = sourceExtent
    ? (barDrag && barDrag.mode === "in" ? Math.max(0, sourceExtent.trimStart + dDelta) : sourceExtent.trimStart)
    : 0;

  // §28.11: precomp（comp component）レイヤーの comp 単位キャッシュ緑線用。
  const precompCacheInfo = (() => {
    const cc = obj.components.find((c) => c.type === "comp");
    if (!cc) return null;
    const cid = cc.props["compId"];
    if (typeof cid !== "string" || cid === "") return null;
    const ts = cc.props["trimStart"];
    return { compId: cid, trimStart: typeof ts === "number" ? ts : 0 };
  })();

  const rowBg = labelRowTint(obj.labelIndex, selected) ?? (selected ? "#2a3a4a" : "transparent");
  const barFill = timelineBarFill(obj.labelIndex, selected);
  const visibilityTitle = locked
    ? (obj.enabled
      ? "表示中（ロック）— クリック: 非表示 / Shift+クリック: ロック解除 / 右クリック: 一括表示"
      : "非表示（ロック）— クリック: 表示 / Shift+クリック: ロック解除 / 右クリック: 一括表示")
    : (obj.enabled
      ? "表示中 — クリック: 非表示 / Shift+クリック: ロック / 右クリック: 一括表示"
      : "非表示 — クリック: 表示 / Shift+クリック: ロック / 右クリック: 一括表示");

  const handleVisibilityContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      {
        kind: "action",
        label: "すべて表示",
        onSelect: () => {
          const patches = unlockedVisibilityPatches(allObjects, true);
          if (patches.length > 0) updateObjects(patches, "Show all unlocked layers");
        },
      },
      {
        kind: "action",
        label: "すべて非表示",
        onSelect: () => {
          const patches = unlockedVisibilityPatches(allObjects, false);
          if (patches.length > 0) updateObjects(patches, "Hide all unlocked layers");
        },
      },
    ];
    openContextMenu(e.clientX, e.clientY, items);
  };

  const commitRename = (raw: string) => {
    setRenaming(false);
    const trimmed = raw.trim();
    if (trimmed && trimmed !== obj.name) onRename(trimmed);
  };

  return (
    <div
      style={{ borderBottom: "1px solid #222", borderTop: isDropTarget ? "2px solid #5a8fd0" : "none" }}
      onDragOver={(e) => {
        const t = [...e.dataTransfer.types];
        if (t.includes("text/x-layer-drag")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; onLayerDragOver(); return; }
        // DRAG_MIME / OS ファイルドロップは親 rowsRef にバブルさせつつここでも accept
        if (t.includes(DRAG_MIME) || t.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes("text/x-layer-drag")) { e.preventDefault(); e.stopPropagation(); onLayerDrop(); return; }
        // DRAG_MIME / OS ファイルは rowsRef の onDrop へバブルさせる（stopPropagation しない）
      }}
    >
      {/* layer header row */}
      <div style={{ display: "flex", alignItems: "stretch", background: rowBg, filter: locked ? "saturate(0.75)" : undefined }} onContextMenu={handleRowContextMenu}>
        {/* label column（幅は LABEL_W 固定。左端ストリップ = ラベル色） */}
        <div
          style={{ width: LABEL_W, boxSizing: "border-box", flexShrink: 0, display: "flex", alignItems: "stretch", borderRight: "1px solid #2a2a2a" }}
        >
          <LabelColorBar
            labelIndex={obj.labelIndex}
            onPick={(index) => onSetLabelIndex(labelTargetIds, index)}
          />
          <div
            style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4, padding: "3px 6px 3px 4px", cursor: "pointer" }}
            onClick={onSelectLayer}
          >
          {/* P1-5: ドラッグハンドル */}
          <span
            draggable={!locked}
            onDragStart={(e) => {
              if (locked) { e.preventDefault(); return; }
              e.dataTransfer.setData("text/x-layer-drag", obj.id);
              e.dataTransfer.setData("text/plain", obj.id);
              e.dataTransfer.effectAllowed = "move";
              onLayerDragStart();
            }}
            onDragEnd={onLayerDragEnd}
            onClick={(e) => e.stopPropagation()}
            style={{ color: locked ? "#444" : "#555", cursor: locked ? "not-allowed" : "grab", fontSize: 10, flexShrink: 0, lineHeight: 1 }}
            title={locked ? "ロック中 — 並べ替え不可" : "ドラッグでレイヤー順を変更"}
          >⋮⋮</span>
          <button onClick={(e) => { e.stopPropagation(); onToggleExpand(); }} style={caretStyle} title="プロパティを展開（U=KF / UU=変更済み）">
            {expandMode ? "▾" : "▸"}
          </button>
          <span style={{ color: "#666", width: 16, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{index}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (e.shiftKey) {
                onToggleLayersLock(obj.id, labelTargetIds);
              } else {
                onUpdate(obj.id, { enabled: !obj.enabled }, "Toggle visibility");
              }
            }}
            onContextMenu={handleVisibilityContextMenu}
            style={{ ...iconBtn, opacity: obj.enabled ? 1 : 0.35, position: "relative" }}
            title={visibilityTitle}
          >
            {obj.enabled ? "👁" : "—"}
            {locked && (
              <span style={{ position: "absolute", right: -1, bottom: -1, fontSize: 7, lineHeight: 1 }}>🔒</span>
            )}
          </button>
          {!obj.components.some((c) => c.type === "camera") && (
            <button
              onClick={(e) => { e.stopPropagation(); if (locked) return; onUpdate(obj.id, { threeD: obj.threeD ? undefined : true }, obj.threeD ? "Disable 3D layer" : "Enable 3D layer"); }}
              disabled={locked}
              style={{ ...iconBtn, fontSize: 9, fontWeight: 700, opacity: obj.threeD ? 1 : 0.4, color: obj.threeD ? "#7fd0a8" : "#888" }}
              title="3D レイヤー切替（§5.4b）"
            >
              3D
            </button>
          )}
          <SolidColorChip obj={obj} frame={frame} onUpdate={onUpdate} onPreviewPatch={onPreviewPatch} readOnly={locked} />
          {renaming ? (
            <input
              autoFocus
              defaultValue={obj.name}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => commitRename(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitRename(e.currentTarget.value);
                if (e.key === "Escape") setRenaming(false);
              }}
              style={{
                flex: 1,
                minWidth: 0,
                background: "#2a2a2a",
                border: "1px solid #4a8acf",
                color: "#fff",
                borderRadius: 3,
                padding: "1px 4px",
                fontSize: 11,
                userSelect: "text",
              }}
            />
          ) : (
          <span
            style={{ flex: 1, color: selected ? "#7fb8f0" : "#bbb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            onDoubleClick={(e) => { e.stopPropagation(); if (!locked) setRenaming(true); }}
            title="ダブルクリックで名前を変更"
          >
            {obj.name}
            {obj.isAdjustment && (
              <span style={{ marginLeft: 4, fontSize: 9, color: "#c9a227", fontWeight: 600 }}>
                {(obj.adjustmentMode ?? "live") === "raster" ? "ADJ·R" : "ADJ·L"}
              </span>
            )}
            {obj.isNull && (
              <span style={{ marginLeft: 4, fontSize: 9, color: "#e07070", fontWeight: 600 }}>NULL</span>
            )}
            {obj.trackMatteMode && (
              <span style={{ marginLeft: 4, fontSize: 9, color: "#c090e0", fontWeight: 600 }} title={`Track Matte: ${obj.trackMatteMode}`}>
                TrkMat
              </span>
            )}
            {resolveTrackMattePairs(allObjects).some((p) => p.matteId === obj.id) && (
              <span style={{ marginLeft: 4, fontSize: 9, color: "#a080c0", fontWeight: 600 }} title="直下レイヤーのトラックマット源（合成には出ない）">
                マット
              </span>
            )}
            {obj.threeD && (
              <span style={{ marginLeft: 4, fontSize: 9, color: "#7fd0a8", fontWeight: 600 }}>
                {obj.threeDMode === "raster3d" ? "3D·RAS" : obj.threeDMode === "dom" ? "3D·DOM" : "3D"}
              </span>
            )}
            {obj.components.some((c) => c.type === "camera") && (
              <span
                style={{ marginLeft: 4, fontSize: 9, color: "#7fb8f0", fontWeight: 600 }}
                title={activeCameraId === obj.id ? "現フレームの出力カメラ（最前面の可視カメラ）" : "カメラ（このフレームでは非アクティブ）"}
              >
                {activeCameraId === obj.id ? "CAM●" : "CAM"}
              </span>
            )}
          </span>
          )}
          <ParentSelect
            obj={obj}
            candidates={listParentCandidates(allObjects, obj.id)}
            onChange={(parentId) => onSetParent(obj.id, parentId)}
            disabled={locked}
          />
          <button onClick={(e) => { e.stopPropagation(); if (!locked) onRemove(); }} disabled={locked} style={{ ...iconBtn, color: locked ? "#633" : "#f44" }} title={locked ? "ロック中 — 削除不可" : "レイヤーを削除"}>×</button>
          </div>
        </div>
        {/* graph column: layer bar */}
        <div style={{ position: "relative", flex: 1, minHeight: 22, overflow: "hidden" }} onClick={onSelectLayer}>
          {sourceExtent && (
            <SourceGhostBars
              inPoint={inPoint}
              outPoint={outPoint}
              trimStart={trimStart}
              sourceDuration={sourceExtent.sourceDuration}
              frameToPercent={frameToPercent}
              tint={barFill}
            />
          )}
          <LayerBar
            inPoint={inPoint}
            outPoint={outPoint}
            selected={selected}
            fillColor={barFill}
            frameToPercent={frameToPercent}
            onIn={(e) => beginLayerBarDrag(obj.id, "in", e)}
            onOut={(e) => beginLayerBarDrag(obj.id, "out", e)}
            onMove={(e) => beginLayerBarDrag(obj.id, "move", e)}
          />
          {audio && (
            <WaveformOverlay
              audio={audio}
              mode={waveformMode}
              fps={fps}
              getFs={getFs}
              inPoint={inPoint}
              outPoint={outPoint}
              trimStart={trimStart}
              frameToPercent={frameToPercent}
              selected={selected}
            />
          )}
          <LayerCacheLine
            frames={cachedLocalFrames}
            mapToComp={(f) => f + inPoint}
            inPoint={inPoint}
            outPoint={outPoint}
            viewRange={viewRange}
            frameToPercent={frameToPercent}
          />
          {precompCacheInfo && (
            <LayerCacheLine
              frames={cachedPrecompFrames.get(precompCacheInfo.compId)}
              mapToComp={(f) => precompChildToParentFrame(f, precompCacheInfo.trimStart, inPoint)}
              inPoint={inPoint}
              outPoint={outPoint}
              viewRange={viewRange}
              frameToPercent={frameToPercent}
            />
          )}
          <PlayheadTick frame={frame} frameToPercent={frameToPercent} />
        </div>
      </div>

      {/* property tree */}
      {expandMode && (
        <div style={{ background: "#191919" }}>
          {showInMode(expandMode, obj.transform.anchor.keyframes.length > 0,   vec3Modified(obj.transform.anchor,   VEC3_DEFAULTS.anchor))   && <PropRowVec3 obj={obj} k="anchor"   label="アンカーポイント" frame={frame} kfShift={kfPreviewShift} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onKfRightClick={onKfRightClick} onUpdate={onUpdate} onPreviewPatch={onPreviewPatch} frameToPercent={frameToPercent} graphMode={graphMode} viewRange={viewRange} onSetProp={onSetProp} />}
          {showInMode(expandMode, obj.transform.position.keyframes.length > 0, vec3Modified(obj.transform.position, VEC3_DEFAULTS.position)) && <PropRowVec3 obj={obj} k="position" label="位置"           frame={frame} kfShift={kfPreviewShift} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onKfRightClick={onKfRightClick} onUpdate={onUpdate} onPreviewPatch={onPreviewPatch} frameToPercent={frameToPercent} graphMode={graphMode} viewRange={viewRange} onSetProp={onSetProp} />}
          {showInMode(expandMode, obj.transform.scale.keyframes.length > 0,    vec3Modified(obj.transform.scale,    VEC3_DEFAULTS.scale))    && <PropRowVec3 obj={obj} k="scale"    label="スケール"         frame={frame} kfShift={kfPreviewShift} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onKfRightClick={onKfRightClick} onUpdate={onUpdate} onPreviewPatch={onPreviewPatch} frameToPercent={frameToPercent} graphMode={graphMode} viewRange={viewRange} onSetProp={onSetProp} />}
          {showInMode(expandMode, obj.transform.rotation.keyframes.length > 0, vec3Modified(obj.transform.rotation, VEC3_DEFAULTS.rotation)) && <PropRowVec3 obj={obj} k="rotation" label="回転"           frame={frame} kfShift={kfPreviewShift} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onKfRightClick={onKfRightClick} onUpdate={onUpdate} onPreviewPatch={onPreviewPatch} frameToPercent={frameToPercent} graphMode={graphMode} viewRange={viewRange} onSetProp={onSetProp} />}
          {showInMode(expandMode, obj.opacity.keyframes.length > 0,            scalarModified(obj.opacity, 1))                                && <PropRowOpacity obj={obj} frame={frame} kfShift={kfPreviewShift} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onKfRightClick={onKfRightClick} onUpdate={onUpdate} onPreviewPatch={onPreviewPatch} frameToPercent={frameToPercent} graphMode={graphMode} viewRange={viewRange} onSetProp={onSetProp} />}
          {/* P1-7: component props の animatable KF 行 */}
          {obj.components.map((comp, compIdx) => {
            const def = globalPluginRegistry.getComponentDef(comp.type);
            return Object.entries(comp.props).map(([key, val]) => {
              if (!isAnimatedProp(val)) return null;
              const param = def?.params.find((p) => p.key === key);
              if (param && !param.animatable) return null;
              const label = param?.label ?? key;
              const kind: ParamKind = param?.kind ?? "scalar";
              const animated = val.keyframes.length > 0;
              if (!showInMode(expandMode, animated, animated || val.value !== (param?.default ?? 0))) return null;
              return (
                <PropRowComponent
                  key={`comp_${compIdx}_${key}`}
                  obj={obj}
                  compIdx={compIdx}
                  propKey={key}
                  label={`${comp.type}: ${label}`}
                  kind={kind}
                  frame={frame}
                  kfShift={kfPreviewShift}
                  selectedKfs={selectedKfs}
                  kfDrag={kfDrag}
                  beginKfDrag={beginKfDrag}
                  onKfRightClick={onKfRightClick}
                  onUpdate={onUpdate}
                  onPreviewPatch={onPreviewPatch}
                  frameToPercent={frameToPercent}
                  graphMode={graphMode}
                  viewRange={viewRange}
                  onSetProp={onSetProp}
                />
              );
            });
          })}
          {(obj.effects ?? []).map((effect) => {
            const def = globalPluginRegistry.getEffectDef(effect.type);
            return Object.entries(effect.props).map(([key, val]) => {
              if (!isAnimatedProp(val)) return null;
              const param = def?.params.find((p) => p.key === key);
              if (param && !param.animatable) return null;
              const label = param?.label ?? key;
              const kind: ParamKind = param?.kind ?? "scalar";
              const animated = val.keyframes.length > 0;
              if (!showInMode(expandMode, animated, animated || val.value !== (param?.default ?? 0))) return null;
              return (
                <PropRowEffect
                  key={`fx_${effect.id}_${key}`}
                  obj={obj}
                  effectId={effect.id}
                  propKey={key}
                  label={`${def?.label ?? effect.type}: ${label}`}
                  kind={kind}
                  frame={frame}
                  kfShift={kfPreviewShift}
                  selectedKfs={selectedKfs}
                  kfDrag={kfDrag}
                  beginKfDrag={beginKfDrag}
                  onKfRightClick={onKfRightClick}
                  onUpdate={onUpdate}
                  onPreviewPatch={onPreviewPatch}
                  frameToPercent={frameToPercent}
                  graphMode={graphMode}
                  viewRange={viewRange}
                  onSetProp={onSetProp}
                />
              );
            });
          })}
          {(obj.expressionPresets ?? []).map((inst) => {
            const def = EXPRESSION_PRESETS[inst.presetId as ExpressionPresetId];
            if (!def) return null;
            return Object.entries(inst.props).map(([key, val]) => {
              if (!isAnimatedProp(val)) return null;
              const param = def.params.find((p) => p.key === key);
              if (param && !param.animatable) return null;
              const label = param?.label ?? key;
              const kind: ParamKind = param?.kind ?? "scalar";
              const animated = val.keyframes.length > 0;
              if (!showInMode(expandMode, animated, animated || val.value !== (param?.default ?? 0))) return null;
              return (
                <PropRowExpression
                  key={`expr_${inst.id}_${key}`}
                  obj={obj}
                  instanceId={inst.id}
                  propKey={key}
                  label={`${def.label}: ${label}`}
                  kind={kind}
                  frame={frame}
                  kfShift={kfPreviewShift}
                  selectedKfs={selectedKfs}
                  kfDrag={kfDrag}
                  beginKfDrag={beginKfDrag}
                  onKfRightClick={onKfRightClick}
                  onUpdate={onUpdate}
                  onPreviewPatch={onPreviewPatch}
                  frameToPercent={frameToPercent}
                  graphMode={graphMode}
                  viewRange={viewRange}
                  onSetProp={onSetProp}
                />
              );
            });
          })}
        </div>
      )}
    </div>
  );
}

// §31.2 Solid レイヤー行のカラースウォッチチップ。クリックでネイティブピッカー。
// RGB のみクイック変更（alpha は Inspector の ColorSwatch に委ねる）。
function rgbToHex(c: RGBA): string {
  const h = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function SolidColorChip({
  obj, frame, onUpdate, onPreviewPatch, readOnly = false,
}: {
  obj: SceneObject;
  frame: number;
  onUpdate: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  onPreviewPatch?: (id: string, patch: Partial<SceneObject>) => void;
  readOnly?: boolean;
}) {
  const compIdx = obj.components.findIndex((c) => c.type === "solid");
  if (compIdx < 0 || obj.isNull || obj.isAdjustment) return null;
  const colorProp = obj.components[compIdx]!.props["color"];
  if (!isAnimatedProp(colorProp)) return null;
  const sampled = sampleAny(colorProp, frame);
  const cur: RGBA = isRgba(sampled) ? sampled : { r: 0.5, g: 0.5, b: 0.9, a: 1 };
  return (
    <SolidColorChipInner
      objId={obj.id}
      components={obj.components}
      compIdx={compIdx}
      colorProp={colorProp as AnimatedProp<RGBA>}
      frame={frame}
      cur={cur}
      onUpdate={onUpdate}
      onPreviewPatch={onPreviewPatch}
      readOnly={readOnly}
    />
  );
}

function SolidColorChipInner({
  objId, components, compIdx, colorProp, frame, cur, onUpdate, onPreviewPatch, readOnly = false,
}: {
  objId: string;
  components: Component[];
  compIdx: number;
  colorProp: AnimatedProp<RGBA>;
  frame: number;
  cur: RGBA;
  onUpdate: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  onPreviewPatch?: (id: string, patch: Partial<SceneObject>) => void;
  readOnly?: boolean;
}) {
  const curHex = rgbToHex(cur);
  // ピッカー操作中は preview のみ更新（obj は未変更）。controlled な value が
  // スナップバックしないよう draft をローカルに持つ（ColorSwatch と同型）。
  const [draft, setDraft] = useState(curHex);
  const editingRef = useRef(false);
  const baseRef = useRef(curHex);

  useEffect(() => {
    if (!editingRef.current) {
      setDraft(curHex);
      baseRef.current = curHex;
    }
  }, [curHex]);

  const buildComponents = (hex: string): Component[] => {
    const rgb = hexToRgb(hex);
    if (!rgb) return components;
    const next: RGBA = { ...rgb, a: cur.a };
    return components.map((c, i) => {
      if (i !== compIdx) return c;
      const nextColor = colorProp.keyframes.length > 0
        ? setKeyframe(colorProp, frame, next)
        : { ...colorProp, value: next };
      return { ...c, props: { ...c.props, color: nextColor } };
    });
  };

  return (
    <input
      type="color"
      value={draft}
      disabled={readOnly}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        if (readOnly) return;
        editingRef.current = true;
        setDraft(e.target.value);
        onPreviewPatch?.(objId, { components: buildComponents(e.target.value) });
      }}
      onBlur={() => {
        editingRef.current = false;
        if (draft !== baseRef.current) {
          onUpdate(objId, { components: buildComponents(draft) }, "Edit solid color");
          baseRef.current = draft;
        }
      }}
      title={readOnly ? "ロック中" : "ソリッドの色"}
      style={{ width: 16, height: 16, padding: 0, border: "1px solid #555", background: "transparent", cursor: readOnly ? "not-allowed" : "pointer", flexShrink: 0, borderRadius: 2, opacity: readOnly ? 0.5 : 1 }}
    />
  );
}

function SourceGhostBars({
  inPoint, outPoint, trimStart, sourceDuration, frameToPercent, tint,
}: {
  inPoint: number; outPoint: number; trimStart: number; sourceDuration: number;
  frameToPercent: (f: number) => number;
  tint: string;
}) {
  const sourceStart = inPoint - trimStart;
  const sourceEnd = sourceStart + sourceDuration;
  const segments: { start: number; end: number }[] = [];
  if (trimStart > 0 && inPoint > sourceStart) {
    segments.push({ start: sourceStart, end: inPoint });
  }
  if (sourceEnd > outPoint) {
    segments.push({ start: outPoint, end: sourceEnd });
  }
  if (segments.length === 0) return null;
  return (
    <>
      {segments.map((seg, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: `${frameToPercent(seg.start)}%`,
            width: `${frameToPercent(seg.end) - frameToPercent(seg.start)}%`,
            top: 5,
            height: 12,
            background: tint,
            opacity: 0.28,
            borderRadius: 2,
            pointerEvents: "none",
            zIndex: 0,
          }}
        />
      ))}
    </>
  );
}

function LayerBar({
  inPoint, outPoint, selected, fillColor, frameToPercent, onIn, onOut, onMove,
}: {
  inPoint: number; outPoint: number; selected: boolean; fillColor: string;
  frameToPercent: (f: number) => number;
  onIn: (e: React.MouseEvent) => void; onOut: (e: React.MouseEvent) => void; onMove: (e: React.MouseEvent) => void;
}) {
  const left = frameToPercent(inPoint);
  const width = frameToPercent(outPoint) - left;
  return (
    <div
      style={{
        position: "absolute",
        left: `${left}%`,
        width: `${width}%`,
        top: 4,
        height: 14,
        background: fillColor,
        borderRadius: 2,
        cursor: "grab",
        display: "flex",
        alignItems: "stretch",
        zIndex: 1,
        outline: selected ? "1px solid rgba(255,255,255,0.75)" : "none",
        outlineOffset: -1,
      }}
      onMouseDown={onMove}
      title="ドラッグで移動 / 端をドラッグでトリム"
    >
      <div onMouseDown={onIn} style={handleStyle} title="開始（どこから）" />
      <div style={{ flex: 1 }} />
      <div onMouseDown={onOut} style={handleStyle} title="終了（どこまで）" />
    </div>
  );
}

// ---- プロパティ行 ----

function PropRowVec3({
  obj, k, label, frame, kfShift, selectedKfs, kfDrag, beginKfDrag, onKfRightClick, onUpdate, onPreviewPatch, frameToPercent, graphMode, viewRange, onSetProp,
}: {
  obj: SceneObject; k: TransformVecKey; label: string; frame: Frame; kfShift: number;
  selectedKfs: Set<string>; kfDrag: KfDragState | null;
  beginKfDrag: (objId: string, path: PropPath, frame: number, e: React.MouseEvent) => void;
  onKfRightClick: (key: string, x: number, y: number) => void;
  onUpdate: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  onPreviewPatch?: (id: string, patch: Partial<SceneObject>) => void;
  frameToPercent: (f: number) => number;
  graphMode: boolean; viewRange: { start: number; end: number };
  onSetProp: (objId: string, path: PropPath, next: AnimatedProp<unknown>, label: string) => void;
}) {
  const prop = obj.transform[k];
  const v = sampleVec3(prop, frame);
  const animated = prop.keyframes.length > 0;
  const propPath = `transform.${k}` as PropPath;

  const writeProp = (next: AnimatedProp<Vec3>, lbl: string) => {
    const transform: Transform = { ...obj.transform, [k]: next };
    onUpdate(obj.id, { transform }, lbl);
  };

  const toggleStopwatch = () => {
    if (animated) {
      writeProp({ value: v, keyframes: [] }, `Disable ${k} keyframes`);
    } else {
      writeProp(setKeyframe<Vec3>(prop, frame, v, { type: "linear" } as Easing), `Enable ${k} keyframes`);
    }
  };

  const editAxis = (axis: "x" | "y" | "z", num: number) => {
    if (!Number.isFinite(num)) return;
    const nextVal: Vec3 = { ...v, [axis]: num };
    if (animated) writeProp(setKeyframe<Vec3>(prop, frame, nextVal, { type: "linear" } as Easing), `Edit ${k}`);
    else writeProp({ ...prop, value: nextVal }, `Edit ${k}`);
  };

  const previewAxis = (axis: "x" | "y" | "z", num: number) => {
    if (!Number.isFinite(num) || !onPreviewPatch) return;
    const nextVal: Vec3 = { ...v, [axis]: num };
    const nextProp = animated
      ? setKeyframe<Vec3>(prop, frame, nextVal, { type: "linear" } as Easing)
      : { ...prop, value: nextVal };
    onPreviewPatch(obj.id, { transform: { ...obj.transform, [k]: nextProp } });
  };

  return (
    <PropRowShell label={label} animated={animated} onStopwatch={toggleStopwatch} prop={prop} frame={frame} kfShift={kfShift} objId={obj.id} propPath={propPath} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onKfRightClick={onKfRightClick} frameToPercent={frameToPercent} graphMode={graphMode} viewRange={viewRange} onSetProp={onSetProp}>
      <NumberField value={v.x} onCommit={(n) => editAxis("x", n)} onLiveChange={(n) => previewAxis("x", n)} expressed={isPropExpressed(prop)} />
      <NumberField value={v.y} onCommit={(n) => editAxis("y", n)} onLiveChange={(n) => previewAxis("y", n)} expressed={isPropExpressed(prop)} />
      <NumberField value={v.z} onCommit={(n) => editAxis("z", n)} onLiveChange={(n) => previewAxis("z", n)} expressed={isPropExpressed(prop)} />
    </PropRowShell>
  );
}

function PropRowOpacity({
  obj, frame, kfShift, selectedKfs, kfDrag, beginKfDrag, onKfRightClick, onUpdate, onPreviewPatch, frameToPercent, graphMode, viewRange, onSetProp,
}: {
  obj: SceneObject; frame: Frame; kfShift: number;
  selectedKfs: Set<string>; kfDrag: KfDragState | null;
  beginKfDrag: (objId: string, path: PropPath, frame: number, e: React.MouseEvent) => void;
  onKfRightClick: (key: string, x: number, y: number) => void;
  onUpdate: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  onPreviewPatch?: (id: string, patch: Partial<SceneObject>) => void;
  frameToPercent: (f: number) => number;
  graphMode: boolean; viewRange: { start: number; end: number };
  onSetProp: (objId: string, path: PropPath, next: AnimatedProp<unknown>, label: string) => void;
}) {
  const prop = obj.opacity;
  const v = sampleScalar(prop, frame);
  const animated = prop.keyframes.length > 0;

  const writeProp = (next: AnimatedProp<number>, lbl: string) => onUpdate(obj.id, { opacity: next }, lbl);

  const toggleStopwatch = () => {
    if (animated) writeProp({ value: v, keyframes: [] }, "Disable opacity keyframes");
    else writeProp(setKeyframe<number>(prop, frame, v, { type: "linear" } as Easing), "Enable opacity keyframes");
  };

  const edit = (num: number) => {
    if (!Number.isFinite(num)) return;
    const clamped = Math.min(1, Math.max(0, num));
    if (animated) writeProp(setKeyframe<number>(prop, frame, clamped, { type: "linear" } as Easing), "Edit opacity");
    else writeProp({ ...prop, value: clamped }, "Edit opacity");
  };

  const preview = (num: number) => {
    if (!Number.isFinite(num) || !onPreviewPatch) return;
    const clamped = Math.min(1, Math.max(0, num));
    const next = animated
      ? setKeyframe<number>(prop, frame, clamped, { type: "linear" } as Easing)
      : { ...prop, value: clamped };
    onPreviewPatch(obj.id, { opacity: next });
  };

  return (
    <PropRowShell label="不透明度" animated={animated} onStopwatch={toggleStopwatch} prop={prop} frame={frame} kfShift={kfShift} objId={obj.id} propPath="opacity" selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onKfRightClick={onKfRightClick} frameToPercent={frameToPercent} graphMode={graphMode} viewRange={viewRange} onSetProp={onSetProp}>
      <NumberField value={v} onCommit={edit} onLiveChange={preview} min={0} max={1} step={0.01} expressed={isPropExpressed(prop)} />
    </PropRowShell>
  );
}

// §27: effect の animatable prop 行
function PropRowEffect({
  obj, effectId, propKey, label, kind, frame, kfShift, selectedKfs, kfDrag, beginKfDrag, onKfRightClick, onUpdate, onPreviewPatch, frameToPercent, graphMode, viewRange, onSetProp,
}: {
  obj: SceneObject; effectId: string; propKey: string; label: string; kind: ParamKind;
  frame: Frame; kfShift: number;
  selectedKfs: Set<string>; kfDrag: KfDragState | null;
  beginKfDrag: (objId: string, path: PropPath, frame: number, e: React.MouseEvent) => void;
  onKfRightClick: (key: string, x: number, y: number) => void;
  onUpdate: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  onPreviewPatch?: (id: string, patch: Partial<SceneObject>) => void;
  frameToPercent: (f: number) => number;
  graphMode: boolean; viewRange: { start: number; end: number };
  onSetProp: (objId: string, path: PropPath, next: AnimatedProp<unknown>, label: string) => void;
}) {
  const effect = obj.effects?.find((e) => e.id === effectId);
  if (!effect) return null;
  const rawVal = effect.props[propKey];
  if (!isAnimatedProp(rawVal)) return null;
  const prop = rawVal;
  const animated = prop.keyframes.length > 0;
  const sampled = sampleAny(prop, frame);
  const propPath = `effects.${effectId}.${propKey}`;
  const paramDef = globalPluginRegistry.getEffectDef(effect.type)?.params.find((p) => p.key === propKey);

  const writeProp = (next: AnimatedProp<unknown>, lbl: string) => {
    const nextEffects = (obj.effects ?? []).map((e) =>
      e.id === effectId ? { ...e, props: { ...e.props, [propKey]: next } } : e,
    );
    onUpdate(obj.id, { effects: nextEffects }, lbl);
  };

  const previewProp = (next: AnimatedProp<unknown>) => {
    if (!onPreviewPatch) return;
    onPreviewPatch(obj.id, {
      effects: (obj.effects ?? []).map((e) =>
        e.id === effectId ? { ...e, props: { ...e.props, [propKey]: next } } : e,
      ),
    });
  };

  const toggleStopwatch = () => {
    if (animated) writeProp({ value: prop.value, keyframes: [] }, `Disable ${propKey} keyframes`);
    else writeProp(setKeyframe(prop as AnimatedProp<unknown>, frame, prop.value, { type: "linear" } as Easing), `Enable ${propKey} keyframes`);
  };

  return (
    <PropRowShell label={label} animated={animated} onStopwatch={toggleStopwatch} prop={prop} frame={frame} kfShift={kfShift} objId={obj.id} propPath={propPath} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onKfRightClick={onKfRightClick} frameToPercent={frameToPercent} graphMode={graphMode} viewRange={viewRange} onSetProp={onSetProp}>
      {kind === "scalar" && typeof sampled === "number" ? (
        <NumberField value={sampled} onCommit={(num) => {
          if (!Number.isFinite(num)) return;
          if (animated) writeProp(setKeyframe(prop as AnimatedProp<unknown>, frame, num, { type: "linear" } as Easing), `Edit ${propKey}`);
          else writeProp({ ...prop, value: num }, `Edit ${propKey}`);
        }} onLiveChange={(num) => {
          if (!Number.isFinite(num)) return;
          if (animated) previewProp(setKeyframe(prop as AnimatedProp<unknown>, frame, num, { type: "linear" } as Easing));
          else previewProp({ ...prop, value: num });
        }} min={paramDef?.min} max={paramDef?.max} step={paramDef?.step} expressed={isPropExpressed(prop)} />
      ) : kind === "color" && typeof sampled === "object" && sampled !== null && "r" in sampled ? (
        <span style={{ fontSize: 10, color: isPropExpressed(prop) ? EXPRESSED_VALUE_COLOR : "#aaa" }}>
          {Math.round((sampled as RGBA).r * 255)},{Math.round((sampled as RGBA).g * 255)},{Math.round((sampled as RGBA).b * 255)}
        </span>
      ) : (
        <span style={{ color: "#777", fontSize: 10 }}>{kind}</span>
      )}
    </PropRowShell>
  );
}

function PropRowExpression({
  obj, instanceId, propKey, label, kind, frame, kfShift, selectedKfs, kfDrag, beginKfDrag, onKfRightClick, onUpdate, onPreviewPatch, frameToPercent, graphMode, viewRange, onSetProp,
}: {
  obj: SceneObject; instanceId: string; propKey: string; label: string; kind: ParamKind;
  frame: Frame; kfShift: number;
  selectedKfs: Set<string>; kfDrag: KfDragState | null;
  beginKfDrag: (objId: string, path: PropPath, frame: number, e: React.MouseEvent) => void;
  onKfRightClick: (key: string, x: number, y: number) => void;
  onUpdate: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  onPreviewPatch?: (id: string, patch: Partial<SceneObject>) => void;
  frameToPercent: (f: number) => number;
  graphMode: boolean; viewRange: { start: number; end: number };
  onSetProp: (objId: string, path: PropPath, next: AnimatedProp<unknown>, label: string) => void;
}) {
  const inst = obj.expressionPresets?.find((p) => p.id === instanceId);
  if (!inst) return null;
  const rawVal = inst.props[propKey];
  if (!isAnimatedProp(rawVal)) return null;
  const prop = rawVal;
  const animated = prop.keyframes.length > 0;
  const sampled = sampleAny(prop, frame);
  const propPath = `expressionPresets.${instanceId}.${propKey}`;
  const presetDef = EXPRESSION_PRESETS[inst.presetId as ExpressionPresetId];
  const paramDef = presetDef?.params.find((p) => p.key === propKey);

  const writeProp = (next: AnimatedProp<unknown>, lbl: string) => {
    const nextPresets = (obj.expressionPresets ?? []).map((p) =>
      p.id === instanceId ? { ...p, props: { ...p.props, [propKey]: next } } : p,
    );
    onUpdate(obj.id, { expressionPresets: nextPresets }, lbl);
  };

  const previewProp = (next: AnimatedProp<unknown>) => {
    if (!onPreviewPatch) return;
    onPreviewPatch(obj.id, {
      expressionPresets: (obj.expressionPresets ?? []).map((p) =>
        p.id === instanceId ? { ...p, props: { ...p.props, [propKey]: next } } : p,
      ),
    });
  };

  const toggleStopwatch = () => {
    if (animated) writeProp({ value: prop.value, keyframes: [] }, `Disable ${propKey} keyframes`);
    else writeProp(setKeyframe(prop as AnimatedProp<unknown>, frame, prop.value, { type: "linear" } as Easing), `Enable ${propKey} keyframes`);
  };

  return (
    <PropRowShell label={label} animated={animated} onStopwatch={toggleStopwatch} prop={prop} frame={frame} kfShift={kfShift} objId={obj.id} propPath={propPath} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onKfRightClick={onKfRightClick} frameToPercent={frameToPercent} graphMode={graphMode} viewRange={viewRange} onSetProp={onSetProp}>
      {kind === "scalar" && typeof sampled === "number" ? (
        <NumberField value={sampled} onCommit={(num) => {
          if (!Number.isFinite(num)) return;
          if (animated) writeProp(setKeyframe(prop as AnimatedProp<unknown>, frame, num, { type: "linear" } as Easing), `Edit ${propKey}`);
          else writeProp({ ...prop, value: num }, `Edit ${propKey}`);
        }} onLiveChange={(num) => {
          if (!Number.isFinite(num)) return;
          if (animated) previewProp(setKeyframe(prop as AnimatedProp<unknown>, frame, num, { type: "linear" } as Easing));
          else previewProp({ ...prop, value: num });
        }} min={paramDef?.min} max={paramDef?.max} step={paramDef?.step} />
      ) : (
        <span style={{ color: "#777", fontSize: 10 }}>{kind}</span>
      )}
    </PropRowShell>
  );
}

// P1-7: component の animatable prop 行
function PropRowComponent({
  obj, compIdx, propKey, label, kind, frame, kfShift, selectedKfs, kfDrag, beginKfDrag, onKfRightClick, onUpdate, onPreviewPatch, frameToPercent, graphMode, viewRange, onSetProp,
}: {
  obj: SceneObject; compIdx: number; propKey: string; label: string; kind: ParamKind;
  frame: Frame; kfShift: number;
  selectedKfs: Set<string>; kfDrag: KfDragState | null;
  beginKfDrag: (objId: string, path: PropPath, frame: number, e: React.MouseEvent) => void;
  onKfRightClick: (key: string, x: number, y: number) => void;
  onUpdate: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  onPreviewPatch?: (id: string, patch: Partial<SceneObject>) => void;
  frameToPercent: (f: number) => number;
  graphMode: boolean; viewRange: { start: number; end: number };
  onSetProp: (objId: string, path: PropPath, next: AnimatedProp<unknown>, label: string) => void;
}) {
  const comp = obj.components[compIdx];
  if (!comp) return null;
  const rawVal = comp.props[propKey];
  if (!isAnimatedProp(rawVal)) return null;
  const prop = rawVal;
  const animated = prop.keyframes.length > 0;
  const sampled = sampleAny(prop, frame);
  const propPath = `comp_${compIdx}_${propKey}`;
  const paramDef = globalPluginRegistry.getComponentDef(comp.type)?.params.find((p) => p.key === propKey);

  const writeProp = (next: AnimatedProp<unknown>, lbl: string) => {
    const nextComponents = obj.components.map((c, i) =>
      i === compIdx ? { ...c, props: { ...c.props, [propKey]: next } } : c
    );
    onUpdate(obj.id, { components: nextComponents }, lbl);
  };

  const previewProp = (next: AnimatedProp<unknown>) => {
    if (!onPreviewPatch) return;
    onPreviewPatch(obj.id, {
      components: obj.components.map((c, i) =>
        i === compIdx ? { ...c, props: { ...c.props, [propKey]: next } } : c
      ),
    });
  };

  const toggleStopwatch = () => {
    if (animated) writeProp({ value: prop.value, keyframes: [] }, `Disable ${propKey} keyframes`);
    else writeProp(setKeyframe(prop as AnimatedProp<unknown>, frame, prop.value, { type: "linear" } as Easing), `Enable ${propKey} keyframes`);
  };

  return (
    <PropRowShell label={label} animated={animated} onStopwatch={toggleStopwatch} prop={prop} frame={frame} kfShift={kfShift} objId={obj.id} propPath={propPath} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onKfRightClick={onKfRightClick} frameToPercent={frameToPercent} graphMode={graphMode} viewRange={viewRange} onSetProp={onSetProp}>
      {kind === "scalar" && typeof sampled === "number" ? (
        <NumberField value={sampled} onCommit={(num) => {
          if (!Number.isFinite(num)) return;
          if (animated) writeProp(setKeyframe(prop as AnimatedProp<unknown>, frame, num, { type: "linear" } as Easing), `Edit ${propKey}`);
          else writeProp({ ...prop, value: num }, `Edit ${propKey}`);
        }} onLiveChange={(num) => {
          if (!Number.isFinite(num)) return;
          if (animated) previewProp(setKeyframe(prop as AnimatedProp<unknown>, frame, num, { type: "linear" } as Easing));
          else previewProp({ ...prop, value: num });
        }} min={paramDef?.min} max={paramDef?.max} step={paramDef?.step} expressed={isPropExpressed(prop)} />
      ) : kind === "string" && typeof sampled === "string" ? (
        <input
          value={sampled}
          onChange={(e) => {
            const v = e.target.value;
            if (animated) writeProp(setKeyframe(prop as AnimatedProp<unknown>, frame, v, { type: "hold" } as Easing), `Edit ${propKey}`);
            else writeProp({ ...prop, value: v }, `Edit ${propKey}`);
          }}
          style={{
            width: 100,
            fontSize: 10,
            background: "#222",
            border: "1px solid #444",
            color: isPropExpressed(prop) ? EXPRESSED_VALUE_COLOR : "#ccc",
            padding: "1px 3px",
          }}
        />
      ) : kind === "color" && typeof sampled === "object" && sampled !== null && "r" in sampled ? (
        <span style={{ fontSize: 10, color: isPropExpressed(prop) ? EXPRESSED_VALUE_COLOR : "#aaa" }}>
          {Math.round((sampled as RGBA).r * 255)},{Math.round((sampled as RGBA).g * 255)},{Math.round((sampled as RGBA).b * 255)}
        </span>
      ) : kind === "bool" && typeof sampled === "boolean" ? (
        <span style={{ fontSize: 10, color: sampled ? "#8cf" : "#666" }}>{sampled ? "true" : "false"}</span>
      ) : kind === "enum" ? (
        <span style={{ fontSize: 10, color: "#aaa" }}>{String(sampled)}</span>
      ) : (
        <span style={{ color: "#777", fontSize: 10 }}>{kind}</span>
      )}
    </PropRowShell>
  );
}

// §22 グラフエディタ: 数値/Vec3 プロパティの値カーブを描画・編集するレーン。
const GRAPH_H = 76;
function GraphLane({
  prop, objId, propPath, frame, viewRange, frameToPercent, onSetProp,
}: {
  prop: AnimatedProp<unknown>;
  objId: string; propPath: PropPath; frame: Frame;
  viewRange: { start: number; end: number };
  frameToPercent: (f: number) => number;
  onSetProp: (objId: string, path: PropPath, next: AnimatedProp<unknown>, label: string) => void;
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<AnimatedProp<unknown> | null>(null);
  const cur = preview ?? prop;
  const span = Math.max(1, viewRange.end - viewRange.start);

  const isVec = typeof prop.value === "object" && prop.value !== null && "x" in (prop.value as object);
  const axes: (null | "x" | "y" | "z")[] = isVec ? ["x", "y", "z"] : [null];
  const axisColor: Record<string, string> = { x: "#e76a6a", y: "#6ad46a", z: "#6a9cf0", _: "#7fb8f0" };
  const getN = (val: unknown, ax: null | "x" | "y" | "z"): number =>
    ax ? (val as Vec3)[ax] : (val as number);
  const setN = (val: unknown, ax: null | "x" | "y" | "z", n: number): unknown =>
    ax ? { ...(val as Vec3), [ax]: n } : n;
  const sampleAxis = (f: number, ax: null | "x" | "y" | "z"): number =>
    isVec ? (sampleVec3(cur as AnimatedProp<Vec3>, f))[ax!] : sampleScalar(cur as AnimatedProp<number>, f);

  // 値域（全軸・全 KF + base）を padding 付きで算出。
  const vals: number[] = [];
  for (const kf of cur.keyframes) for (const ax of axes) vals.push(getN(kf.value, ax));
  for (const ax of axes) vals.push(getN(cur.value, ax));
  let vmin = Math.min(...vals);
  let vmax = Math.max(...vals);
  if (!isFinite(vmin) || !isFinite(vmax)) { vmin = 0; vmax = 1; }
  const vspan = vmax - vmin || 1;
  const vlo = vmin - vspan * 0.18;
  const vhi = vmax + vspan * 0.18;
  const valueToY = (v: number): number => GRAPH_H * (1 - (v - vlo) / (vhi - vlo));

  // マウス → (frame, value)
  const mouseToFV = (clientX: number, clientY: number) => {
    const r = laneRef.current!.getBoundingClientRect();
    const rx = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const ry = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    return { frame: viewRange.start + rx * span, value: vhi - ry * (vhi - vlo) };
  };

  const commit = (next: AnimatedProp<unknown>, label: string) => onSetProp(objId, propPath, next, label);

  // KF 点ドラッグ（frame + 値）
  const startKfDrag = (kfIdx: number, ax: null | "x" | "y" | "z") => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const kfs = prop.keyframes;
    const prevF = kfIdx > 0 ? kfs[kfIdx - 1]!.frame + 1 : 0;
    const nextF = kfIdx < kfs.length - 1 ? kfs[kfIdx + 1]!.frame - 1 : Math.round(viewRange.end);
    let last = prop;
    const move = (ev: MouseEvent) => {
      const { frame: fm, value: vm } = mouseToFV(ev.clientX, ev.clientY);
      const nf = Math.max(prevF, Math.min(nextF, Math.round(fm)));
      const nextKfs = kfs.map((k, i) => i === kfIdx ? { ...k, frame: nf, value: setN(k.value, ax, vm) } : k)
        .sort((a, b) => a.frame - b.frame);
      last = { ...prop, keyframes: nextKfs };
      setPreview(last);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setPreview(null);
      if (last !== prop) commit(last, "Graph: move keyframe");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // ベジェハンドルドラッグ（区間 i の easing.bezier を編集）
  const startHandleDrag = (segIdx: number, which: "out" | "in", refAx: null | "x" | "y" | "z") => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const kfs = prop.keyframes;
    const k0 = kfs[segIdx]!;
    const k1 = kfs[segIdx + 1]!;
    const dt = k1.frame - k0.frame || 1;
    const v0 = getN(k0.value, refAx);
    const v1 = getN(k1.value, refAx);
    const cur0 = k0.easing.type === "bezier" ? k0.easing.bezier : [0, 0, 1, 1] as [number, number, number, number];
    let last = prop;
    const move = (ev: MouseEvent) => {
      const { frame: fm, value: vm } = mouseToFV(ev.clientX, ev.clientY);
      const x = Math.min(1, Math.max(0, (fm - k0.frame) / dt));
      const y = v1 !== v0 ? (vm - v0) / (v1 - v0) : (which === "out" ? cur0[1] : cur0[3]);
      const b: [number, number, number, number] = which === "out"
        ? [x, y, cur0[2], cur0[3]]
        : [cur0[0], cur0[1], x, y];
      const nextKfs = kfs.map((k, i) => i === segIdx ? { ...k, easing: { type: "bezier", bezier: b } as Easing } : k);
      last = { ...prop, keyframes: nextKfs };
      setPreview(last);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setPreview(null);
      if (last !== prop) commit(last, "Graph: edit easing");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // 値カーブ（実サンプラで描画。hold/overshoot もそのまま反映）
  const N = 72;
  const curvePaths = axes.map((ax) => {
    let d = "";
    for (let i = 0; i <= N; i++) {
      const f = viewRange.start + (i / N) * span;
      const x = frameToPercent(f);
      const y = valueToY(sampleAxis(f, ax));
      d += `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)} `;
    }
    return { ax, d, color: ax ? axisColor[ax]! : axisColor._! };
  });

  return (
    <div ref={laneRef} style={{ position: "relative", flex: 1, height: GRAPH_H, overflow: "hidden", background: "#141414" }}>
      <PlayheadTick frame={frame} frameToPercent={frameToPercent} />
      <svg width="100%" height={GRAPH_H} viewBox={`0 0 100 ${GRAPH_H}`} preserveAspectRatio="none" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        {/* 値カーブ */}
        {curvePaths.map((c, i) => (
          <path key={i} d={c.d} fill="none" stroke={c.color} strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.9} />
        ))}
        {/* ベジェハンドル（区間ごと、参照軸 = |Δ| 最大） */}
        {cur.keyframes.slice(0, -1).map((k0, i) => {
          const k1 = cur.keyframes[i + 1]!;
          if (k0.easing.type === "hold") return null;
          const b = k0.easing.type === "bezier" ? k0.easing.bezier : [0, 0, 1, 1] as [number, number, number, number];
          // 参照軸
          let refAx: null | "x" | "y" | "z" = axes[0]!;
          let maxD = -1;
          for (const ax of axes) { const d = Math.abs(getN(k1.value, ax) - getN(k0.value, ax)); if (d > maxD) { maxD = d; refAx = ax; } }
          const dt = k1.frame - k0.frame || 1;
          const v0 = getN(k0.value, refAx);
          const v1 = getN(k1.value, refAx);
          const p0x = frameToPercent(k0.frame), p0y = valueToY(v0);
          const p1x = frameToPercent(k1.frame), p1y = valueToY(v1);
          const ohx = frameToPercent(k0.frame + b[0] * dt), ohy = valueToY(v0 + b[1] * (v1 - v0));
          const ihx = frameToPercent(k0.frame + b[2] * dt), ihy = valueToY(v0 + b[3] * (v1 - v0));
          return (
            <g key={i}>
              <line x1={p0x} y1={p0y} x2={ohx} y2={ohy} stroke="#888" strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
              <line x1={p1x} y1={p1y} x2={ihx} y2={ihy} stroke="#888" strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
      </svg>
      {/* ハンドル四角・KF 点は HTML overlay（ヒット領域確保） */}
      {cur.keyframes.slice(0, -1).map((k0, i) => {
        const k1 = cur.keyframes[i + 1]!;
        if (k0.easing.type === "hold") return null;
        const b = k0.easing.type === "bezier" ? k0.easing.bezier : [0, 0, 1, 1] as [number, number, number, number];
        let refAx: null | "x" | "y" | "z" = axes[0]!; let maxD = -1;
        for (const ax of axes) { const d = Math.abs(getN(k1.value, ax) - getN(k0.value, ax)); if (d > maxD) { maxD = d; refAx = ax; } }
        const dt = k1.frame - k0.frame || 1;
        const v0 = getN(k0.value, refAx); const v1 = getN(k1.value, refAx);
        const oh = { x: frameToPercent(k0.frame + b[0] * dt), y: valueToY(v0 + b[1] * (v1 - v0)) };
        const ih = { x: frameToPercent(k0.frame + b[2] * dt), y: valueToY(v0 + b[3] * (v1 - v0)) };
        return (
          <div key={i}>
            <div onMouseDown={startHandleDrag(i, "out", refAx)} title="出ハンドル（イージング）" style={handleDot(oh.x, oh.y, "#bbb")} />
            <div onMouseDown={startHandleDrag(i, "in", refAx)} title="入ハンドル（イージング）" style={handleDot(ih.x, ih.y, "#bbb")} />
          </div>
        );
      })}
      {axes.map((ax) => cur.keyframes.map((kf, i) => {
        const x = frameToPercent(kf.frame);
        const y = valueToY(getN(kf.value, ax));
        const color = ax ? axisColor[ax]! : axisColor._!;
        return (
          <div
            key={`${ax ?? "s"}-${i}`}
            onMouseDown={startKfDrag(i, ax)}
            title={`KF F${kf.frame} = ${getN(kf.value, ax).toFixed(2)}${ax ? ` (${ax})` : ""}（ドラッグで時間・値を編集）`}
            style={{ position: "absolute", left: `${x}%`, top: y, width: 8, height: 8, marginLeft: -4, marginTop: -4, background: color, border: "1px solid #111", borderRadius: "50%", cursor: "move", zIndex: 2 }}
          />
        );
      }))}
    </div>
  );
}

function handleDot(xPct: number, yPx: number, color: string): React.CSSProperties {
  return { position: "absolute", left: `${xPct}%`, top: yPx, width: 7, height: 7, marginLeft: -3.5, marginTop: -3.5, background: color, border: "1px solid #111", cursor: "move", zIndex: 3 };
}

function PropRowShell({
  label, animated, onStopwatch, prop, frame, kfShift, objId, propPath, selectedKfs, kfDrag, beginKfDrag, onKfRightClick, frameToPercent, graphMode, viewRange, onSetProp, children,
}: {
  label: string; animated: boolean; onStopwatch: () => void;
  prop: AnimatedProp<unknown>; frame: Frame; kfShift: number;
  objId: string; propPath: PropPath; selectedKfs: Set<string>; kfDrag: KfDragState | null;
  beginKfDrag: (objId: string, path: PropPath, frame: number, e: React.MouseEvent) => void;
  onKfRightClick: (key: string, x: number, y: number) => void;
  frameToPercent: (f: number) => number;
  graphMode: boolean; viewRange: { start: number; end: number };
  onSetProp: (objId: string, path: PropPath, next: AnimatedProp<unknown>, label: string) => void;
  children: React.ReactNode;
}) {
  // §22: グラフモードかつ animated（数値/Vec3）のときは値カーブレーンを表示。
  const numeric = typeof prop.value === "number" || (typeof prop.value === "object" && prop.value !== null && "x" in (prop.value as object));
  const showGraph = graphMode && animated && numeric;
  return (
    <div style={{ display: "flex", alignItems: "stretch", borderTop: "1px solid #202020" }}>
      <div style={{ width: LABEL_W, boxSizing: "border-box", flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "2px 6px 2px 30px", borderRight: "1px solid #2a2a2a" }}>
        <button
          onClick={onStopwatch}
          style={{ ...iconBtn, color: animated ? "#f0c040" : "#666" }}
          title="ストップウォッチ（キーフレーム有効/無効）"
        >
          {animated ? "⏱" : "○"}
        </button>
        <span style={{ width: 78, color: "#999", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <div style={{ display: "flex", gap: 3, flex: 1 }}>{children}</div>
      </div>
      {showGraph ? (
        <GraphLane prop={prop} objId={objId} propPath={propPath} frame={frame} viewRange={viewRange} frameToPercent={frameToPercent} onSetProp={onSetProp} />
      ) : (
      /* keyframe row in graph column */
      <div style={{ position: "relative", flex: 1, minHeight: 20, overflow: "hidden" }}>
        <PlayheadTick frame={frame} frameToPercent={frameToPercent} />
        {prop.keyframes.map((kf) => {
          const key = kfKey(objId, propPath, kf.frame);
          const isSelected = selectedKfs.has(key);
          const inDrag = kfDrag !== null && kfDrag.keys.has(key);
          const displayFrame = (inDrag ? kf.frame + kfDrag.delta : kf.frame) + kfShift;
          // P0-3: 色は easing type で決まる（選択・現フレームが優先）
          const bg = isSelected ? "#5a9ff0" : kf.frame === frame ? "#f0c040" : easingColor(kf.easing);
          const left = frameToPercent(displayFrame);
          return (
            <span
              key={kf.frame}
              data-kf-key={key}
              onMouseDown={(e) => beginKfDrag(objId, propPath, kf.frame, e)}
              onContextMenu={(e) => { e.preventDefault(); onKfRightClick(key, e.clientX, e.clientY); }}
              title={`KF @ frame ${kf.frame}  easing:${kf.easing.type}  (右クリックでイージング変更)`}
              style={{
                position: "absolute",
                left: `${left}%`,
                top: "50%",
                transform: "translate(-50%, -50%) rotate(45deg)",
                width: 9,
                height: 9,
                background: bg,
                outline: isSelected ? "1px solid #fff" : "none",
                cursor: "ew-resize",
                // hold は正方形で区別
                borderRadius: kf.easing.type === "hold" ? 0 : "1px",
              }}
            />
          );
        })}
      </div>
      )}
    </div>
  );
}

function NumberField({
  value,
  onCommit,
  onLiveChange,
  min,
  max,
  step,
  expressed,
}: {
  value: number;
  onCommit: (v: number) => void;
  onLiveChange?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  expressed?: boolean;
}) {
  return (
    <ScrubNumber
      value={value}
      onCommit={(v) => onCommit(v)}
      onLiveChange={onLiveChange}
      min={min}
      max={max}
      step={step}
      className="tl-num"
      style={{
        minWidth: 44,
        width: "auto",
        height: 18,
        background: "#111",
        border: "1px solid #333",
        color: expressed ? EXPRESSED_VALUE_COLOR : "#7fb8f0",
        borderRadius: 2,
        padding: "1px 3px",
        fontSize: 11,
        fontVariantNumeric: "tabular-nums",
      }}
    />
  );
}

// ---- プロパティ行 ----
function cloneObject(o: SceneObject): SceneObject {
  return JSON.parse(JSON.stringify(o)) as SceneObject;
}

function shiftKfProp<T>(prop: AnimatedProp<T>, delta: number): AnimatedProp<T> {
  if (prop.keyframes.length === 0) return prop;
  return { ...prop, keyframes: prop.keyframes.map((k) => ({ ...k, frame: k.frame + delta })) };
}

function shiftObjectKeyframes(obj: SceneObject, delta: number): Partial<SceneObject> {
  const transform: Transform = {
    anchor: shiftKfProp(obj.transform.anchor, delta),
    position: shiftKfProp(obj.transform.position, delta),
    rotation: shiftKfProp(obj.transform.rotation, delta),
    scale: shiftKfProp(obj.transform.scale, delta),
  };
  const opacity = shiftKfProp(obj.opacity, delta);
  const components: Component[] = obj.components.map((c) => {
    let touched = false;
    const props: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(c.props)) {
      if (isAnimatedProp(val) && val.keyframes.length > 0) {
        props[key] = shiftKfProp(val, delta);
        touched = true;
      } else {
        props[key] = val;
      }
    }
    return touched ? { ...c, props } : c;
  });
  const effects = obj.effects?.map((e) => {
    let touched = false;
    const props: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(e.props)) {
      if (isAnimatedProp(val) && val.keyframes.length > 0) {
        props[key] = shiftKfProp(val, delta);
        touched = true;
      } else {
        props[key] = val;
      }
    }
    return touched ? { ...e, props } : e;
  });
  const out: Partial<SceneObject> = { transform, opacity, components };
  if (effects && effects.some((e, i) => e !== obj.effects![i])) out.effects = effects;
  return out;
}

const btnStyle: React.CSSProperties = {
  background: "#333",
  border: "1px solid #555",
  color: "#ccc",
  borderRadius: 3,
  padding: "2px 6px",
  cursor: "pointer",
  fontSize: 11,
};


const iconBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#ccc",
  cursor: "pointer",
  fontSize: 11,
  padding: "0 2px",
  lineHeight: 1,
};

const caretStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#888",
  cursor: "pointer",
  fontSize: 10,
  padding: 0,
  width: 12,
};

const handleStyle: React.CSSProperties = {
  width: 6,
  cursor: "ew-resize",
  background: "rgba(0,0,0,0.25)",
};
