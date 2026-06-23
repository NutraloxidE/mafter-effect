import { useEffect, useRef, useState, type ReactNode } from "react";
import { sampleAny, sampleScalar, sampleVec3 } from "../../runtime/interpolate";
import type { AnimatedProp, Component, Easing, EffectInstance, ParamDescriptor, RGBA, SceneObject, ThreeDMode, Transform, Vec3 } from "../../core/schema";
import {
  currentTimelineComp,
  propVec3ToDisplay,
  setKeyframe,
  useEditorStore,
} from "../store";
import { staticProp } from "../../core/props";
import { ColorSwatch, isRgba } from "../ColorSwatch";
import { WEB_SAFE_FONTS, isKnownFont } from "../fontList";
import { ScrubNumber } from "../ScrubNumber";
import { globalPluginRegistry } from "../../runtime/pluginRegistry";
import { groupEffectsForPicker } from "../effectCategories";
import { BakerBadge } from "../bakerLabel";

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
  const setPreviewQualityEditing = useEditorStore((s) => s.setPreviewQualityEditing);
  const setPreviewOverride = useEditorStore((s) => s.setPreviewOverride);
  const clearPreviewOverride = useEditorStore((s) => s.clearPreviewOverride);
  const decomposeGlyphs = useEditorStore((s) => s.decomposeGlyphs);
  const addEffect = useEditorStore((s) => s.addEffect);
  const setAdjustmentMode = useEditorStore((s) => s.setAdjustmentMode);
  const setThreeD = useEditorStore((s) => s.setThreeD);
  const setThreeDMode = useEditorStore((s) => s.setThreeDMode);
  const setActiveCamera = useEditorStore((s) => s.setActiveCamera);
  const removeEffect = useEditorStore((s) => s.removeEffect);
  const reorderEffect = useEditorStore((s) => s.reorderEffect);
  const toggleEffect = useEditorStore((s) => s.toggleEffect);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [addEffectOpen, setAddEffectOpen] = useState(false);
  const [highlightEffectId, setHighlightEffectId] = useState<string | null>(null);
  const effectRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const panelScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!highlightEffectId) return;
    const t = window.setTimeout(() => setHighlightEffectId(null), 1800);
    return () => window.clearTimeout(t);
  }, [highlightEffectId]);

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

  const previewPatch = (patch: Partial<SceneObject>) => {
    if (selectedIds.length > 1) return;
    setPreviewOverride({ objectId: obj.id, patch });
  };

  const buildTransformPreview = (
    key: "position" | "anchor" | "rotation" | "scale",
    value: Vec3,
  ): Transform => ({
    ...obj.transform,
    [key]: obj.transform[key].keyframes.length > 0
      ? setKeyframe(obj.transform[key], frame, value)
      : { ...obj.transform[key], value },
  });
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

  // §5.4b/§6.5b 3D & カメラ
  const camIdx = obj.components.findIndex((c) => c.type === "camera");
  const isCameraLayer = camIdx >= 0;
  const camComp = isCameraLayer ? obj.components[camIdx] : undefined;
  const effectiveAutoMode = comp?.renderer3d === "advanced" ? "raster3d" : "dom";
  const readCamNum = (key: string, def: number): number => {
    const raw = camComp?.props[key];
    if (typeof raw === "number") return raw;
    if (raw && typeof raw === "object" && "value" in raw && typeof (raw as { value: unknown }).value === "number") {
      return (raw as { value: number }).value;
    }
    return def;
  };
  const readCamType = (): "one-node" | "two-node" =>
    camComp?.props["cameraType"] === "one-node" ? "one-node" : "two-node";
  const readCamPoi = (): Vec3 => {
    const raw = camComp?.props["pointOfInterest"];
    const v = raw && typeof raw === "object" && "value" in raw ? (raw as { value: unknown }).value : raw;
    if (v && typeof v === "object" && typeof (v as Vec3).x === "number") return v as Vec3;
    return { x: 0, y: 0, z: 0 };
  };
  const setCamProp = (key: string, value: unknown, label: string) => {
    if (camIdx < 0) return;
    const next = obj.components.map((c, i) => (i === camIdx ? { ...c, props: { ...c.props, [key]: value } } : c));
    updateObject(obj.id, { components: next }, label);
  };

  const foldoutKey = (section: string) => `${obj.id}:${section}`;
  const isExpanded = (section: string) => expanded[foldoutKey(section)] ?? true;
  const toggleExpanded = (section: string) => {
    const key = foldoutKey(section);
    setExpanded((prev) => ({ ...prev, [key]: !(prev[key] ?? true) }));
  };

  const handleAddEffect = (type: string) => {
    const effectId = addEffect(obj.id, type);
    setAddEffectOpen(false);
    if (!effectId) return;
    setExpanded((prev) => ({
      ...prev,
      [foldoutKey("effects")]: true,
      [foldoutKey(`effect:${effectId}`)]: true,
    }));
    setHighlightEffectId(effectId);
    requestAnimationFrame(() => {
      effectRowRefs.current.get(effectId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };

  return (
    <div ref={panelScrollRef} style={{ fontSize: 12, color: "#ccc", padding: 4, overflow: "auto", height: "100%", background: "#1c1c1c" }}>
      <div style={{ padding: "6px 8px 8px", fontWeight: "bold", color: "#eee", fontSize: 13 }}>
        {obj.name}
        {obj.isAdjustment && (
          <span style={{ marginLeft: 6, fontSize: 10, color: "#c9a227", fontWeight: 600 }}>
            ADJ · {(obj.adjustmentMode ?? "live") === "raster" ? "Raster" : "Live"}
          </span>
        )}
        {obj.isNull && (
          <span style={{ marginLeft: 6, fontSize: 10, color: "#e07070", fontWeight: 600 }}>NULL</span>
        )}
      </div>

      <InspectorFoldout label="Transform" expanded={isExpanded("transform")} onToggle={() => toggleExpanded("transform")}>
        <Vec3Row label="Position" vals={pos}
          onChange={(v, dp) => setVec3Kf("position", v, dp)}
          onLiveChange={(v) => previewPatch({ transform: buildTransformPreview("position", v) })}
          hasKf={obj.transform.position.keyframes.length > 0}
          speeds={{ x: 1, y: 1, z: 1 }}
        />
        <Vec3Row label="Anchor" vals={anchor}
          onChange={(v, dp) => setVec3Kf("anchor", v, dp)}
          onLiveChange={(v) => previewPatch({ transform: buildTransformPreview("anchor", v) })}
          hasKf={obj.transform.anchor.keyframes.length > 0}
          speeds={{ x: 1, y: 1, z: 1 }}
        />
        <Vec3Row label="Rotation" vals={rot}
          onChange={(v, dp) => setVec3Kf("rotation", v, dp)}
          onLiveChange={(v) => previewPatch({ transform: buildTransformPreview("rotation", v) })}
          hasKf={obj.transform.rotation.keyframes.length > 0}
          speeds={{ x: 0.5, y: 0.5, z: 0.5 }}
        />
        <Vec3Row label="Scale" vals={scl}
          onChange={(v, dp) => setVec3Kf("scale", v, dp)}
          onLiveChange={(v) => previewPatch({ transform: buildTransformPreview("scale", v) })}
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
            onLiveChange={(v) => previewPatch({
              opacity: obj.opacity.keyframes.length > 0
                ? setKeyframe(obj.opacity, frame, v)
                : { ...obj.opacity, value: v },
            })}
            onCommit={(v, d) => setOpacityKf(v, d)}
            min={0}
            max={1}
            step={0.01}
            style={numInputStyle}
          />
        </Row>
      </InspectorFoldout>

      {isCameraLayer ? (
        <InspectorFoldout label="Camera" expanded={isExpanded("camera")} onToggle={() => toggleExpanded("camera")}>
          <Row label="Type">
            <select
              value={readCamType()}
              onChange={(e) => setCamProp("cameraType", e.target.value, "Set camera type")}
              style={selectStyle}
            >
              <option value="two-node">Two-Node</option>
              <option value="one-node">One-Node</option>
            </select>
          </Row>
          <Row label="Zoom (px)">
            <ScrubNumber
              value={readCamNum("zoom", 1158)}
              onCommit={(v) => setCamProp("zoom", staticProp(Math.max(1, v)), "Set camera zoom")}
              min={1}
              step={1}
              style={numInputStyle}
            />
          </Row>
          {readCamType() === "two-node" && (
            <Row label="Point of Interest">
              {(["x", "y", "z"] as const).map((axis) => (
                <ScrubNumber
                  key={axis}
                  value={readCamPoi()[axis]}
                  onCommit={(v) => setCamProp("pointOfInterest", staticProp({ ...readCamPoi(), [axis]: v }), "Set point of interest")}
                  step={1}
                  style={numInputStyle}
                />
              ))}
            </Row>
          )}
          <Row label="Near / Far">
            <ScrubNumber value={readCamNum("near", 1)} onCommit={(v) => setCamProp("near", Math.max(0.001, v), "Set near")} min={0.001} step={1} style={numInputStyle} />
            <ScrubNumber value={readCamNum("far", 10000)} onCommit={(v) => setCamProp("far", Math.max(1, v), "Set far")} min={1} step={10} style={numInputStyle} />
          </Row>
          <Row label="Active">
            <button
              type="button"
              onClick={() => setActiveCamera(comp?.activeCamera === obj.id ? null : obj.id)}
              style={{ ...btnStyle, background: comp?.activeCamera === obj.id ? "#2f4a68" : "#2a2a2a", color: comp?.activeCamera === obj.id ? "#9fc8f0" : "#ccc" }}
            >
              {comp?.activeCamera === obj.id ? "Active ●" : "Set Active"}
            </button>
          </Row>
        </InspectorFoldout>
      ) : !obj.isNull ? (
        <InspectorFoldout label="3D" expanded={isExpanded("threeD")} onToggle={() => toggleExpanded("threeD")}>
          <Row label="3D Layer">
            <button
              type="button"
              onClick={() => setThreeD(obj.id, !obj.threeD)}
              style={{ ...btnStyle, background: obj.threeD ? "#2f5a44" : "#2a2a2a", color: obj.threeD ? "#9fe8c4" : "#ccc" }}
            >
              {obj.threeD ? "ON" : "OFF"}
            </button>
          </Row>
          {obj.threeD && (
            <Row label="Render Mode">
              <select
                value={obj.threeDMode ?? "auto"}
                onChange={(e) => setThreeDMode(obj.id, e.target.value as ThreeDMode)}
                style={selectStyle}
              >
                <option value="auto">Auto ({effectiveAutoMode})</option>
                <option value="dom">DOM (Classic)</option>
                <option value="raster3d">Raster3D (Advanced)</option>
              </select>
            </Row>
          )}
        </InspectorFoldout>
      ) : null}

      {obj.isAdjustment ? (
        <InspectorFoldout label="Content" expanded={isExpanded("content")} onToggle={() => toggleExpanded("content")}>
          <div style={{ color: "#888", fontSize: 11 }}>調整レイヤー（描画なし）</div>
        </InspectorFoldout>
      ) : obj.isNull ? (
        <InspectorFoldout label="Content" expanded={isExpanded("content")} onToggle={() => toggleExpanded("content")}>
          <div style={{ color: "#888", fontSize: 11 }}>Null レイヤー（描画なし）</div>
        </InspectorFoldout>
      ) : (
        obj.components.map((comp, compIdx) => {
          if (comp.type !== "text" && comp.type !== "solid") return null;
          const label = globalPluginRegistry.getComponentDef(comp.type)?.label ?? comp.type;
          const sectionKey = `component:${compIdx}:${comp.type}`;
          return (
            <InspectorFoldout
              key={sectionKey}
              label={label}
              expanded={isExpanded(sectionKey)}
              onToggle={() => toggleExpanded(sectionKey)}
            >
              {comp.type === "text" ? (
                <TextComponentFields
                  obj={obj}
                  compIdx={compIdx}
                  frame={frame}
                  updateObject={updateObject}
                  previewPatch={previewPatch}
                  onEditFocus={() => setPreviewQualityEditing(true)}
                  onEditBlur={() => setPreviewQualityEditing(false)}
                  onClearPreview={() => clearPreviewOverride()}
                  onDecomposeNull={() => decomposeGlyphs(obj.id, "keyframesOnNull")}
                  onDecomposeChild={() => decomposeGlyphs(obj.id, "keyframesOnChild")}
                />
              ) : (
                <SolidComponentFields
                  obj={obj}
                  compIdx={compIdx}
                  frame={frame}
                  updateObject={updateObject}
                  previewPatch={previewPatch}
                  onEditFocus={() => setPreviewQualityEditing(true)}
                  onEditBlur={() => setPreviewQualityEditing(false)}
                />
              )}
            </InspectorFoldout>
          );
        })
      )}

      <InspectorFoldout label="Effects" expanded={isExpanded("effects")} onToggle={() => toggleExpanded("effects")}>
        {obj.isAdjustment && (
          <div style={{ marginBottom: 6 }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
              {(["live", "raster"] as const).map((m) => {
                const active = (obj.adjustmentMode ?? "live") === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setAdjustmentMode(obj.id, m)}
                    style={{
                      ...btnStyle,
                      flex: 1,
                      fontSize: 10,
                      background: active ? "#3a5068" : "#2a2a2a",
                      color: active ? "#8cf" : "#999",
                      border: active ? "1px solid #5a8fd0" : "1px solid #444",
                    }}
                  >
                    {m === "live" ? "Live 調整" : "Raster 調整"}
                  </button>
                );
              })}
            </div>
            <div style={{ color: "#8ab", fontSize: 10, lineHeight: 1.4 }}>
              {(obj.adjustmentMode ?? "live") === "raster"
                ? "Raster: 背面を canvas に焼いて effect 適用（高精度・重い。全 effect 利用可）。"
                : "Live: backdrop-filter（軽量・web bundle 向き）。mp4/png 出力では自動 raster 化されます（重くなります）。"}
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={() => setAddEffectOpen((v) => !v)}
          style={{
            ...btnStyle,
            fontSize: 10,
            width: "100%",
            marginBottom: addEffectOpen ? 6 : 8,
            background: addEffectOpen ? "#3a4a5a" : "#333",
            color: addEffectOpen ? "#8cf" : "#ccc",
          }}
        >
          {addEffectOpen ? "▾ エフェクトを選択" : "+ エフェクトを追加"}
        </button>
        {addEffectOpen && (
          <div
            style={{
              marginBottom: 10,
              padding: "6px 4px",
              background: "#2a3340",
              border: "1px solid #5a8fd0",
              borderRadius: 4,
            }}
          >
            <div style={{ fontSize: 10, color: "#9bc", padding: "0 6px 4px", fontWeight: 600 }}>
              追加するエフェクト
            </div>
            {globalPluginRegistry.listEffects().length === 0 ? (
              <div style={{ fontSize: 10, color: "#f88", padding: "4px 8px" }}>
                利用可能なエフェクトがありません（プラグイン再読込を試してください）
              </div>
            ) : groupEffectsForPicker(
                globalPluginRegistry.listEffects().filter(
                  (e) =>
                    !(obj.isAdjustment === true && (obj.adjustmentMode ?? "live") === "live")
                    || e.executionPath === "live",
                ),
              ).map(({ category, effects }) => (
              <div key={category} style={{ marginBottom: 4 }}>
                <div
                  style={{
                    fontSize: 9,
                    color: "#7a9ab8",
                    padding: "4px 8px 2px",
                    fontWeight: 600,
                    letterSpacing: 0.3,
                  }}
                >
                  {category}
                </div>
                {effects.map((e) => (
                  <button
                    key={e.type}
                    type="button"
                    onClick={() => handleAddEffect(e.type)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      width: "100%",
                      background: "transparent",
                      border: "none",
                      color: "#ddd",
                      padding: "6px 8px",
                      textAlign: "left",
                      cursor: "pointer",
                      fontSize: 11,
                      borderRadius: 3,
                    }}
                    onMouseEnter={(ev) => { ev.currentTarget.style.background = "#3a5068"; }}
                    onMouseLeave={(ev) => { ev.currentTarget.style.background = "transparent"; }}
                  >
                    <span>{e.label}</span>
                    {e.previewBakeRequired && <BakerBadge />}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {(obj.effects ?? []).length === 0 && !addEffectOpen && (
          <div style={{ color: "#666", fontSize: 10, marginBottom: 6, padding: "0 2px" }}>
            エフェクトなし — 上のボタンから追加
          </div>
        )}
        {(obj.effects ?? []).map((effect, idx, arr) => {
          const def = globalPluginRegistry.getEffectDef(effect.type);
          const label = def?.label ?? effect.type;
          const sectionKey = `effect:${effect.id}`;
          const highlighted = highlightEffectId === effect.id;
          return (
            <div
              key={effect.id}
              ref={(el) => {
                if (el) effectRowRefs.current.set(effect.id, el);
                else effectRowRefs.current.delete(effect.id);
              }}
              style={{
                marginBottom: 4,
                borderRadius: 4,
                outline: highlighted ? "1px solid #5a8fd0" : "none",
                background: highlighted ? "rgba(90, 143, 208, 0.12)" : "transparent",
                transition: "background 0.3s, outline 0.2s",
              }}
            >
              <InspectorFoldout
                label={(
                  <>
                    {`${effect.enabled ? "●" : "○"} ${label}`}
                    {def?.previewBakeRequired && <BakerBadge />}
                  </>
                )}
                expanded={isExpanded(sectionKey)}
                onToggle={() => toggleExpanded(sectionKey)}
              >
                <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
                  <button onClick={() => toggleEffect(obj.id, effect.id)} style={{ ...btnStyle, fontSize: 10 }}>
                    {effect.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    disabled={idx === 0}
                    onClick={() => reorderEffect(obj.id, effect.id, "up")}
                    style={{ ...btnStyle, fontSize: 10 }}
                    title="上へ（先に適用）"
                  >▲</button>
                  <button
                    disabled={idx === arr.length - 1}
                    onClick={() => reorderEffect(obj.id, effect.id, "down")}
                    style={{ ...btnStyle, fontSize: 10 }}
                    title="下へ（後に適用）"
                  >▼</button>
                  <button onClick={() => removeEffect(obj.id, effect.id)} style={{ ...btnStyle, fontSize: 10, color: "#f66" }}>×</button>
                </div>
                <EffectFields
                  obj={obj}
                  effect={effect}
                  params={def?.params ?? []}
                  frame={frame}
                  updateObject={updateObject}
                  previewPatch={previewPatch}
                />
              </InspectorFoldout>
            </div>
          );
        })}
      </InspectorFoldout>

      <InspectorFoldout label="Expression" expanded={isExpanded("expression")} onToggle={() => toggleExpanded("expression")}>
        <button
          style={{ ...btnStyle, fontSize: 10, color: posExprOn ? "#f0c040" : "#bbb", borderColor: posExprOn ? "#aa7" : "#444" }}
          onClick={toggleWiggle}
        >
          {posExprOn ? "● Wiggle Position (on)" : "○ Wiggle Position"}
        </button>
      </InspectorFoldout>

      <InspectorFoldout label="Keyframes" expanded={isExpanded("keyframes")} onToggle={() => toggleExpanded("keyframes")}>
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
      </InspectorFoldout>

      <InspectorFoldout label="In / Out" expanded={isExpanded("inOut")} onToggle={() => toggleExpanded("inOut")}>
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
      </InspectorFoldout>
    </div>
  );
}

function EffectFields({
  obj,
  effect,
  params,
  frame,
  updateObject,
  previewPatch,
}: {
  obj: SceneObject;
  effect: EffectInstance;
  params: ParamDescriptor[];
  frame: number;
  updateObject: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  previewPatch: (patch: Partial<SceneObject>) => void;
}) {
  const props = effect.props;

  const writeEffects = (nextProps: EffectInstance["props"], label: string) => {
    const nextEffects = (obj.effects ?? []).map((e) =>
      e.id === effect.id ? { ...e, props: nextProps } : e,
    );
    updateObject(obj.id, { effects: nextEffects }, label);
  };

  const previewEffects = (nextProps: EffectInstance["props"]) => {
    previewPatch({
      effects: (obj.effects ?? []).map((e) =>
        e.id === effect.id ? { ...e, props: nextProps } : e,
      ),
    });
  };

  const writeAnim = <T,>(key: string, next: AnimatedProp<T>, label: string) => {
    writeEffects({ ...props, [key]: next }, label);
  };

  const previewAnim = <T,>(key: string, next: AnimatedProp<T>) => {
    previewEffects({ ...props, [key]: next });
  };

  const toggleKf = (key: string, prop: AnimatedProp<unknown>) => {
    if (prop.keyframes.length > 0) writeAnim(key, { value: prop.value, keyframes: [] }, `Disable ${key} keyframes`);
    else writeAnim(key, setKeyframe(prop, frame, prop.value, { type: "hold" }), `Enable ${key} keyframes`);
  };

  return (
    <>
      {params.map((param) => {
        // 後から追加された param（例 §27.4 quality）は既存 effect インスタンスの
        // props に無い。レジストリ済み param は常に編集可能であるべきなので、
        // animatable param は欠落時に既定値へフォールバックして行を描画する。
        const stored = props[param.key];
        const raw =
          stored === undefined && param.animatable
            ? staticProp(param.default)
            : stored === undefined && param.kind === "bool"
              ? param.default
              : stored;
        if (param.kind === "enum" && !param.animatable) {
          const val = typeof raw === "string" ? raw : String(param.default ?? "");
          return (
            <Row key={param.key} label={param.label}>
              <select
                value={val}
                onChange={(e) => writeEffects({ ...props, [param.key]: e.target.value }, `Edit ${param.label}`)}
                style={selectStyle}
              >
                {(param.options ?? []).map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </Row>
          );
        }
        if (param.kind === "bool" && !param.animatable) {
          const val = typeof raw === "boolean" ? raw : Boolean(param.default);
          return (
            <Row key={param.key} label={param.label}>
              <input
                type="checkbox"
                checked={val}
                onChange={(e) => writeEffects({ ...props, [param.key]: e.target.checked }, `Edit ${param.label}`)}
              />
            </Row>
          );
        }
        if (!isAnimated(raw)) return null;
        const val = sampleAny(raw, frame);
        if (param.kind === "scalar" && typeof val === "number") {
          return (
            <AnimScalarRow
              key={param.key}
              label={param.label}
              prop={raw as AnimatedProp<number>}
              value={val}
              frame={frame}
              onToggle={() => toggleKf(param.key, raw)}
              onCommit={(v) => {
                if (raw.keyframes.length > 0) writeAnim(param.key, setKeyframe(raw as AnimatedProp<number>, frame, v), `Edit ${param.label}`);
                else writeAnim(param.key, { ...raw, value: v }, `Edit ${param.label}`);
              }}
              onLiveChange={(v) => previewAnim(param.key, raw.keyframes.length > 0 ? setKeyframe(raw as AnimatedProp<number>, frame, v) : { ...raw, value: v })}
              min={param.min}
              max={param.max}
              step={param.step}
            />
          );
        }
        if (param.kind === "color" && isRgba(val)) {
          return (
            <Row key={param.key} label={param.label}>
              <Stopwatch active={raw.keyframes.length > 0} onClick={() => toggleKf(param.key, raw)} />
              <ColorSwatch
                label={param.label}
                value={val}
                onLiveChange={(c) => previewAnim(param.key, raw.keyframes.length > 0 ? setKeyframe(raw as AnimatedProp<RGBA>, frame, c) : { ...raw, value: c })}
                onCommit={(c) => {
                  if (raw.keyframes.length > 0) writeAnim(param.key, setKeyframe(raw as AnimatedProp<RGBA>, frame, c), `Edit ${param.label}`);
                  else writeAnim(param.key, { ...raw, value: c }, `Edit ${param.label}`);
                }}
              />
            </Row>
          );
        }
        return null;
      })}
    </>
  );
}

function TextComponentFields({
  obj,
  compIdx,
  frame,
  updateObject,
  previewPatch,
  onEditFocus,
  onEditBlur,
  onClearPreview,
  onDecomposeNull,
  onDecomposeChild,
}: {
  obj: SceneObject;
  compIdx: number;
  frame: number;
  updateObject: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  previewPatch: (patch: Partial<SceneObject>) => void;
  onEditFocus: () => void;
  onEditBlur: () => void;
  onClearPreview: () => void;
  onDecomposeNull: () => void;
  onDecomposeChild: () => void;
}) {
  const comp = obj.components[compIdx];
  if (!comp || comp.type !== "text") return null;
  const def = globalPluginRegistry.getComponentDef("text");
  const props = comp.props;

  const writeComponents = (nextProps: Component["props"], label: string) => {
    const nextComponents = obj.components.map((c, i) =>
      i === compIdx ? { ...c, props: nextProps } : c,
    );
    updateObject(obj.id, { components: nextComponents }, label);
  };

  const previewComponents = (nextProps: Component["props"]) => {
    previewPatch({
      components: obj.components.map((c, i) =>
        i === compIdx ? { ...c, props: nextProps } : c,
      ),
    });
  };

  const writeAnim = <T,>(key: string, next: AnimatedProp<T>, label: string) => {
    writeComponents({ ...props, [key]: next }, label);
  };

  const previewAnim = <T,>(key: string, next: AnimatedProp<T>) => {
    previewComponents({ ...props, [key]: next });
  };

  const writeStatic = (key: string, value: unknown, label: string) => {
    writeComponents({ ...props, [key]: value }, label);
  };

  const toggleKf = (key: string, prop: AnimatedProp<unknown>) => {
    if (prop.keyframes.length > 0) writeAnim(key, { value: prop.value, keyframes: [] }, `Disable ${key} keyframes`);
    else writeAnim(key, setKeyframe(prop, frame, prop.value, { type: "hold" }), `Enable ${key} keyframes`);
  };

  const textProp = props["text"];
  const sizeProp = props["size"];
  const colorProp = props["color"];
  const trackingProp = props["tracking"];
  const leadingProp = props["leading"];
  const strokeColorProp = props["strokeColor"];
  const strokeWidthProp = props["strokeWidth"];

  const textVal = isAnimated(textProp) ? String(sampleAny(textProp, frame)) : "";
  const sizeVal = isAnimated(sizeProp) && typeof sampleAny(sizeProp, frame) === "number"
    ? (sampleAny(sizeProp, frame) as number) : 48;
  const colorVal = isAnimated(colorProp) && isRgba(sampleAny(colorProp, frame))
    ? (sampleAny(colorProp, frame) as RGBA) : { r: 1, g: 1, b: 1, a: 1 };
  const trackingVal = isAnimated(trackingProp) && typeof sampleAny(trackingProp, frame) === "number"
    ? (sampleAny(trackingProp, frame) as number) : 0;
  const leadingVal = isAnimated(leadingProp) && typeof sampleAny(leadingProp, frame) === "number"
    ? (sampleAny(leadingProp, frame) as number) : 0;
  const strokeColorVal = isAnimated(strokeColorProp) && isRgba(sampleAny(strokeColorProp, frame))
    ? (sampleAny(strokeColorProp, frame) as RGBA) : { r: 0, g: 0, b: 0, a: 1 };
  const strokeWidthVal = isAnimated(strokeWidthProp) && typeof sampleAny(strokeWidthProp, frame) === "number"
    ? (sampleAny(strokeWidthProp, frame) as number) : 0;

  const font = typeof props["font"] === "string" ? props["font"] : "sans-serif";
  const align = props["align"] === "center" || props["align"] === "right" ? props["align"] : "left";
  const weight = typeof props["weight"] === "number" ? props["weight"] : 400;
  const italic = props["italic"] === true;

  return (
    <>
      {isAnimated(textProp) && (
        <Row label="Source">
          <Stopwatch active={textProp.keyframes.length > 0} onClick={() => toggleKf("text", textProp)} />
          <TextSourceInput
            textProp={textProp}
            frame={frame}
            committed={textVal}
            onPreview={(next) => previewAnim("text", next)}
            onCommit={(v) => {
              if (textProp.keyframes.length > 0) {
                writeAnim("text", setKeyframe(textProp, frame, v, { type: "hold" }), "Edit Source Text");
              } else {
                writeAnim("text", { ...textProp, value: v }, "Edit Source Text");
              }
            }}
            onEditFocus={onEditFocus}
            onEditBlur={onEditBlur}
            onClearPreview={onClearPreview}
          />
        </Row>
      )}
      <Row label="Font">
        <FontField
          font={font}
          onChange={(v) => writeStatic("font", v, "Edit font")}
          onEditFocus={onEditFocus}
          onEditBlur={onEditBlur}
        />
      </Row>
      {isAnimated(sizeProp) && (
        <AnimScalarRow
          label="Size"
          prop={sizeProp as AnimatedProp<number>}
          value={sizeVal}
          frame={frame}
          onToggle={() => toggleKf("size", sizeProp)}
          onCommit={(v) => {
            if (sizeProp.keyframes.length > 0) writeAnim("size", setKeyframe(sizeProp as AnimatedProp<number>, frame, v), "Edit size");
            else writeAnim("size", { ...sizeProp, value: v }, "Edit size");
          }}
          onLiveChange={(v) => {
            if (sizeProp.keyframes.length > 0) previewAnim("size", setKeyframe(sizeProp as AnimatedProp<number>, frame, v));
            else previewAnim("size", { ...sizeProp, value: v });
          }}
          onFocus={onEditFocus}
          onBlur={onEditBlur}
          min={1}
        />
      )}
      {isAnimated(colorProp) && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 4 }}>
          <Stopwatch active={colorProp.keyframes.length > 0} onClick={() => toggleKf("color", colorProp)} />
          <div style={{ flex: 1 }}>
            <ColorSwatch
              label="Fill"
              value={colorVal}
              onCommit={(v) => {
                if (colorProp.keyframes.length > 0) writeAnim("color", setKeyframe(colorProp as AnimatedProp<RGBA>, frame, v), "Edit fill");
                else writeAnim("color", { ...colorProp, value: v }, "Edit fill");
              }}
              onLiveChange={(v) => {
                if (colorProp.keyframes.length > 0) previewAnim("color", setKeyframe(colorProp as AnimatedProp<RGBA>, frame, v));
                else previewAnim("color", { ...colorProp, value: v });
              }}
              onFocus={onEditFocus}
              onBlur={onEditBlur}
            />
          </div>
        </div>
      )}
      {isAnimated(strokeColorProp) && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 4 }}>
          <Stopwatch active={strokeColorProp.keyframes.length > 0} onClick={() => toggleKf("strokeColor", strokeColorProp)} />
          <div style={{ flex: 1 }}>
            <ColorSwatch
              label="Stroke"
              value={strokeColorVal}
              onCommit={(v) => {
                if (strokeColorProp.keyframes.length > 0) writeAnim("strokeColor", setKeyframe(strokeColorProp as AnimatedProp<RGBA>, frame, v), "Edit stroke");
                else writeAnim("strokeColor", { ...strokeColorProp, value: v }, "Edit stroke");
              }}
              onLiveChange={(v) => {
                if (strokeColorProp.keyframes.length > 0) previewAnim("strokeColor", setKeyframe(strokeColorProp as AnimatedProp<RGBA>, frame, v));
                else previewAnim("strokeColor", { ...strokeColorProp, value: v });
              }}
              onFocus={onEditFocus}
              onBlur={onEditBlur}
            />
          </div>
        </div>
      )}
      <Row label="Align">
        {(["left", "center", "right"] as const).map((a) => (
          <button
            key={a}
            onClick={() => writeStatic("align", a, "Edit align")}
            style={{ ...btnStyle, background: align === a ? "#3a4a5a" : "#2a2a2a", fontSize: 10, minWidth: 28 }}
          >
            {a === "left" ? "L" : a === "center" ? "C" : "R"}
          </button>
        ))}
      </Row>
      {isAnimated(trackingProp) && (
        <AnimScalarRow
          label="Tracking"
          prop={trackingProp as AnimatedProp<number>}
          value={trackingVal}
          frame={frame}
          onToggle={() => toggleKf("tracking", trackingProp)}
          onCommit={(v) => {
            if (trackingProp.keyframes.length > 0) writeAnim("tracking", setKeyframe(trackingProp as AnimatedProp<number>, frame, v), "Edit tracking");
            else writeAnim("tracking", { ...trackingProp, value: v }, "Edit tracking");
          }}
          onLiveChange={(v) => {
            if (trackingProp.keyframes.length > 0) previewAnim("tracking", setKeyframe(trackingProp as AnimatedProp<number>, frame, v));
            else previewAnim("tracking", { ...trackingProp, value: v });
          }}
          onFocus={onEditFocus}
          onBlur={onEditBlur}
        />
      )}
      {isAnimated(leadingProp) && (
        <AnimScalarRow
          label="Leading"
          prop={leadingProp as AnimatedProp<number>}
          value={leadingVal}
          frame={frame}
          onToggle={() => toggleKf("leading", leadingProp)}
          onCommit={(v) => {
            if (leadingProp.keyframes.length > 0) writeAnim("leading", setKeyframe(leadingProp as AnimatedProp<number>, frame, v), "Edit leading");
            else writeAnim("leading", { ...leadingProp, value: v }, "Edit leading");
          }}
          onLiveChange={(v) => {
            if (leadingProp.keyframes.length > 0) previewAnim("leading", setKeyframe(leadingProp as AnimatedProp<number>, frame, v));
            else previewAnim("leading", { ...leadingProp, value: v });
          }}
          onFocus={onEditFocus}
          onBlur={onEditBlur}
          min={0}
        />
      )}
      {isAnimated(strokeWidthProp) && (
        <AnimScalarRow
          label="Stroke W"
          prop={strokeWidthProp as AnimatedProp<number>}
          value={strokeWidthVal}
          frame={frame}
          onToggle={() => toggleKf("strokeWidth", strokeWidthProp)}
          onCommit={(v) => {
            if (strokeWidthProp.keyframes.length > 0) writeAnim("strokeWidth", setKeyframe(strokeWidthProp as AnimatedProp<number>, frame, v), "Edit stroke width");
            else writeAnim("strokeWidth", { ...strokeWidthProp, value: v }, "Edit stroke width");
          }}
          onLiveChange={(v) => {
            if (strokeWidthProp.keyframes.length > 0) previewAnim("strokeWidth", setKeyframe(strokeWidthProp as AnimatedProp<number>, frame, v));
            else previewAnim("strokeWidth", { ...strokeWidthProp, value: v });
          }}
          onFocus={onEditFocus}
          onBlur={onEditBlur}
          min={0}
        />
      )}
      <Row label="Weight">
        <select
          value={String(weight)}
          onChange={(e) => writeStatic("weight", Number(e.target.value), "Edit weight")}
          style={selectStyle}
        >
          {(def?.params.find((p) => p.key === "weight")?.options ?? ["400"]).map((w) => (
            <option key={w} value={w}>{w}</option>
          ))}
        </select>
      </Row>
      <Row label="Italic">
        <button
          onClick={() => writeStatic("italic", !italic, "Toggle italic")}
          style={{ ...btnStyle, color: italic ? "#f0c040" : "#bbb" }}
        >
          {italic ? "On" : "Off"}
        </button>
      </Row>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
        <button
          onClick={onDecomposeNull}
          style={{ ...btnStyle, fontSize: 10 }}
          title="§26.5.1a 空テキストコンテナを親に残し、グリフは静的 offset のみ"
        >
          Decompose with keyframes on null
        </button>
        <button
          onClick={onDecomposeChild}
          style={{ ...btnStyle, fontSize: 10 }}
          title="§26.5.1b コンテナなし。親アニメを各グリフに密フレーム KF 焼き込み"
        >
          Decompose with keyframes on child
        </button>
      </div>
    </>
  );
}

/** §31.1 Solid content — Fill 色のみ。Text の Fill 行と同型（ColorSwatch + ◇）。 */
function SolidComponentFields({
  obj,
  compIdx,
  frame,
  updateObject,
  previewPatch,
  onEditFocus,
  onEditBlur,
}: {
  obj: SceneObject;
  compIdx: number;
  frame: number;
  updateObject: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  previewPatch: (patch: Partial<SceneObject>) => void;
  onEditFocus: () => void;
  onEditBlur: () => void;
}) {
  const comp = obj.components[compIdx];
  if (!comp || comp.type !== "solid") return null;
  const props = comp.props;

  const writeComponents = (nextProps: Component["props"], label: string) => {
    const nextComponents = obj.components.map((c, i) =>
      i === compIdx ? { ...c, props: nextProps } : c,
    );
    updateObject(obj.id, { components: nextComponents }, label);
  };

  const previewComponents = (nextProps: Component["props"]) => {
    previewPatch({
      components: obj.components.map((c, i) =>
        i === compIdx ? { ...c, props: nextProps } : c,
      ),
    });
  };

  const writeAnim = <T,>(key: string, next: AnimatedProp<T>, label: string) => {
    writeComponents({ ...props, [key]: next }, label);
  };
  const previewAnim = <T,>(key: string, next: AnimatedProp<T>) => {
    previewComponents({ ...props, [key]: next });
  };
  const toggleKf = (key: string, prop: AnimatedProp<unknown>) => {
    if (prop.keyframes.length > 0) writeAnim(key, { value: prop.value, keyframes: [] }, `Disable ${key} keyframes`);
    else writeAnim(key, setKeyframe(prop, frame, prop.value, { type: "hold" }), `Enable ${key} keyframes`);
  };

  const colorProp = props["color"];
  const colorVal = isAnimated(colorProp) && isRgba(sampleAny(colorProp, frame))
    ? (sampleAny(colorProp, frame) as RGBA) : { r: 0.5, g: 0.5, b: 0.9, a: 1 };

  if (!isAnimated(colorProp)) {
    return <div style={{ color: "#888", fontSize: 11 }}>色プロパティがありません</div>;
  }

  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 4 }}>
      <Stopwatch active={colorProp.keyframes.length > 0} onClick={() => toggleKf("color", colorProp)} />
      <div style={{ flex: 1 }}>
        <ColorSwatch
          label="Fill"
          value={colorVal}
          onCommit={(v) => {
            if (colorProp.keyframes.length > 0) writeAnim("color", setKeyframe(colorProp as AnimatedProp<RGBA>, frame, v), "Edit solid color");
            else writeAnim("color", { ...colorProp, value: v }, "Edit solid color");
          }}
          onLiveChange={(v) => {
            if (colorProp.keyframes.length > 0) previewAnim("color", setKeyframe(colorProp as AnimatedProp<RGBA>, frame, v));
            else previewAnim("color", { ...colorProp, value: v });
          }}
          onFocus={onEditFocus}
          onBlur={onEditBlur}
        />
      </div>
    </div>
  );
}

/** §26.3.1 Font — 一般 web フォントのプルダウン + 「Custom…」で任意 family 入力。 */
function FontField({
  font,
  onChange,
  onEditFocus,
  onEditBlur,
}: {
  font: string;
  onChange: (value: string) => void;
  onEditFocus: () => void;
  onEditBlur: () => void;
}) {
  const known = isKnownFont(font);
  const [customMode, setCustomMode] = useState(!known);

  // 外部から font が変わり既知値になったら custom を解除（KF やプリセット適用に追従）。
  useEffect(() => {
    if (isKnownFont(font)) setCustomMode(false);
  }, [font]);

  const selectVal = customMode || !known ? "__custom__" : font;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
      <select
        value={selectVal}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__custom__") {
            setCustomMode(true);
          } else {
            setCustomMode(false);
            onChange(v);
          }
        }}
        style={selectStyle}
      >
        {WEB_SAFE_FONTS.map((f) => (
          <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>{f.label}</option>
        ))}
        <option value="__custom__">Custom…</option>
      </select>
      {(customMode || !known) && (
        <input
          value={font}
          placeholder="font-family (例: 'My Font', sans-serif)"
          onChange={(e) => onChange(e.target.value)}
          onFocus={onEditFocus}
          onBlur={onEditBlur}
          style={{ ...textInputStyle, flex: 1 }}
        />
      )}
    </div>
  );
}

function isAnimated(v: unknown): v is AnimatedProp<unknown> {
  return typeof v === "object" && v !== null && "value" in v && "keyframes" in v;
}

/** Source Text — 編集中は local draft を正とし Preview のみ live patch（ColorSwatch 同型）。 */
function TextSourceInput({
  textProp,
  frame,
  committed,
  onPreview,
  onCommit,
  onEditFocus,
  onEditBlur,
  onClearPreview,
}: {
  textProp: AnimatedProp<unknown>;
  frame: number;
  committed: string;
  onPreview: (next: AnimatedProp<unknown>) => void;
  onCommit: (value: string) => void;
  onEditFocus: () => void;
  onEditBlur: () => void;
  onClearPreview: () => void;
}) {
  const [draft, setDraft] = useState(committed);
  const draftRef = useRef(committed);
  const editingRef = useRef(false);
  const commitBaseRef = useRef(committed);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (!editingRef.current) {
      setDraft(committed);
      draftRef.current = committed;
      commitBaseRef.current = committed;
    }
  }, [committed]);

  const pushLive = (v: string) => {
    setDraft(v);
    draftRef.current = v;
    if (textProp.keyframes.length > 0) {
      onPreview(setKeyframe(textProp, frame, v, { type: "hold" }));
    } else {
      onPreview({ ...textProp, value: v });
    }
  };

  return (
    <textarea
      value={draft}
      rows={3}
      onFocus={() => {
        editingRef.current = true;
        onEditFocus();
      }}
      onChange={(e) => pushLive(e.target.value)}
      onBlur={() => {
        editingRef.current = false;
        onEditBlur();
        const v = draftRef.current;
        if (v === commitBaseRef.current) {
          onClearPreview();
          return;
        }
        onCommit(v);
        commitBaseRef.current = v;
      }}
      style={{ ...textAreaStyle, flex: 1 }}
    />
  );
}

function Stopwatch({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{ background: "none", border: "none", color: active ? "#f0c040" : "#555", cursor: "pointer", fontSize: 10, padding: 0, width: 14 }}
      title="Toggle keyframes"
    >
      ⬦
    </button>
  );
}

function AnimScalarRow({
  label, prop, value, onToggle, onCommit, onLiveChange, min, max, step,
}: {
  label: string;
  prop: AnimatedProp<number>;
  value: number;
  frame: number;
  onToggle: () => void;
  onCommit: (v: number) => void;
  onLiveChange?: (v: number) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <Row label={label}>
      <Stopwatch active={prop.keyframes.length > 0} onClick={onToggle} />
      <ScrubNumber
        value={value}
        onCommit={(v) => onCommit(v)}
        onLiveChange={onLiveChange}
        min={min}
        max={max}
        step={step}
        style={numInputStyle}
      />
    </Row>
  );
}

function InspectorFoldout({
  label,
  expanded,
  onToggle,
  children,
}: {
  label: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 4, border: "1px solid #333", borderRadius: 3, overflow: "hidden", background: "#252525" }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          width: "100%",
          padding: "4px 6px",
          border: "none",
          background: "#383838",
          color: "#ddd",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ width: 10, flexShrink: 0, color: "#aaa", fontSize: 10 }}>{expanded ? "▼" : "▶"}</span>
        <span style={{ display: "inline-flex", alignItems: "center", flex: 1 }}>{label}</span>
      </button>
      {expanded && (
        <div style={{ padding: "6px 8px 8px", background: "#1e1e1e" }}>
          {children}
        </div>
      )}
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
  label, vals, onChange, onLiveChange, hasKf, speeds,
}: {
  label: string;
  vals: { x: string; y: string; z: string };
  onChange: (v: Vec3, deltaParts?: Partial<Vec3>) => void;
  onLiveChange?: (v: Vec3) => void;
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

  const live = (axis: "x" | "y" | "z", newVal: number) => {
    if (!Number.isFinite(newVal) || !onLiveChange) return;
    const base = {
      x: parseFloat(vals.x),
      y: parseFloat(vals.y),
      z: parseFloat(vals.z),
    };
    onLiveChange({ ...base, [axis]: newVal });
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
            onLiveChange={(v) => live(ax, v)}
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

const textInputStyle: React.CSSProperties = {
  background: "#2a2a2a",
  border: "1px solid #444",
  color: "#ddd",
  borderRadius: 3,
  padding: "2px 4px",
  fontSize: 11,
};

const textAreaStyle: React.CSSProperties = {
  ...textInputStyle,
  resize: "vertical",
  fontFamily: "inherit",
};

const selectStyle: React.CSSProperties = {
  ...textInputStyle,
  flex: 1,
};
