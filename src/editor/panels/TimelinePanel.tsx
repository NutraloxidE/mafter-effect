import { useEffect, useRef, useState } from "react";
import { currentTimelineComp, setKeyframe, useEditorStore } from "../store";
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
// ラベル列幅。padding/border 込み（box-sizing: border-box）で全列をこの幅に揃え、
// グラフ列（バー・KF・ルーラー・プレイヘッド）の原点を一致させる。
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

function vec3Modified(prop: AnimatedProp<Vec3>, def: Vec3): boolean {
  if (prop.keyframes.length > 0) return true;
  const v = prop.value;
  return v.x !== def.x || v.y !== def.y || v.z !== def.z;
}

function scalarModified(prop: AnimatedProp<number>, def: number): boolean {
  return prop.keyframes.length > 0 || prop.value !== def;
}

// "kf" モード: KF あり → 表示。"uu" モード: KF あり OR 変更済み → 表示。"all": 常に表示。
function showInMode(mode: ExpandMode, animated: boolean, modified: boolean): boolean {
  if (mode === "all") return true;
  if (animated) return true;
  return mode === "uu" && modified;
}

// §21.5 KF 複数選択。選択は (objectId, propertyPath, frame) の集合。
// propertyPath は Tier A で行表示されるプロパティのみ。
type PropPath =
  | "transform.anchor"
  | "transform.position"
  | "transform.scale"
  | "transform.rotation"
  | "opacity";

const KF_SEP = "|"; // objectId(ULID)/path のどちらにも現れない区切り文字

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

// §21.5 選択 frame 集合を Δ シフト。移動先に居る非選択 KF は上書き（§21.2 と同じ frame=キー規約）。
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

// 選択キー集合を objectId → propertyPath → frame 集合へグループ化。
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

// グループ化済み選択から、各プロパティへ fn を適用した複数オブジェクト patch を作る。
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

  const comp = currentTimelineComp(project, compId);
  const duration = comp?.duration ?? 150;
  const fps = comp?.fps ?? 30;
  const objects = comp?.objects ?? [];

  // caret クリックで "all" / 閉じる。U キーで "kf"、UU で "uu" に切替。
  const [expandMode, setExpandMode] = useState<Map<string, ExpandMode>>(new Map());
  const graphRef = useRef<HTMLDivElement>(null);

  const toggleExpand = (id: string) =>
    setExpandMode((prev) => {
      const next = new Map(prev);
      // caret: "all" → 閉じる。"kf"/"uu"（U キー開き）→ "all" にアップグレード。閉じ → "all"。
      if (next.get(id) === "all") next.delete(id);
      else next.set(id, "all");
      return next;
    });

  // §21.5 KF 複数選択（エディタの一時状態。store/project には載せない）。
  const [selectedKfs, setSelectedKfs] = useState<Set<string>>(new Set());
  const [kfDrag, setKfDrag] = useState<KfDragState | null>(null);
  const [box, setBox] = useState<SelectBox | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  // box-select でドラッグが起きた直後の click を抑止する（レイヤー選択の誤発火防止）。
  const dragMovedRef = useRef(false);

  // §21.5/21.6 アクティブ comp 切替で KF 選択・展開モードをクリア。
  useEffect(() => { setSelectedKfs(new Set()); setExpandMode(new Map()); }, [compId]);

  // §21.6 U / UU キー: 選択レイヤーを "kf" / "uu" モードで展開（再押し = 折りたたむ）。
  const lastUPressRef = useRef<number>(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "u" && e.key !== "U") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (selectedIds.length === 0) return;
      e.preventDefault();
      const now = Date.now();
      const isUU = now - lastUPressRef.current < 300;
      lastUPressRef.current = now;
      const target: ExpandMode = isUU ? "uu" : "kf";
      setExpandMode((prev) => {
        const next = new Map(prev);
        for (const id of selectedIds) {
          if (next.get(id) === target) next.delete(id); // 同じモード → 折りたたむ
          else next.set(id, target);                    // 別モード or 閉じ → そのモードへ
        }
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIds]);

  // §21.5 選択中 KF を Δframe でまとめて移動（複数オブジェクト横断で 1 command）。
  const applyMultiKfMove = (keys: Set<string>, delta: number) => {
    if (delta === 0 || keys.size === 0) return;
    const group = groupSelectedKfs(keys);
    const patches = buildKfPatches(objects, group, (prop, frames) => moveKfFrames(prop, frames, delta));
    updateObjects(patches, "Move keyframes");
    // 選択を移動先 frame へ追従。
    const next = new Set<string>();
    keys.forEach((k) => {
      const { objId, path, frame } = parseKfKey(k);
      next.add(kfKey(objId, path, frame + delta));
    });
    setSelectedKfs(next);
  };

  // §21.5 選択中 KF をまとめて削除。
  const applyMultiKfDelete = (keys: Set<string>) => {
    if (keys.size === 0) return;
    const group = groupSelectedKfs(keys);
    const patches = buildKfPatches(objects, group, (prop, frames) => deleteKfFrames(prop, frames));
    updateObjects(patches, "Delete keyframes");
    setSelectedKfs(new Set());
  };

  // §21.5 KF ダイヤの mousedown。Shift=選択トグル、選択済み=まとめてドラッグ、未選択=単独選択して移動。
  const beginKfDrag = (objId: string, path: PropPath, frame: number, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const key = kfKey(objId, path, frame);
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
    const originX = e.clientX;
    let delta = 0;
    const move = (ev: MouseEvent) => {
      const raw = Math.round(((ev.clientX - originX) / width) * duration);
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

  // §21.5 ラバーバンド選択。グラフ列の空白で mousedown→ドラッグ。
  const onRowsMouseDown = (e: React.MouseEvent) => {
    dragMovedRef.current = false;
    if (e.button !== 0) return;
    const g = graphRef.current?.getBoundingClientRect();
    if (!g || e.clientX < g.left) return; // ラベル列はオブジェクト選択に任せる
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

  // 矩形（client 座標）に中心が入る KF ダイヤを base 集合へ追加した新集合を返す。
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

  // §21.5 Delete/Backspace で選択 KF をまとめて削除（入力欄フォーカス中は無効）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (selectedKfs.size === 0) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      applyMultiKfDelete(selectedKfs);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKfs, objects]);

  // ピクセル→frame 変換（グラフ領域基準）。
  const pxToFrame = (clientX: number): Frame => {
    const el = graphRef.current;
    if (!el) return frame;
    const rect = el.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    return Math.round(Math.min(1, Math.max(0, ratio)) * duration);
  };

  // プレイヘッド / ルーラードラッグ
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#1c1c1c", color: "#ccc", fontSize: 12, userSelect: "none" }}>
      {/* toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", background: "#222", borderBottom: "1px solid #333", flexShrink: 0 }}>
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
        <span style={{ color: "#555", fontVariantNumeric: "tabular-nums" }}>F{frame} / {duration}</span>
      </div>

      {/* time ruler */}
      <div style={{ display: "flex", flexShrink: 0, borderBottom: "1px solid #2a2a2a", background: "#202020" }}>
        <div style={{ width: LABEL_W, boxSizing: "border-box", flexShrink: 0, borderRight: "1px solid #333" }} />
        <div
          ref={graphRef}
          style={{ position: "relative", flex: 1, height: 22, cursor: "pointer" }}
          onMouseDown={startScrub}
        >
          <Ruler duration={duration} fps={fps} />
          <Playhead frame={frame} duration={duration} />
        </div>
      </div>

      {/* rows */}
      <div ref={rowsRef} onMouseDown={onRowsMouseDown} style={{ flex: 1, overflow: "auto", position: "relative" }}>
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
            onToggleExpand={() => toggleExpand(obj.id)}
            onSelect={() => {
              if (dragMovedRef.current) return; // box-select 直後の click を無視
              selectObjects(selectedIds.includes(obj.id) ? [] : [obj.id]);
            }}
            onRemove={() => removeObject(obj.id)}
            onUpdate={updateObject}
            pxToFrame={pxToFrame}
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
    </div>
  );
}

function Ruler({ duration, fps }: { duration: number; fps: number }) {
  // 概ね 1 秒刻みで目盛りを打つ（秒数が多い場合は間引く）。
  const totalSec = duration / fps;
  const stepSec = totalSec > 20 ? 5 : totalSec > 8 ? 2 : 1;
  const ticks: number[] = [];
  for (let s = 0; s * fps <= duration; s += stepSec) ticks.push(s);
  return (
    <>
      {ticks.map((s) => {
        const left = ((s * fps) / duration) * 100;
        return (
          <div key={s} style={{ position: "absolute", left: `${left}%`, top: 0, height: "100%", borderLeft: "1px solid #3a3a3a" }}>
            <span style={{ position: "absolute", left: 3, top: 2, fontSize: 9, color: "#777", fontVariantNumeric: "tabular-nums" }}>
              {framesToTimecode(Math.round(s * fps), fps)}
            </span>
          </div>
        );
      })}
    </>
  );
}

function Playhead({ frame, duration }: { frame: number; duration: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: `${(frame / duration) * 100}%`,
        top: 0,
        width: 1,
        height: "100%",
        background: "#f04",
        zIndex: 5,
      }}
    >
      <div style={{ position: "absolute", top: 0, left: -3, width: 7, height: 7, background: "#f04" }} />
    </div>
  );
}

// 各行の graph セルに描く細いプレイヘッド線。
// overflow:auto コンテナ内で position:absolute bottom:0 が scrollHeight まで伸びない問題を回避するため、
// オーバーレイ 1 枚ではなく全行に個別描画して自然にスクロールコンテンツ全体をカバーする。
function PlayheadTick({ frame, duration }: { frame: number; duration: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: `${(frame / duration) * 100}%`,
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
  onToggleExpand: () => void;
  onSelect: () => void;
  onRemove: () => void;
  onUpdate: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  pxToFrame: (clientX: number) => Frame;
}

function LayerRow(props: LayerRowProps) {
  const { obj, index, duration, frame, selected, expandMode, selectedKfs, kfDrag, beginKfDrag, onToggleExpand, onSelect, onRemove, onUpdate, pxToFrame } = props;
  // ドラッグ中のプレビュー値（mouseup で command 確定）
  const [drag, setDrag] = useState<{ inPoint: number; outPoint: number; mode: "in" | "out" | "move" } | null>(null);
  const inPoint = drag ? drag.inPoint : obj.inPoint;
  const outPoint = drag ? drag.outPoint : obj.outPoint;
  // §21.3 スライド中はキーフレームも追従させる（プレビュー）。トリムは 0。
  const kfPreviewShift = drag && drag.mode === "move" ? drag.inPoint - obj.inPoint : 0;

  // §21.3 レイヤーバー drag。mode: "in" | "out" | "move"
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
        // slide: 尺保持・inPoint>=0 にクランプ
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

  // ドラッグ確定: inPoint/outPoint を patch。左端トリム時は footage 源オフセットを連動（§21.3）。
  const commitBar = (mode: "in" | "out" | "move", nin: number, nout: number, startIn: number) => {
    if (nin === obj.inPoint && nout === obj.outPoint) return;
    const patch: Partial<SceneObject> = { inPoint: nin, outPoint: nout };
    if (mode === "in") {
      const dIn = nin - startIn;
      const nextComponents = shiftSourceOffset(obj.components, dIn);
      if (nextComponents) patch.components = nextComponents;
    } else if (mode === "move") {
      // §21.3 スライドはアニメーション全体を追従させる: 全 AnimatedProp の KF を Δ シフト。
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
        <div style={{ position: "relative", flex: 1, minHeight: 22 }} onClick={onSelect}>
          <LayerBar
            inPoint={inPoint}
            outPoint={outPoint}
            duration={duration}
            selected={selected}
            onIn={startBarDrag("in")}
            onOut={startBarDrag("out")}
            onMove={startBarDrag("move")}
          />
          <PlayheadTick frame={frame} duration={duration} />
        </div>
      </div>

      {/* property tree — mode: undefined=閉じ / "all"=全行 / "kf"=KFあり行 / "uu"=変更済み行 */}
      {expandMode && (
        <div style={{ background: "#191919" }}>
          {showInMode(expandMode, obj.transform.anchor.keyframes.length > 0,   vec3Modified(obj.transform.anchor,   VEC3_DEFAULTS.anchor))   && <PropRowVec3 obj={obj} k="anchor"   label="アンカーポイント" frame={frame} duration={duration} kfShift={kfPreviewShift} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onUpdate={onUpdate} />}
          {showInMode(expandMode, obj.transform.position.keyframes.length > 0, vec3Modified(obj.transform.position, VEC3_DEFAULTS.position)) && <PropRowVec3 obj={obj} k="position" label="位置"           frame={frame} duration={duration} kfShift={kfPreviewShift} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onUpdate={onUpdate} />}
          {showInMode(expandMode, obj.transform.scale.keyframes.length > 0,    vec3Modified(obj.transform.scale,    VEC3_DEFAULTS.scale))    && <PropRowVec3 obj={obj} k="scale"    label="スケール"         frame={frame} duration={duration} kfShift={kfPreviewShift} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onUpdate={onUpdate} />}
          {showInMode(expandMode, obj.transform.rotation.keyframes.length > 0, vec3Modified(obj.transform.rotation, VEC3_DEFAULTS.rotation)) && <PropRowVec3 obj={obj} k="rotation" label="回転"           frame={frame} duration={duration} kfShift={kfPreviewShift} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onUpdate={onUpdate} />}
          {showInMode(expandMode, obj.opacity.keyframes.length > 0,            scalarModified(obj.opacity, 1))                                && <PropRowOpacity obj={obj} frame={frame} duration={duration} kfShift={kfPreviewShift} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag} onUpdate={onUpdate} />}
        </div>
      )}
    </div>
  );
}

function LayerBar({
  inPoint, outPoint, duration, selected, onIn, onOut, onMove,
}: {
  inPoint: number; outPoint: number; duration: number; selected: boolean;
  onIn: (e: React.MouseEvent) => void; onOut: (e: React.MouseEvent) => void; onMove: (e: React.MouseEvent) => void;
}) {
  const left = (inPoint / duration) * 100;
  const width = ((outPoint - inPoint) / duration) * 100;
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
  obj, k, label, frame, duration, kfShift, selectedKfs, kfDrag, beginKfDrag, onUpdate,
}: {
  obj: SceneObject; k: TransformVecKey; label: string; frame: Frame; duration: number; kfShift: number;
  selectedKfs: Set<string>; kfDrag: KfDragState | null;
  beginKfDrag: (objId: string, path: PropPath, frame: number, e: React.MouseEvent) => void;
  onUpdate: (id: string, patch: Partial<SceneObject>, label?: string) => void;
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
    <PropRowShell label={label} animated={animated} onStopwatch={toggleStopwatch} prop={prop} frame={frame} duration={duration} kfShift={kfShift} objId={obj.id} propPath={propPath} selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag}>
      <NumberField value={v.x} onCommit={(r) => editAxis("x", r)} />
      <NumberField value={v.y} onCommit={(r) => editAxis("y", r)} />
      <NumberField value={v.z} onCommit={(r) => editAxis("z", r)} />
    </PropRowShell>
  );
}

function PropRowOpacity({
  obj, frame, duration, kfShift, selectedKfs, kfDrag, beginKfDrag, onUpdate,
}: {
  obj: SceneObject; frame: Frame; duration: number; kfShift: number;
  selectedKfs: Set<string>; kfDrag: KfDragState | null;
  beginKfDrag: (objId: string, path: PropPath, frame: number, e: React.MouseEvent) => void;
  onUpdate: (id: string, patch: Partial<SceneObject>, label?: string) => void;
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
    <PropRowShell label="不透明度" animated={animated} onStopwatch={toggleStopwatch} prop={prop} frame={frame} duration={duration} kfShift={kfShift} objId={obj.id} propPath="opacity" selectedKfs={selectedKfs} kfDrag={kfDrag} beginKfDrag={beginKfDrag}>
      <NumberField value={v} onCommit={edit} />
    </PropRowShell>
  );
}

function PropRowShell({
  label, animated, onStopwatch, prop, frame, duration, kfShift, objId, propPath, selectedKfs, kfDrag, beginKfDrag, children,
}: {
  label: string; animated: boolean; onStopwatch: () => void;
  prop: AnimatedProp<unknown>; frame: Frame; duration: number; kfShift: number;
  objId: string; propPath: PropPath; selectedKfs: Set<string>; kfDrag: KfDragState | null;
  beginKfDrag: (objId: string, path: PropPath, frame: number, e: React.MouseEvent) => void;
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
      <div style={{ position: "relative", flex: 1, minHeight: 20 }}>
        <PlayheadTick frame={frame} duration={duration} />
        {prop.keyframes.map((kf) => {
          const key = kfKey(objId, propPath, kf.frame);
          const selected = selectedKfs.has(key);
          const inDrag = kfDrag !== null && kfDrag.keys.has(key);
          const displayFrame = (inDrag ? kf.frame + kfDrag.delta : kf.frame) + kfShift;
          const bg = selected ? "#5a9ff0" : kf.frame === frame ? "#f0c040" : "#caa";
          return (
            <span
              key={kf.frame}
              data-kf-key={key}
              onMouseDown={(e) => beginKfDrag(objId, propPath, kf.frame, e)}
              style={{
                position: "absolute",
                left: `${(displayFrame / duration) * 100}%`,
                top: "50%",
                transform: "translate(-50%, -50%) rotate(45deg)",
                width: 9,
                height: 9,
                background: bg,
                outline: selected ? "1px solid #fff" : "none",
                cursor: "ew-resize",
              }}
              title={`KF @ frame ${kf.frame}（ドラッグで移動 / Shift+クリックで選択 / ドラッグで矩形選択）`}
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
// video/audio は trimStart、html は内部 inPoint を更新。clamp >= 0。
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

// §21.3 スライド時: オブジェクトの全 AnimatedProp の Keyframe.frame を Δ シフトする。
// transform 各軸 / opacity / component props（AnimatedProp なもの）を対象に、KF があるものだけ差し替える。
function shiftKfProp<T>(prop: AnimatedProp<T>, delta: number): AnimatedProp<T> {
  if (prop.keyframes.length === 0) return prop;
  return { ...prop, keyframes: prop.keyframes.map((k) => ({ ...k, frame: k.frame + delta })) };
}

function isAnimatedProp(v: unknown): v is AnimatedProp<unknown> {
  return typeof v === "object" && v !== null && Array.isArray((v as { keyframes?: unknown }).keyframes);
}

function shiftObjectKeyframes(
  obj: SceneObject,
  delta: number,
): Partial<SceneObject> {
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
