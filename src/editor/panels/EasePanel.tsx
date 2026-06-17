import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { BUILTIN_EASING_PRESETS, type BuiltinEasePreset } from "../builtinEasingPresets";
import { EasingCurveEditor, miniEaseCurvePath, miniLinearCurvePath } from "../components/EasingCurveEditor";
import {
  applyEaseModeToProp,
  DEFAULT_BEZIER,
  type EaseApplyMode,
  type EaseCurveSelection,
} from "../easingApply";
import { listUserEasingPresets, saveUserEasingPreset, type EasingPresetFile } from "../easingPresetFs";
import { buildKfPatches, groupSelectedKfs } from "../keyframeEdit";
import { currentTimelineComp, useEditorStore } from "../store";

type PresetSet = "default" | "user";

const panelHeader: React.CSSProperties = {
  padding: "6px 10px",
  background: "#1e1e1e",
  borderBottom: "1px solid #333",
  fontSize: 11,
  fontWeight: 600,
  color: "#aaa",
  flexShrink: 0,
};

const btnStyle = (active = false): React.CSSProperties => ({
  flex: 1,
  padding: "4px 0",
  fontSize: 11,
  border: "1px solid #444",
  borderRadius: 3,
  background: active ? "#3a5a7a" : "#2a2a2a",
  color: active ? "#fff" : "#bbb",
  cursor: "pointer",
});

function isLinearPreset(p: BuiltinEasePreset | EasingPresetFile): p is BuiltinEasePreset & { kind: "linear" } {
  return "kind" in p && p.kind === "linear";
}

export function EasePanel() {
  const project = useEditorStore((s) => s.project);
  const compId = useEditorStore((s) => s.currentCompId);
  const selectedKfKeys = useEditorStore((s) => s.selectedKfKeys);
  const updateObjects = useEditorStore((s) => s.updateObjects);
  const getFs = useEditorStore((s) => s.getFs);

  const [bezier, setBezier] = useState<[number, number, number, number]>([...DEFAULT_BEZIER]);
  const [isLinear, setIsLinear] = useState(false);
  const [mode, setMode] = useState<EaseApplyMode>("both");
  const [presetSet, setPresetSet] = useState<PresetSet>("default");
  const [userPresets, setUserPresets] = useState<EasingPresetFile[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>("ease");
  const [status, setStatus] = useState("");

  const comp = currentTimelineComp(project, compId);
  const objects = comp?.objects ?? [];

  const reloadUserPresets = useCallback(async () => {
    const list = await listUserEasingPresets(getFs());
    setUserPresets(list);
  }, [getFs]);

  useEffect(() => {
    void reloadUserPresets();
  }, [reloadUserPresets]);

  const visiblePresets = useMemo(() => {
    if (presetSet === "user") return userPresets;
    return BUILTIN_EASING_PRESETS;
  }, [presetSet, userPresets]);

  const loadPreset = (p: BuiltinEasePreset | EasingPresetFile) => {
    if (isLinearPreset(p)) {
      setIsLinear(true);
      setSelectedPresetId(p.id);
      return;
    }
    setIsLinear(false);
    setBezier([...p.bezier] as [number, number, number, number]);
    setSelectedPresetId(p.id);
  };

  const curve: EaseCurveSelection = isLinear ? { kind: "linear" } : { kind: "bezier", bezier };

  const apply = () => {
    if (selectedKfKeys.length === 0) {
      setStatus("キーフレームを選択してください");
      return;
    }
    const group = groupSelectedKfs(selectedKfKeys);
    const patches = buildKfPatches(objects, group, (prop, frames) =>
      applyEaseModeToProp(prop, frames, mode, curve),
    );
    if (patches.length === 0) {
      setStatus("適用対象がありません");
      return;
    }
    updateObjects(patches, `Ease: apply ${mode}`);
    setStatus(`Applied (${mode}) to ${selectedKfKeys.length} KF`);
  };

  const savePreset = async () => {
    if (isLinear) {
      setStatus("Linear は保存できません");
      return;
    }
    const label = window.prompt("プリセット名", `Preset ${userPresets.length + 1}`);
    if (label === null) return;
    const saved = await saveUserEasingPreset(getFs(), label, bezier);
    await reloadUserPresets();
    setPresetSet("user");
    setSelectedPresetId(saved.id);
    setStatus(`Saved: ${saved.label}`);
  };

  const setCoord = (idx: 0 | 1 | 2 | 3, raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    setIsLinear(false);
    setBezier((prev) => {
      const next = [...prev] as [number, number, number, number];
      if (idx === 0 || idx === 2) next[idx] = Math.min(1, Math.max(0, n));
      else next[idx] = n;
      return next;
    });
    setSelectedPresetId("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#141414", color: "#ccc", fontSize: 11 }}>
      <div style={panelHeader}>Ease</div>

      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10, overflow: "auto", flex: 1 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <div>
            {isLinear ? (
              <svg width={160} height={160} viewBox="0 0 160 160" style={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 4 }}>
                <path d={miniLinearCurvePath()} fill="none" stroke="#7fb8f0" strokeWidth={2} transform="scale(1.6)" />
              </svg>
            ) : (
              <EasingCurveEditor bezier={bezier} onChange={setBezier} />
            )}
          </div>
          <div style={{ flex: 1, display: "grid", gridTemplateColumns: "28px 1fr", gap: "4px 6px", alignContent: "start" }}>
            {(["x1", "y1", "x2", "y2"] as const).map((label, i) => (
              <Fragment key={label}>
                <span style={{ color: "#888", lineHeight: "22px" }}>{label}</span>
                <input
                  type="number"
                  step={0.01}
                  value={isLinear ? (i < 2 ? 0 : 1) : bezier[i]}
                  disabled={isLinear}
                  onChange={(e) => setCoord(i as 0 | 1 | 2 | 3, e.target.value)}
                  style={{ width: "100%", background: "#222", border: "1px solid #444", color: "#ddd", padding: "2px 4px", borderRadius: 2 }}
                />
              </Fragment>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 4 }}>
          {(["in", "out", "both"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} style={btnStyle(mode === m)}>
              {m.toUpperCase()}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <select
            value={presetSet}
            onChange={(e) => setPresetSet(e.target.value as PresetSet)}
            style={{ flex: 1, background: "#222", border: "1px solid #444", color: "#ddd", padding: "3px 6px", borderRadius: 3 }}
          >
            <option value="default">default</option>
            <option value="user">user</option>
          </select>
          <button type="button" onClick={() => void savePreset()} style={{ ...btnStyle(), flex: "0 0 auto", padding: "4px 10px" }} title="現在のカーブを保存">
            ★ Save
          </button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(52px, 1fr))",
            gap: 6,
            maxHeight: 220,
            overflowY: "auto",
            padding: 2,
          }}
        >
          {visiblePresets.map((p) => {
            const active = p.id === selectedPresetId;
            const isLin = isLinearPreset(p);
            const path = isLin ? miniLinearCurvePath() : miniEaseCurvePath(p.bezier);
            return (
              <button
                key={p.id}
                type="button"
                title={p.label}
                onClick={() => loadPreset(p)}
                style={{
                  padding: 4,
                  border: active ? "1px solid #7fb8f0" : "1px solid #333",
                  borderRadius: 4,
                  background: active ? "#2a3545" : "#1e1e1e",
                  cursor: "pointer",
                }}
              >
                <svg viewBox="0 0 100 100" width="100%" height={36}>
                  <rect x={4} y={4} width={92} height={92} fill="#111" stroke="#333" />
                  <path d={path} fill="none" stroke="#7fb8f0" strokeWidth={2.5} />
                </svg>
                <div style={{ fontSize: 9, color: "#aaa", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.label}
                </div>
              </button>
            );
          })}
          {presetSet === "user" && userPresets.length === 0 && (
            <div style={{ gridColumn: "1 / -1", color: "#666", fontSize: 10, padding: 8 }}>ユーザープリセットはまだありません</div>
          )}
        </div>

        <button type="button" onClick={apply} style={{ ...btnStyle(true), padding: "8px 0", fontWeight: 700, letterSpacing: 1 }}>
          APPLY
        </button>

        <div style={{ color: "#666", fontSize: 10, minHeight: 14 }}>
          {status || (selectedKfKeys.length > 0 ? `${selectedKfKeys.length} KF selected` : "タイムラインで KF を選択")}
        </div>
      </div>
    </div>
  );
}
