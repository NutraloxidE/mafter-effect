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
const LABEL_W = 230;

type TransformVecKey = "anchor" | "position" | "rotation" | "scale";

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

  const comp = currentTimelineComp(project, compId);
  const duration = comp?.duration ?? 150;
  const fps = comp?.fps ?? 30;
  const objects = comp?.objects ?? [];

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const graphRef = useRef<HTMLDivElement>(null);

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#1c1c1c", color: "#ccc", fontSize: 12 }}>
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
        <div style={{ width: LABEL_W, flexShrink: 0, borderRight: "1px solid #333" }} />
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
      <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
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
            isExpanded={expanded.has(obj.id)}
            graphRef={graphRef}
            onToggleExpand={() => toggleExpand(obj.id)}
            onSelect={() => selectObjects(selectedIds.includes(obj.id) ? [] : [obj.id])}
            onRemove={() => removeObject(obj.id)}
            onUpdate={updateObject}
            pxToFrame={pxToFrame}
          />
        ))}
        {/* global playhead overlay over graph column */}
        {objects.length > 0 && (
          <div style={{ position: "absolute", top: 0, left: LABEL_W, right: 0, bottom: 0, pointerEvents: "none" }}>
            <Playhead frame={frame} duration={duration} />
          </div>
        )}
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

interface LayerRowProps {
  obj: SceneObject;
  index: number;
  duration: number;
  frame: Frame;
  selected: boolean;
  isExpanded: boolean;
  graphRef: React.RefObject<HTMLDivElement | null>;
  onToggleExpand: () => void;
  onSelect: () => void;
  onRemove: () => void;
  onUpdate: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  pxToFrame: (clientX: number) => Frame;
}

function LayerRow(props: LayerRowProps) {
  const { obj, index, duration, frame, selected, isExpanded, onToggleExpand, onSelect, onRemove, onUpdate, pxToFrame } = props;
  // ドラッグ中のプレビュー値（mouseup で command 確定）
  const [drag, setDrag] = useState<{ inPoint: number; outPoint: number } | null>(null);
  const inPoint = drag ? drag.inPoint : obj.inPoint;
  const outPoint = drag ? drag.outPoint : obj.outPoint;

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
      setDrag(last);
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
    }
    onUpdate(obj.id, patch, "Trim layer");
  };

  const rowBg = selected ? "#2a3a4a" : "transparent";

  return (
    <div style={{ borderBottom: "1px solid #222" }}>
      {/* layer header row */}
      <div style={{ display: "flex", alignItems: "stretch", background: rowBg }}>
        {/* label column */}
        <div
          style={{ width: LABEL_W, flexShrink: 0, display: "flex", alignItems: "center", gap: 4, padding: "3px 6px", cursor: "pointer", borderRight: "1px solid #2a2a2a" }}
          onClick={onSelect}
        >
          <button onClick={(e) => { e.stopPropagation(); onToggleExpand(); }} style={caretStyle} title="プロパティを展開">
            {isExpanded ? "▾" : "▸"}
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
        </div>
      </div>

      {/* property tree */}
      {isExpanded && (
        <div style={{ background: "#191919" }}>
          <PropRowVec3 obj={obj} k="anchor" label="アンカーポイント" frame={frame} duration={duration} onUpdate={onUpdate} />
          <PropRowVec3 obj={obj} k="position" label="位置" frame={frame} duration={duration} onUpdate={onUpdate} />
          <PropRowVec3 obj={obj} k="scale" label="スケール" frame={frame} duration={duration} onUpdate={onUpdate} />
          <PropRowVec3 obj={obj} k="rotation" label="回転" frame={frame} duration={duration} onUpdate={onUpdate} />
          <PropRowOpacity obj={obj} frame={frame} duration={duration} onUpdate={onUpdate} />
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
  obj, k, label, frame, duration, onUpdate,
}: {
  obj: SceneObject; k: TransformVecKey; label: string; frame: Frame; duration: number;
  onUpdate: (id: string, patch: Partial<SceneObject>, label?: string) => void;
}) {
  const prop = obj.transform[k];
  const v = sampleVec3(prop, frame);
  const animated = prop.keyframes.length > 0;

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
    <PropRowShell label={label} animated={animated} onStopwatch={toggleStopwatch} prop={prop} frame={frame} duration={duration}>
      <NumberField value={v.x} onCommit={(r) => editAxis("x", r)} />
      <NumberField value={v.y} onCommit={(r) => editAxis("y", r)} />
      <NumberField value={v.z} onCommit={(r) => editAxis("z", r)} />
    </PropRowShell>
  );
}

function PropRowOpacity({
  obj, frame, duration, onUpdate,
}: {
  obj: SceneObject; frame: Frame; duration: number;
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
    <PropRowShell label="不透明度" animated={animated} onStopwatch={toggleStopwatch} prop={prop} frame={frame} duration={duration}>
      <NumberField value={v} onCommit={edit} />
    </PropRowShell>
  );
}

function PropRowShell({
  label, animated, onStopwatch, prop, frame, duration, children,
}: {
  label: string; animated: boolean; onStopwatch: () => void;
  prop: AnimatedProp<unknown>; frame: Frame; duration: number; children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "stretch", borderTop: "1px solid #202020" }}>
      <div style={{ width: LABEL_W, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "2px 6px 2px 30px", borderRight: "1px solid #2a2a2a" }}>
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
        {prop.keyframes.map((kf) => (
          <span
            key={kf.frame}
            style={{
              position: "absolute",
              left: `${(kf.frame / duration) * 100}%`,
              top: "50%",
              transform: "translate(-50%, -50%) rotate(45deg)",
              width: 7,
              height: 7,
              background: kf.frame === frame ? "#f0c040" : "#caa",
            }}
            title={`KF @ frame ${kf.frame}`}
          />
        ))}
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
