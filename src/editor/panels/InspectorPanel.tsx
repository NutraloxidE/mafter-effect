import { sampleScalar } from "../../runtime/interpolate";
import type { Easing, Vec3 } from "../../core/schema";
import {
  currentTimelineComp,
  propVec3ToDisplay,
  setKeyframe,
  useEditorStore,
} from "../store";

const EASING_PRESETS: { label: string; easing: Easing }[] = [
  { label: "Linear", easing: { type: "linear" } },
  { label: "Ease In Out", easing: { type: "bezier", bezier: [0.42, 0, 0.58, 1] } },
  { label: "Ease In", easing: { type: "bezier", bezier: [0.42, 0, 1, 1] } },
  { label: "Ease Out", easing: { type: "bezier", bezier: [0, 0, 0.58, 1] } },
  { label: "Snappy Out", easing: { type: "bezier", bezier: [0.2, 0.9, 0.1, 1.0] } },
  { label: "Hold", easing: { type: "hold" } },
];

export function InspectorPanel() {
  const project = useEditorStore((s) => s.project);
  const compId = useEditorStore((s) => s.currentCompId);
  const frame = useEditorStore((s) => s.currentFrame);
  const selectedIds = useEditorStore((s) => s.selectedObjectIds);
  const updateObject = useEditorStore((s) => s.updateObject);

  const comp = currentTimelineComp(project, compId);
  const obj = comp?.objects.find((o) => o.id === selectedIds[0]);

  if (!obj) {
    return (
      <div style={{ padding: 16, color: "#555", fontSize: 12 }}>
        Select an object to inspect
      </div>
    );
  }

  const pos = propVec3ToDisplay(obj.transform.position, frame);
  const anchor = propVec3ToDisplay(obj.transform.anchor, frame);
  const rot = propVec3ToDisplay(obj.transform.rotation, frame);
  const scl = propVec3ToDisplay(obj.transform.scale, frame);
  const opacity = sampleScalar(obj.opacity, frame);

  const setVec3Kf = (
    key: "position" | "anchor" | "rotation" | "scale",
    v: Vec3,
    easing: Easing = { type: "linear" },
  ) => {
    updateObject(obj.id, {
      transform: {
        ...obj.transform,
        [key]: setKeyframe(obj.transform[key], frame, v, easing),
      },
    }, `Set ${key}`);
  };

  const setOpacityKf = (v: number) => {
    updateObject(obj.id, { opacity: setKeyframe(obj.opacity, frame, v) }, "Set opacity");
  };

  return (
    <div style={{ fontSize: 12, color: "#ccc", padding: 8, overflow: "auto", height: "100%", background: "#1c1c1c" }}>
      <div style={{ marginBottom: 8, fontWeight: "bold", color: "#eee" }}>{obj.name}</div>

      <Section label="Transform">
        <Vec3Row label="Position" vals={pos}
          onChange={(v) => setVec3Kf("position", v)}
          hasKf={obj.transform.position.keyframes.length > 0}
        />
        <Vec3Row label="Anchor" vals={anchor}
          onChange={(v) => setVec3Kf("anchor", v)}
          hasKf={obj.transform.anchor.keyframes.length > 0}
        />
        <Vec3Row label="Rotation" vals={rot}
          onChange={(v) => setVec3Kf("rotation", v)}
          hasKf={obj.transform.rotation.keyframes.length > 0}
        />
        <Vec3Row label="Scale" vals={scl}
          onChange={(v) => setVec3Kf("scale", v)}
          hasKf={obj.transform.scale.keyframes.length > 0}
        />
        <Row label="Opacity">
          <input
            type="range" min={0} max={1} step={0.01}
            value={opacity}
            onChange={(e) => setOpacityKf(Number(e.target.value))}
            style={{ width: 80 }}
          />
          <NumInput value={opacity} onChange={setOpacityKf} step={0.01} />
        </Row>
      </Section>

      {/* Keyframe easing selector for selected prop */}
      <Section label="Keyframes">
        <div style={{ color: "#888", marginBottom: 4 }}>
          Position: {obj.transform.position.keyframes.length} kf
        </div>
        {obj.transform.position.keyframes.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {EASING_PRESETS.map((p) => (
              <button
                key={p.label}
                style={{ ...btnStyle, fontSize: 10 }}
                onClick={() => {
                  // 直近 KF の easing を選択した preset に変更する
                  const kfs = [...obj.transform.position.keyframes];
                  // 現フレームより前の最後の KF を探す
                  let idx = -1;
                  for (let i = kfs.length - 1; i >= 0; i--) {
                    if ((kfs[i]?.frame ?? Infinity) <= frame) { idx = i; break; }
                  }
                  if (idx < 0) idx = 0;
                  const updated = kfs.map((k, i) => i === idx ? { ...k, easing: p.easing } : k);
                  updateObject(obj.id, {
                    transform: {
                      ...obj.transform,
                      position: { ...obj.transform.position, keyframes: updated },
                    },
                  }, `Easing: ${p.label}`);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section label="In / Out">
        <Row label="In">
          <NumInput value={obj.inPoint} step={1}
            onChange={(v) => updateObject(obj.id, { inPoint: Math.floor(v) }, "Set inPoint")} />
        </Row>
        <Row label="Out">
          <NumInput value={obj.outPoint} step={1}
            onChange={(v) => updateObject(obj.id, { outPoint: Math.floor(v) }, "Set outPoint")} />
        </Row>
      </Section>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ color: "#888", marginBottom: 4, textTransform: "uppercase", fontSize: 10, letterSpacing: 1 }}>{label}</div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
      <span style={{ color: "#666", width: 52, textAlign: "right", flexShrink: 0 }}>{label}</span>
      {children}
    </div>
  );
}

function Vec3Row({
  label, vals, onChange, hasKf,
}: {
  label: string;
  vals: { x: string; y: string; z: string };
  onChange: (v: Vec3) => void;
  hasKf: boolean;
}) {
  const commit = (axis: "x" | "y" | "z", raw: string) => {
    const n = parseFloat(raw);
    if (isNaN(n)) return;
    onChange({
      x: axis === "x" ? n : parseFloat(vals.x),
      y: axis === "y" ? n : parseFloat(vals.y),
      z: axis === "z" ? n : parseFloat(vals.z),
    });
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
      <span style={{ color: "#666", width: 52, textAlign: "right", flexShrink: 0 }}>{label}</span>
      <span style={{ color: hasKf ? "#f0c040" : "#555", fontSize: 9 }}>⬦</span>
      {(["x", "y", "z"] as const).map((ax) => (
        <label key={ax} style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <span style={{ color: "#555", fontSize: 10 }}>{ax.toUpperCase()}</span>
          <input
            style={numInputStyle}
            defaultValue={vals[ax]}
            key={`${ax}-${vals[ax]}`}
            onBlur={(e) => commit(ax, e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && commit(ax, e.currentTarget.value)}
          />
        </label>
      ))}
    </div>
  );
}

function NumInput({ value, onChange, step = 1 }: { value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <input
      style={numInputStyle}
      defaultValue={value.toFixed(step < 0.1 ? 2 : 1)}
      key={value.toFixed(3)}
      onBlur={(e) => { const n = parseFloat(e.currentTarget.value); if (!isNaN(n)) onChange(n); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { const n = parseFloat(e.currentTarget.value); if (!isNaN(n)) onChange(n); }
      }}
    />
  );
}

const numInputStyle: React.CSSProperties = {
  width: 52,
  background: "#2a2a2a",
  border: "1px solid #444",
  color: "#ddd",
  borderRadius: 3,
  padding: "2px 4px",
  fontSize: 11,
  fontVariantNumeric: "tabular-nums",
};

const btnStyle: React.CSSProperties = {
  background: "#2a2a2a",
  border: "1px solid #444",
  color: "#bbb",
  borderRadius: 3,
  padding: "2px 5px",
  cursor: "pointer",
};
