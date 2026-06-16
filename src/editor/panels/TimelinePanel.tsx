import { useEffect, useRef, useState } from "react";
import { currentTimelineComp, setKeyframe, useEditorStore } from "../store";
import { DRAG_MIME } from "./ProjectPanel";
import type {
  AnimatedProp,
  Component,
  Easing,
  Frame,
  SceneObject,
  Transform,
  Vec3,
} from "../../core/schema";
import { sampleScalar, sampleVec3 } from "../../runtime/interpolate";

// §21.1 SMPTE タイムコード（non-drop）。frame は正準・整数（INV-5）、これは派生表示のみ。
function framesToTimecode(frame: Frame, fps: number): string {
  const f = Math.max(1, Math.round(fps));
  const ff = ((frame % f) + f) % f;
  const totalSec = Math.floor(frame / f);
  const ss = ((totalSec % 60) + 60) % 60;
  const mm = (Math.floor(totalSec / 60) % 60 + 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const p2 = (n: number) => String(Math.abs(n)).padStart(2, "0");
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}:${p2(ff)}`;
}

// トラックのラベル列幅（左パネル）。グラフ領域はこれを引いた残り。
const LABEL_W = 270;

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

// §21.5 KF 複数選択。選択は (objectId, propertyPath, frame) の集合。
type PropPath =
  | "transform.anchor"
  | "transform.position"
  | "transform.scale"
  | "transform.rotation"
  | "opacity";

const KF_SEP = "|";

const kfKey = (objId: string, path: PropPath, frame: number): string =>
  `${objId}${KF_SEP}${path}${KF_SEP}${frame}`;

function parseKfKey(key: string): { objId: string; path: PropPath; frame: number } {
  const i = key.indexOf(KF_SEP);
  const j = key.lastIndexOf(KF_SEP);
  return {
    objId: key.slice(0, i),
    path: key.slice(i + 1, j) as PropPath,
    frame: Number(key.slice(j + 1)),
  };
}

function getPropByPath(obj: SceneObject, path: PropPath): AnimatedProp<unknown> {
  if (path === "opacity") return obj.opacity;
  const key = path.slice("transform.".length) as TransformVecKey;
  return obj.transform[key];
}

function moveKfFrames<T>(prop: AnimatedProp<T>, frames: Set<number>, delta: number): AnimatedProp<T> {
  if (delta === 0) return prop;
  const targets = new Set<number>();
  frames.forEach((f) => targets.add(f + delta));
  const kept = prop.keyframes.filter((k) => !frames.has(k.frame) && !targets.has(k.frame));
  const moved = prop.keyframes
    .filter((k) => frames.has(k.frame))
    .map((k) => ({ ...k, frame: k.frame + delta }));
  return { ...prop, keyframes: [...kept, ...moved].sort((a, b) => a.frame - b.frame) };
}

function deleteKfFrames<T>(prop: AnimatedProp<T>, frames: Set<number>): AnimatedProp<T> {
  return { ...prop, keyframes: prop.keyframes.filter((k) => !frames.has(k.frame)) };
}

// P0-3: 選択 KF のイージングを変更する。
function applyKfEasing<T>(prop: AnimatedProp<T>, frames: Set<number>, easing: Easing): AnimatedProp<T> {
  return { ...prop, keyframes: prop.keyframes.map((k) => frames.has(k.frame) ? { ...k, easing } : k) };
}

function groupSelectedKfs(keys: Iterable<string>): Map<string, Map<PropPath, Set<number>>> {
  const m = new Map<string, Map<PropPath, Set<number>>>();
  for (const key of keys) {
    const { objId, path, frame } = parseKfKey(key);
    let pm = m.get(objId);
    if (!pm) { pm = new Map(); m.set(objId, pm); }
    let fs = pm.get(path);
    if (!fs) { fs = new Set(); pm.set(path, fs); }
    fs.add(frame);
  }
  return m;
}

function buildKfPatches(
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
    for (const [path, frames] of pm) {
      const next = fn(getPropByPath(obj, path), frames);
      if (path === "opacity") {
        patch.opacity = next as AnimatedProp<number>;
      } else {
        const k = path.slice("transform.".length) as TransformVecKey;
        transform = { ...transform, [k]: next as AnimatedProp<Vec3> };
        touchedTransform = true;
      }
    }
    if (touchedTransform) patch.transform = transform;
    patches.push({ id: objId, patch });
  }
  return patches;
}

interface SelectBox { x0: number; y0: number; x1: number; y1: number }
interface KfDragState { keys: Set<string>; delta: number }
interface KfContextMenu { x: number; y: number }

export function TimelinePanel() {
  const project = useEditorStore((s) => s.project);
  const compId = useEditorStore((s) => s.currentCompId);
  const frame = useEditorStore((s) => s.currentFrame);
  const selectedIds = useEditorStore((s) => s.selectedObjectIds);
  const setFrame = useEditorStore((s) => s.setFrame);
  const updateObject = useEditorStore((s) => s.updateObject);
  const addSolid = useEditorStore((s) => s.addSolid);
  const addText = useEditorStore((s) => s.addText);
  const removeObject = useEditorStore((s) => s.removeObject);
  const selectObjects = useEditorStore((s) => s.selectObjects);
  const updateObjects = useEditorStore((s) => s.updateObjects);
  const addHtmlInstance = useEditorStore((s) => s.addHtmlInstance);
  const addAudioLayer = useEditorStore((s) => s.addAudioLayer);
  const addPluginObject = useEditorStore((s) => s.addPluginObject);
  // P0-2: 再生制御はストアで共有
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const togglePlay = useEditorStore((s) => s.togglePlay);

  const comp = currentTimelineComp(project, compId);
  const duration = comp?.duration ?? 150;
  const fps = comp?.fps ?? 30;
  const objects = comp?.objects ?? [];

  // P0-1: ズーム/スクロール状態 — viewRange は表示フレーム範囲（UI 状態, project 非保存）。
  const [viewRange, setViewRange] = useState<{ start: number; end: number }>({ start: 0, end: duration });

  const [expandMode, setExpandMode] = useState<Map<string, ExpandMode>>(new Map());
  const graphRef = useRef<HTMLDivElement>(null);
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const [dropActive, setDropActive] = useState(false);
  const [selectedKfs, setSelectedKfs] = useState<Set<string>>(new Set());
  const [kfDrag, setKfDrag] = useState<KfDragState | null>(null);
  const [box, setBox] = useState<SelectBox | null>(null);
  const [kfContextMenu, setKfContextMenu] = useState<KfContextMenu | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const dragMovedRef = useRef(false);
  const lastUPressRef = useRef<number>(0);

  // comp 切替でビュー・選択・展開をリセット
  useEffect(() => {
    setSelectedKfs(new Set());
    setExpandMode(new Map());
    setViewRange({ start: 0, end: duration });
    setKfContextMenu(null);
  }, [compId]); // eslint-disable-line react-hooks/exhaustive-deps

  // duration 変更時に viewRange.end をクランプ
  useEffect(() => {
    setViewRange((prev) => ({ start: prev.start, end: Math.max(prev.start + 5, Math.min(prev.end, duration)) }));
  }, [duration]);

  // P0-1: frame → % 変換（viewRange 基準）。
  const frameToPercent = (f: number): number => {
    const span = viewRange.end - viewRange.start;
    return span > 0 ? ((f - viewRange.start) / span) * 100 : 0;
  };

  // P0-1: グラフ列の px → frame 変換（viewRange 基準）。
  const pxToFrame = (clientX: number): Frame => {
    const el = graphRef.current;
    if (!el) return frame;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(viewRange.start + ratio * (viewRange.end - viewRange.start));
  };

  // Project パネルからの D&D ドロップ
  const onTimelineDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    try {
      const item = JSON.parse(raw) as { kind: string; id?: string; componentType?: string };
      let newId: string | null = null;
      if (item.kind === "html-comp" && item.id) newId = addHtmlInstance(item.id);
      else if (item.kind === "audio-asset" && item.id) newId = addAudioLayer(item.id);
      else if (item.kind === "plugin-component" && item.componentType) newId = addPluginObject(item.componentType);
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
  const applyEasingToSelectedKfs = (easing: Easing) => {
    if (selectedKfs.size === 0) return;
    const group = groupSelectedKfs(selectedKfs);
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
    setSelectedKfs(next);
  };

  const applyMultiKfDelete = (keys: Set<string>) => {
    if (keys.size === 0) return;
    const group = groupSelectedKfs(keys);
    const patches = buildKfPatches(objects, group, (prop, frames) => deleteKfFrames(prop, frames));
    updateObjects(patches, "Delete keyframes");
    setSelectedKfs(new Set());
  };

  // P0-4: 前後 KF フレームを取得（選択中レイヤーまたは全レイヤー）。
  const getKfFrames = (): number[] => {
    const targetObjs = selectedIds.length > 0 ? objects.filter((o) => selectedIds.includes(o.id)) : objects;
    const frameSet = new Set<number>();
    for (const obj of targetObjs) {
      [obj.transform.anchor, obj.transform.position, obj.transform.rotation, obj.transform.scale, obj.opacity]
        .forEach((prop) => prop.keyframes.forEach((kf) => frameSet.add(kf.frame)));
    }
    return [...frameSet].sort((a, b) => a - b);
  };

  // §21.5 KF ダイヤの mousedown。
  const beginKfDrag = (objId: string, path: PropPath, kfFrame: number, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const key = kfKey(objId, path, kfFrame);
    if (e.shiftKey) {
      setSelectedKfs((prev) => {
        const n = new Set(prev);
        if (n.has(key)) n.delete(key); else n.add(key);
        return n;
      });
      return;
    }
    let dragKeys: Set<string>;
    if (selectedKfs.has(key)) {
      dragKeys = new Set(selectedKfs);
    } else {
      dragKeys = new Set([key]);
      setSelectedKfs(dragKeys);
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
      const raw = Math.round(((ev.clientX - originX) / width) * viewSpan);
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

  // P0-3: KF 右クリックでコンテキストメニュー。
  const handleKfRightClick = (key: string, x: number, y: number) => {
    if (!selectedKfs.has(key)) setSelectedKfs(new Set([key]));
    setKfContextMenu({ x, y });
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
    setSelectedKfs(base);
    setBox({ x0, y0, x1: x0, y1: y0 });
    const move = (ev: MouseEvent) => {
      dragMovedRef.current = true;
      const b: SelectBox = { x0, y0, x1: ev.clientX, y1: ev.clientY };
      setBox(b);
      setSelectedKfs(hitTestBox(b, base));
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
    setFrame(pxToFrame(e.clientX));
    const move = (ev: MouseEvent) => setFrame(pxToFrame(ev.clientX));
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
      // P0-2: Space = 再生/停止
      if (e.code === "Space") { e.preventDefault(); togglePlay(); return; }

      // P0-4: フレームナビゲーション
      if (e.key === "ArrowLeft")  { e.preventDefault(); setFrame(Math.max(0, frame - (e.shiftKey ? 10 : 1))); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); setFrame(Math.min(duration, frame + (e.shiftKey ? 10 : 1))); return; }
      if (e.key === "Home") { e.preventDefault(); setFrame(0); return; }
      if (e.key === "End")  { e.preventDefault(); setFrame(duration); return; }
      // J/K: 前後 KF ジャンプ（AE 準拠）
      if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        const frames = getKfFrames();
        const prev = [...frames].filter((f) => f < frame).pop();
        if (prev !== undefined) setFrame(prev);
        return;
      }
      if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        const frames = getKfFrames();
        const next = frames.find((f) => f > frame);
        if (next !== undefined) setFrame(next);
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

      // P0-1: \ = ビューをリセット（fit all）
      if (e.key === "\\" || e.key === "|") {
        e.preventDefault();
        setViewRange({ start: 0, end: duration });
        return;
      }

      // KF 削除
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedKfs.size > 0) { e.preventDefault(); applyMultiKfDelete(selectedKfs); return; }
      }

      // §21.6 U / UU キー
      if (e.key === "u" || e.key === "U") {
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

  // コンテキストメニューの外クリックで閉じる
  useEffect(() => {
    if (!kfContextMenu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setKfContextMenu(null);
      }
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [kfContextMenu]);

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
          {framesToTimecode(frame, fps)}
        </span>
        <span style={{ color: "#555", fontSize: 10 }}>({fps.toFixed(2)} fps)</span>
        <div style={{ width: 8 }} />
        <button onClick={() => { const id = addSolid(); if (id) selectObjects([id]); }} disabled={!comp} style={btnStyle}>+ Solid</button>
        <button onClick={() => { const id = addText(); if (id) selectObjects([id]); }} disabled={!comp} style={btnStyle}>+ Text</button>
        <div style={{ flex: 1 }} />
        {/* P0-1: ズームリセット */}
        <button
          onClick={() => setViewRange({ start: 0, end: duration })}
          style={{ ...btnStyle, fontSize: 10, padding: "1px 5px" }}
          title="ビューをリセット (\)"
        >fit</button>
        <span style={{ color: "#555", fontVariantNumeric: "tabular-nums" }}>F{frame} / {duration}</span>
      </div>

      {/* time ruler */}
      <div style={{ display: "flex", flexShrink: 0, borderBottom: "1px solid #2a2a2a", background: "#202020" }}>
        <div style={{ width: LABEL_W, boxSizing: "border-box", flexShrink: 0, borderRight: "1px solid #333" }} />
        <div
          ref={graphRef}
          style={{ position: "relative", flex: 1, height: 22, cursor: "pointer", overflow: "hidden" }}
          onMouseDown={startScrub}
        >
          <Ruler viewRange={viewRange} duration={duration} fps={fps} frameToPercent={frameToPercent} />
          <Playhead frame={frame} frameToPercent={frameToPercent} />
        </div>
      </div>

      {/* rows */}
      <div
        ref={rowsRef}
        onMouseDown={onRowsMouseDown}
        onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDropActive(true); } }}
        onDragLeave={(e) => { if (!rowsRef.current?.contains(e.relatedTarget as Node)) setDropActive(false); }}
        onDrop={onTimelineDrop}
        style={{ flex: 1, overflowY: "auto", overflowX: "hidden", position: "relative", outline: dropActive ? "2px solid #5a8fd0" : "none", outlineOffset: -2 }}
      >
        {objects.length === 0 && (
          <div style={{ padding: 16, color: "#444", textAlign: "center" }}>
            No layers — add one with + Solid / + Text above
          </div>
        )}
        {objects.map((obj, i) => (
          <LayerRow
            key={obj.id}
            obj={obj}
            index={objects.length - i}
            duration={duration}
            frame={frame}
            selected={selectedIds.includes(obj.id)}
            expandMode={expandMode.get(obj.id)}
            graphRef={graphRef}
            selectedKfs={selectedKfs}
            kfDrag={kfDrag}
            beginKfDrag={beginKfDrag}
            onKfRightClick={handleKfRightClick}
            onToggleExpand={() => toggleExpand(obj.id)}
            onSelect={() => {
              if (dragMovedRef.current) return;
              selectObjects(selectedIds.includes(obj.id) ? [] : [obj.id]);
            }}
            onRemove={() => removeObject(obj.id)}
            onUpdate={updateObject}
            pxToFrame={pxToFrame}
            frameToPercent={frameToPercent}
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

      {/* P0-3: KF イージングコンテキストメニュー */}
      {kfContextMenu && (
        <div
          ref={menuRef}
          style={{ position: "fixed", left: kfContextMenu.x, top: kfContextMenu.y, zIndex: 9999, background: "#2a2a2a", border: "1px solid #444", borderRadius: 4, padding: 4, minWidth: 160, boxShadow: "0 4px 12px rgba(0,0,0,0.5)" }}
        >
          {[
            { label: "Linear          (Ctrl+F9)", easing: { type: "linear" } as Easing },
            { label: "Easy Ease            (F9)", easing: EASY_EASE },
            { label: "Ease In",                   easing: EASE_IN },
            { label: "Ease Out",                  easing: EASE_OUT },
            { label: "Hold         (Shift+F9)", easing: { type: "hold" } as Easing },
          ].map(({ label, easing }) => (
            <button
              key={label}
              onMouseDown={(e) => { e.stopPropagation(); applyEasingToSelectedKfs(easing); setKfContextMenu(null); }}
              style={menuItemStyle}
            >
              <span style={{ display: "inline-block", width: 10, height: 10, background: easingColor(easing), borderRadius: easing.type === "hold" ? 0 : "50%", marginRight: 6, verticalAlign: "middle" }} />
              {label}
            </button>
          ))}
        </div>
      )}
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

function Ruler({ viewRange, duration, fps, frameToPercent }: {
  viewRange: { start: number; end: number };
  duration: number;
  fps: number;
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

  return (
    <>
      {ticks.map((f) => {
        const left = frameToPercent(f);
        if (left < 0 || left > 100) return null;
        return (
          <div key={f} style={{ position: "absolute", left: `${left}%`, top: 0, height: "100%", borderLeft: "1px solid #3a3a3a", pointerEvents: "none" }}>
            <span style={{ position: "absolute", left: 3, top: 2, fontSize: 9, color: "#777", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
              {framesToTimecode(f, fps)}
            </span>
          </div>
        );
      })}
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
  duration: number;
  frame: Frame;
  selected: boolean;
  expandMode: ExpandMode | undefined;
  graphRef: React.RefObject<HTMLDivElement | null>;
  selectedKfs: Set<string>;
  kfDrag: KfDragState | null;
  beginKfDrag: (objId: string, path: PropPath, frame: number, e: React.MouseEvent) => void;
  onKfRightClick: (key: string, x: number, y: number) => void;
  onToggleExpand: () => void;
  onSelect: () => void;
  onRemove: () => void;
  onUpdate: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  pxToFrame: (clientX: number) => Frame;
  frameToPercent: (f: number) => number;
}

function LayerRow(props: LayerRowProps) {
  const { obj, index, duration, frame, selected, expandMode, selectedKfs, kfDrag, beginKfDrag, onKfRightClick, onToggleExpand, onSelect, onRemove, onUpdate, pxToFrame, frameToPercent } = props;
  const [drag, setDrag] = useState<{ inPoint: number; outPoint: number; mode: "in" | "out" | "move" } | null>(null);
  const inPoint = drag ? drag.inPoint : obj.inPoint;
  const outPoint = drag ? drag.outPoint : obj.outPoint;
  const kfPreviewShift = drag && drag.mode === "move" ? drag.inPoint - obj.inPoint : 0;

  const startBarDrag = (mode: "in" | "out" | "move") => (e: React.MouseEvent) => {
    e.stopPropagation();
    const origin = pxToFrame(e.clientX);
    const startIn = obj.inPoint;
    const startOut = obj.outPoint;
    let last = { inPoint: startIn, outPoint: startOut };

    const move = (ev: MouseEvent) => {
      const delta = pxToFrame(ev.clientX) - origin;
      let nin = startIn;
      let nout = startOut;
      if (mode === "in") {
        nin = Math.min(startOut - 1, Math.max(0, startIn + delta));
      } else if (mode === "out") {
        nout = Math.max(startIn + 1, Math.min(duration, startOut + delta));
      } else {
        const len = startOut - startIn;
        nin = Math.max(0, Math.min(duration - len, startIn + delta));
        nout = nin + len;
      }
      last = { inPoint: nin, outPoint: nout };
      setDrag({ ...last, mode });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDrag(null);
      commitBar(mode, last.inPoint, last.outPoint, startIn);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const commitBar = (mode: "in" | "out" | "move", nin: number, nout: number, startIn: number) => {
    if (nin === obj.inPoint && nout === obj.outPoint) return;
    const patch: Partial<SceneObject> = { inPoint: nin, outPoint: nout };
    if (mode === "in") {
      const dIn = nin - startIn;
      const nextComponents = shiftSourceOffset(obj.components, dIn);
      if (nextComponents) patch.components = nextComponents;
    } else if (mode === "move") {
      const dIn = nin - startIn;
      if (dIn !== 0) Object.assign(patch, shiftObjectKeyframes(obj, dIn));
    }
    onUpdate(obj.id, patch, mode === "move" ? "Slide layer" : "Trim layer");
  };

  const rowBg = selected ? "#2a3a4a" : "transparent";

  return (
    <div style={{ borderBottom: "1px solid #222" }}>
      {/* layer header row */}
      <div style={{ display: "flex", alignItems: "stretch", background: rowBg }}>
        {/* label column */}
        <div
          style={{ width: LABEL_W, boxSizing: "border-box", flexShrink: 0, display: "flex", alignItems: "center", gap: 4, padding: "3px 6px", cursor: "pointer", borderRight: "1px solid #2a2a2a" }}
          onClick={onSelect}
        >
          <button onClick={(e) => { e.stopPropagation(); onToggleExpand(); }} style={caretStyle} title="プロパティを展開（U=KF / UU=変更済み）">
            {expandMode ? "▾" : "▸"}
          </button>
          <span style={{ color: "#666", width: 16, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{index}</span>
          <button
            onClick={(e) => { e.stopPropagation(); onUpdate(obj.id, { enabled: !obj.enabled }, "Toggle visibility"); }}
            style={{ ...iconBtn, opacity: obj.enabled ? 1 : 0.35 }}
            title="表示/非表示"
          >
            {obj.enabled ? "👁" : "—"}
          </button>
          <span style={{ flex: 1, color: selected ? "#7fb8f0" : "#bbb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {obj.name}
          </span>
          <button onClick={(e) => { e.stopPropagation(); onRemove(); }} style={{ ...iconBtn, color: "#f44" }} title="レイヤーを削除">×</button>
        </div>
        {/* graph column: layer bar */}
        <div style={{ position: "relative", flex: 1, minHeight: 22, overflow: "hidden" }} onClick={onSelect}>
          <LayerBar
            inPoint={inPoint}
            outPoint={outPoint}
            selected={selected}
            frameToPercent={frameToPercent}
            onIn={startBarDrag("in")}
            onOut={startBarDrag("out")}
            onMove={startBarDrag("move")}
          />
          <PlayheadTick frame={frame} frameToPercent={frameToPercent} />
        </div>
      </div>

      {/* property tree */}
      {expandMode && (
        <div style={{ background: "#191919" }}>
          {showInMode(expandMode, obj.transform.anchor.keyframes.length > 0,   vec3Modified(obj.transform.anchor,   VEC3_DEFAULTS.anchor))   && <PropRowVec3 obj={obj} k="anchor"   label="アンカーポイント" frame={frame} kfShift={kfPreviewShift} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onKfRightClick={onKfRightClick} onUpdate={onUpdate} frameToPercent={frameToPercent} />}
          {showInMode(expandMode, obj.transform.position.keyframes.length > 0, vec3Modified(obj.transform.position, VEC3_DEFAULTS.position)) && <PropRowVec3 obj={obj} k="position" label="位置"           frame={frame} kfShift={kfPreviewShift} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onKfRightClick={onKfRightClick} onUpdate={onUpdate} frameToPercent={frameToPercent} />}
          {showInMode(expandMode, obj.transform.scale.keyframes.length > 0,    vec3Modified(obj.transform.scale,    VEC3_DEFAULTS.scale))    && <PropRowVec3 obj={obj} k="scale"    label="スケール"         frame={frame} kfShift={kfPreviewShift} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onKfRightClick={onKfRightClick} onUpdate={onUpdate} frameToPercent={frameToPercent} />}
          {showInMode(expandMode, obj.transform.rotation.keyframes.length > 0, vec3Modified(obj.transform.rotation, VEC3_DEFAULTS.rotation)) && <PropRowVec3 obj={obj} k="rotation" label="回転"           frame={frame} kfShift={kfPreviewShift} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onKfRightClick={onKfRightClick} onUpdate={onUpdate} frameToPercent={frameToPercent} />}
          {showInMode(expandMode, obj.opacity.keyframes.length > 0,            scalarModified(obj.opacity, 1))                                && <PropRowOpacity obj={obj} frame={frame} kfShift={kfPreviewShift} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onKfRightClick={onKfRightClick} onUpdate={onUpdate} frameToPercent={frameToPercent} />}
        </div>
      )}
    </div>
  );
}

function LayerBar({
  inPoint, outPoint, selected, frameToPercent, onIn, onOut, onMove,
}: {
  inPoint: number; outPoint: number; selected: boolean;
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
        background: selected ? "#5a8fd0" : "#b89b6a",
        borderRadius: 2,
        cursor: "grab",
        display: "flex",
        alignItems: "stretch",
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
  obj, k, label, frame, kfShift, selectedKfs, kfDrag, beginKfDrag, onKfRightClick, onUpdate, frameToPercent,
}: {
  obj: SceneObject; k: TransformVecKey; label: string; frame: Frame; kfShift: number;
  selectedKfs: Set<string>; kfDrag: KfDragState | null;
  beginKfDrag: (objId: string, path: PropPath, frame: number, e: React.MouseEvent) => void;
  onKfRightClick: (key: string, x: number, y: number) => void;
  onUpdate: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  frameToPercent: (f: number) => number;
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

  const editAxis = (axis: "x" | "y" | "z", raw: string) => {
    const num = Number(raw);
    if (!Number.isFinite(num)) return;
    const nextVal: Vec3 = { ...v, [axis]: num };
    if (animated) writeProp(setKeyframe<Vec3>(prop, frame, nextVal, { type: "linear" } as Easing), `Edit ${k}`);
    else writeProp({ ...prop, value: nextVal }, `Edit ${k}`);
  };

  return (
    <PropRowShell label={label} animated={animated} onStopwatch={toggleStopwatch} prop={prop} frame={frame} kfShift={kfShift} objId={obj.id} propPath={propPath}selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onKfRightClick={onKfRightClick} frameToPercent={frameToPercent}>
      <NumberField value={v.x} onCommit={(r) => editAxis("x", r)} />
      <NumberField value={v.y} onCommit={(r) => editAxis("y", r)} />
      <NumberField value={v.z} onCommit={(r) => editAxis("z", r)} />
    </PropRowShell>
  );
}

function PropRowOpacity({
  obj, frame, kfShift, selectedKfs, kfDrag, beginKfDrag, onKfRightClick, onUpdate, frameToPercent,
}: {
  obj: SceneObject; frame: Frame; kfShift: number;
  selectedKfs: Set<string>; kfDrag: KfDragState | null;
  beginKfDrag: (objId: string, path: PropPath, frame: number, e: React.MouseEvent) => void;
  onKfRightClick: (key: string, x: number, y: number) => void;
  onUpdate: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  frameToPercent: (f: number) => number;
}) {
  const prop = obj.opacity;
  const v = sampleScalar(prop, frame);
  const animated = prop.keyframes.length > 0;

  const writeProp = (next: AnimatedProp<number>, lbl: string) => onUpdate(obj.id, { opacity: next }, lbl);

  const toggleStopwatch = () => {
    if (animated) writeProp({ value: v, keyframes: [] }, "Disable opacity keyframes");
    else writeProp(setKeyframe<number>(prop, frame, v, { type: "linear" } as Easing), "Enable opacity keyframes");
  };

  const edit = (raw: string) => {
    const num = Number(raw);
    if (!Number.isFinite(num)) return;
    const clamped = Math.min(1, Math.max(0, num));
    if (animated) writeProp(setKeyframe<number>(prop, frame, clamped, { type: "linear" } as Easing), "Edit opacity");
    else writeProp({ ...prop, value: clamped }, "Edit opacity");
  };

  return (
    <PropRowShell label="不透明度" animated={animated} onStopwatch={toggleStopwatch} prop={prop} frame={frame} kfShift={kfShift} objId={obj.id} propPath="opacity" selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onKfRightClick={onKfRightClick} frameToPercent={frameToPercent}>
      <NumberField value={v} onCommit={edit} />
    </PropRowShell>
  );
}

function PropRowShell({
  label, animated, onStopwatch, prop, frame, kfShift, objId, propPath, selectedKfs, kfDrag, beginKfDrag, onKfRightClick, frameToPercent, children,
}: {
  label: string; animated: boolean; onStopwatch: () => void;
  prop: AnimatedProp<unknown>; frame: Frame; kfShift: number;
  objId: string; propPath: PropPath; selectedKfs: Set<string>; kfDrag: KfDragState | null;
  beginKfDrag: (objId: string, path: PropPath, frame: number, e: React.MouseEvent) => void;
  onKfRightClick: (key: string, x: number, y: number) => void;
  frameToPercent: (f: number) => number;
  children: React.ReactNode;
}) {
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
      {/* keyframe row in graph column */}
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
    </div>
  );
}

function NumberField({ value, onCommit }: { value: number; onCommit: (raw: string) => void }) {
  const [text, setText] = useState(value.toFixed(1));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(value.toFixed(1));
  }, [value, editing]);
  return (
    <input
      className="tl-num"
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => { setEditing(false); onCommit(text); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      style={{
        width: 44,
        background: "#111",
        border: "1px solid #333",
        color: "#7fb8f0",
        borderRadius: 2,
        padding: "1px 3px",
        fontSize: 11,
        fontVariantNumeric: "tabular-nums",
        userSelect: "text",
      }}
    />
  );
}

// §21.3 footage 系コンポーネントの源時刻オフセットを Δ frame ずらす（左端トリム連動）。
function shiftSourceOffset(components: Component[], deltaFrames: number): Component[] | null {
  if (deltaFrames === 0) return null;
  let changed = false;
  const next = components.map((c) => {
    if (changed) return c;
    if (c.type === "video" || c.type === "audio") {
      const cur = typeof c.props.trimStart === "number" ? c.props.trimStart : 0;
      changed = true;
      return { ...c, props: { ...c.props, trimStart: Math.max(0, cur + deltaFrames) } };
    }
    if (c.type === "html") {
      const cur = typeof c.props.inPoint === "number" ? c.props.inPoint : 0;
      changed = true;
      return { ...c, props: { ...c.props, inPoint: Math.max(0, cur + deltaFrames) } };
    }
    return c;
  });
  return changed ? next : null;
}

function shiftKfProp<T>(prop: AnimatedProp<T>, delta: number): AnimatedProp<T> {
  if (prop.keyframes.length === 0) return prop;
  return { ...prop, keyframes: prop.keyframes.map((k) => ({ ...k, frame: k.frame + delta })) };
}

function isAnimatedProp(v: unknown): v is AnimatedProp<unknown> {
  return typeof v === "object" && v !== null && Array.isArray((v as { keyframes?: unknown }).keyframes);
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
  return { transform, opacity, components };
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

const menuItemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  background: "transparent",
  border: "none",
  color: "#ccc",
  cursor: "pointer",
  fontSize: 11,
  padding: "4px 8px",
  textAlign: "left",
  borderRadius: 2,
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
