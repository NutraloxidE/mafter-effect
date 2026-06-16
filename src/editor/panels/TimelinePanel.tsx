import { currentTimelineComp, setKeyframe, useEditorStore } from "../store";
import type { AnimatedProp, Easing, Vec3 } from "../../core/schema";
import { sampleScalar, sampleVec3 } from "../../runtime/interpolate";

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

  const objects = comp?.objects ?? [];

  const addKeyframeForSelected = (propName: "position" | "opacity") => {
    if (!comp) return;
    for (const id of selectedIds) {
      const obj = comp.objects.find((o) => o.id === id);
      if (!obj) continue;
      if (propName === "position") {
        const currentVal = sampleVec3(obj.transform.position, frame);
        const easing: Easing = { type: "linear" };
        updateObject(id, {
          transform: {
            ...obj.transform,
            position: setKeyframe<Vec3>(obj.transform.position, frame, currentVal, easing),
          },
        }, "Add position keyframe");
      } else {
        const currentVal = sampleScalar(obj.opacity, frame);
        updateObject(id, {
          opacity: setKeyframe<number>(obj.opacity, frame, currentVal),
        }, "Add opacity keyframe");
      }
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#1c1c1c", color: "#ccc", fontSize: 12 }}>
      {/* toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", background: "#222", borderBottom: "1px solid #333", flexShrink: 0 }}>
        <span style={{ color: "#888" }}>Timeline</span>
        {comp && <span style={{ color: "#9bd", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>· {comp.name}</span>}
        <div style={{ width: 8 }} />
        <button onClick={() => { const id = addSolid(); if (id) selectObjects([id]); }} disabled={!comp} style={btnStyle}>+ Solid</button>
        <button onClick={() => { const id = addText(); if (id) selectObjects([id]); }} disabled={!comp} style={btnStyle}>+ Text</button>
        <div style={{ flex: 1 }} />
        {selectedIds.length > 0 && (
          <>
            <button onClick={() => addKeyframeForSelected("position")} style={btnStyle}>⬦ pos</button>
            <button onClick={() => addKeyframeForSelected("opacity")} style={btnStyle}>⬦ opacity</button>
          </>
        )}
      </div>

      {/* scrubber */}
      <div style={{ padding: "6px 8px", borderBottom: "1px solid #2a2a2a", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "#666", width: 50, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>F{frame}</span>
          <input
            type="range"
            min={0}
            max={duration}
            value={frame}
            onChange={(e) => setFrame(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{ color: "#666", width: 50, fontVariantNumeric: "tabular-nums" }}>{duration}</span>
        </div>
      </div>

      {/* object rows */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {objects.length === 0 && (
          <div style={{ padding: 16, color: "#444", textAlign: "center" }}>
            No layers — add one with + Solid / + Text above
          </div>
        )}
        {objects.map((obj) => {
          const isSelected = selectedIds.includes(obj.id);
          return (
            <div
              key={obj.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "3px 8px",
                background: isSelected ? "#2a3a4a" : "transparent",
                cursor: "pointer",
                borderBottom: "1px solid #222",
              }}
              onClick={() =>
                useEditorStore.getState().selectObjects(isSelected ? [] : [obj.id])
              }
            >
              {/* visibility toggle */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  useEditorStore.getState().updateObject(obj.id, { enabled: !obj.enabled }, "Toggle visibility");
                }}
                style={{ ...btnStyle, padding: "1px 5px", opacity: obj.enabled ? 1 : 0.4 }}
              >
                {obj.enabled ? "👁" : "—"}
              </button>
              <span style={{ flex: 1, color: isSelected ? "#7fb8f0" : "#bbb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {obj.name}
              </span>
              {/* keyframe diamond indicators */}
              <KfIndicator prop={obj.transform.position} frame={frame} label="P" />
              <KfIndicator prop={obj.opacity} frame={frame} label="O" />
              {/* in/out bar */}
              <div style={{ position: "relative", width: 80, height: 10, background: "#111" }}>
                <div
                  style={{
                    position: "absolute",
                    left: `${(obj.inPoint / duration) * 100}%`,
                    width: `${((obj.outPoint - obj.inPoint) / duration) * 100}%`,
                    top: 2,
                    height: 6,
                    background: isSelected ? "#4a8acf" : "#3a5a7a",
                    borderRadius: 2,
                  }}
                />
                {/* current frame indicator */}
                <div
                  style={{
                    position: "absolute",
                    left: `${(frame / duration) * 100}%`,
                    top: 0,
                    width: 1,
                    height: "100%",
                    background: "#f04",
                  }}
                />
              </div>
              {/* delete layer */}
              <button
                onClick={(e) => { e.stopPropagation(); removeObject(obj.id); }}
                style={{ ...btnStyle, padding: "1px 5px", color: "#f44", border: "none", background: "transparent" }}
                title="レイヤーを削除"
              >×</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function KfIndicator({ prop, frame, label }: { prop: AnimatedProp<unknown>; frame: number; label: string }) {
  const hasKfAtFrame = prop.keyframes.some((k) => k.frame === frame);
  const hasAnyKf = prop.keyframes.length > 0;
  return (
    <span
      style={{
        fontSize: 9,
        color: hasKfAtFrame ? "#f0c040" : hasAnyKf ? "#666" : "#333",
        fontWeight: hasKfAtFrame ? "bold" : "normal",
      }}
      title={label}
    >
      {label}⬦
    </span>
  );
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
