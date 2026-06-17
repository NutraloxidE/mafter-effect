import { sampleScalar, sampleVec3 } from "../../runtime/interpolate";
import type { Easing, SceneObject, Transform, Vec3 } from "../../core/schema";
import {
  currentTimelineComp,
  propVec3ToDisplay,
  setKeyframe,
  useEditorStore,
} from "../store";
import { ScrubNumber } from "../ScrubNumber";

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
  const updateObjects = useEditorStore((s) => s.updateObjects);
  const addWiggleExpression = useEditorStore((s) => s.addWiggleExpression);

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

  // Vec3 プロパティを設定。複数選択時は deltaParts を使って各オブジェクトに差分適用。
  const setVec3Kf = (
    key: "position" | "anchor" | "rotation" | "scale",
    v: Vec3,
    deltaParts?: Partial<Vec3>,
    easing: Easing = { type: "linear" },
  ) => {
    if (!comp) return;

    const buildTransform = (o: SceneObject, value: Vec3): Transform => ({
      ...o.transform,
      [key]: o.transform[key].keyframes.length > 0
        ? setKeyframe(o.transform[key], frame, value, easing)
        : { ...o.transform[key], value },
    });

    if (selectedIds.length > 1) {
      const patches = comp.objects
        .filter((o) => selectedIds.includes(o.id))
        .map((o) => {
          let value: Vec3;
          if (deltaParts) {
            const cur = sampleVec3(o.transform[key], frame);
            value = {
              x: cur.x + (deltaParts.x ?? 0),
              y: cur.y + (deltaParts.y ?? 0),
              z: cur.z + (deltaParts.z ?? 0),
            };
          } else {
            value = v;
          }
          return { id: o.id, patch: { transform: buildTransform(o, value) } };
        });
      updateObjects(patches, `Set ${key}`);
    } else {
      updateObject(obj.id, { transform: buildTransform(obj, v) }, `Set ${key}`);
    }
  };

  // opacity を設定。複数選択時は delta 差分適用（テキスト入力時は同値）。
  const setOpacityKf = (v: number, delta?: number) => {
    if (!comp) return;

    const buildPatch = (o: SceneObject, value: number) => ({
      opacity: o.opacity.keyframes.length > 0
        ? setKeyframe(o.opacity, frame, value)
        : { ...o.opacity, value },
    });

    if (selectedIds.length > 1) {
      const patches = comp.objects
        .filter((o) => selectedIds.includes(o.id))
        .map((o) => {
          const value = delta !== undefined
            ? Math.min(1, Math.max(0, sampleScalar(o.opacity, frame) + delta))
            : v;
          return { id: o.id, patch: buildPatch(o, value) };
        });
      updateObjects(patches, "Set opacity");
    } else {
      updateObject(obj.id, buildPatch(obj, v), "Set opacity");
    }
  };

  const posExprOn = obj.transform.position.expression?.enabled === true;
  const toggleWiggle = () => {
    if (posExprOn) {
      updateObject(obj.id, {
        transform: {
          ...obj.transform,
          position: {
            ...obj.transform.position,
            expression: { ...obj.transform.position.expression!, enabled: false },
          },
        },
      }, "Disable wiggle");
    } else {
      void addWiggleExpression(obj.id);
    }
  };

  return (
    <div style={{ fontSize: 12, color: "#ccc", padding: 8, overflow: "auto", height: "100%", background: "#1c1c1c" }}>
      <div style={{ marginBottom: 8, fontWeight: "bold", color: "#eee" }}>{obj.name}</div>

      <Section label="Transform">
        <Vec3Row label="Position" vals={pos}
          onChange={(v, dp) => setVec3Kf("position", v, dp)}
          hasKf={obj.transform.position.keyframes.length > 0}
          speeds={{ x: 1, y: 1, z: 1 }}
        />
        <Vec3Row label="Anchor" vals={anchor}
          onChange={(v, dp) => setVec3Kf("anchor", v, dp)}
          hasKf={obj.transform.anchor.keyframes.length > 0}
          speeds={{ x: 1, y: 1, z: 1 }}
        />
        <Vec3Row label="Rotation" vals={rot}
          onChange={(v, dp) => setVec3Kf("rotation", v, dp)}
          hasKf={obj.transform.rotation.keyframes.length > 0}
          speeds={{ x: 0.5, y: 0.5, z: 0.5 }}
        />
        <Vec3Row label="Scale" vals={scl}
          onChange={(v, dp) => setVec3Kf("scale", v, dp)}
          hasKf={obj.transform.scale.keyframes.length > 0}
          speeds={{ x: 0.01, y: 0.01, z: 0.01 }}
        />
        <Row label="Opacity">
          <input
            type="range" min={0} max={1} step={0.01}
            value={opacity}
            onChange={(e) => setOpacityKf(Number(e.target.value))}
            style={{ width: 80 }}
          />
          <ScrubNumber
            value={opacity}
            onCommit={(v, d) => setOpacityKf(v, d)}
            speed={0.01}
            decimals={2}
            min={0}
            max={1}
            style={numInputStyle}
          />
        </Row>
      </Section>

      <Section label="Expression">
        <button
          style={{ ...btnStyle, fontSize: 10, color: posExprOn ? "#f0c040" : "#bbb", borderColor: posExprOn ? "#aa7" : "#444" }}
          onClick={toggleWiggle}
        >
          {posExprOn ? "● Wiggle Position (on)" : "○ Wiggle Position"}
        </button>
      </Section>

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
                  const kfs = [...obj.transform.position.keyframes];
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
          <ScrubNumber
            value={obj.inPoint}
            onCommit={(v) => updateObject(obj.id, { inPoint: Math.max(0, Math.floor(v)) }, "Set inPoint")}
            speed={1}
            decimals={0}
            min={0}
            style={numInputStyle}
          />
        </Row>
        <Row label="Out">
          <ScrubNumber
            value={obj.outPoint}
            onCommit={(v) => updateObject(obj.id, { outPoint: Math.max(1, Math.floor(v)) }, "Set outPoint")}
            speed={1}
            decimals={0}
            min={1}
            style={numInputStyle}
          />
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
  label, vals, onChange, hasKf, speeds,
}: {
  label: string;
  vals: { x: string; y: string; z: string };
  onChange: (v: Vec3, deltaParts?: Partial<Vec3>) => void;
  hasKf: boolean;
  speeds?: { x: number; y: number; z: number };
}) {
  const commit = (axis: "x" | "y" | "z", newVal: number, delta?: number) => {
    if (!Number.isFinite(newVal)) return;
    const base = {
      x: parseFloat(vals.x),
      y: parseFloat(vals.y),
      z: parseFloat(vals.z),
    };
    const v: Vec3 = { ...base, [axis]: newVal };
    const deltaParts = delta !== undefined ? ({ [axis]: delta } as Partial<Vec3>) : undefined;
    onChange(v, deltaParts);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
      <span style={{ color: "#666", width: 52, textAlign: "right", flexShrink: 0 }}>{label}</span>
      <span style={{ color: hasKf ? "#f0c040" : "#555", fontSize: 9 }}>⬦</span>
      {(["x", "y", "z"] as const).map((ax) => (
        <label key={ax} style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <span style={{ color: "#555", fontSize: 10 }}>{ax.toUpperCase()}</span>
          <ScrubNumber
            value={parseFloat(vals[ax])}
            onCommit={(v, d) => commit(ax, v, d)}
            speed={speeds?.[ax] ?? 1}
            style={numInputStyle}
          />
        </label>
      ))}
    </div>
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
