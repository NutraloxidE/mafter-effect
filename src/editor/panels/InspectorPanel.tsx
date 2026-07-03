import { useEffect, useRef, useState, type ReactNode } from "react";
import { sampleAny, sampleScalar, sampleVec3 } from "../../runtime/interpolate";
import type { AnimatedProp, BlendMode, Component, Easing, EffectInstance, ExpressionPresetInstance, ParamDescriptor, RGBA, SceneObject, ThreeDMode, Transform, Vec3 } from "../../core/schema";
import { BLEND_MODES } from "../../core/schema";
import { formatMissingBlendModeLabel } from "../../core/blendMode";
import {
  currentTimelineComp,
  setKeyframe,
  useEditorStore,
} from "../store";
import { EXPRESSED_VALUE_COLOR, isPropExpressed, staticProp } from "../../core/props";
import { pulseCycleT, pulseModulation } from "../../runtime/pulseScaleWave";
import { ColorSwatch, isRgba } from "../ColorSwatch";
import { BUNDLED_FONTS, WEB_SAFE_FONTS, isKnownFont } from "../fontList";
import { ScrubNumber } from "../ScrubNumber";
import { TimecodeScrub } from "../TimecodeScrub";
import { applyLinkedScaleDelta, applyLinkedScaleValue } from "../linkedScale";
import { formatBarBeat } from "../beatTimecode";
import { globalPluginRegistry } from "../../runtime/pluginRegistry";
import { QUALITY_UI_GROUPS, footageQualityLabel, isProxyTier, normalizeFootageQuality, type FootageQuality } from "../../runtime/footageQuality";
import { evictPreviewMediaAsset } from "../../runtime/imageAssetCache";
import { groupEffectsForPicker } from "../effectCategories";
import { BakerBadge } from "../bakerLabel";
import { BackgroundControl } from "./BackgroundControl";
import { VideoComponentFields } from "./VideoComponentFields";
import {
  buildDefaultPresetProps,
  EXPRESSION_PRESET_LIST,
  EXPRESSION_PRESETS,
  parsePresetMarker,
  presetIdFromExpressionPath,
  type ExpressionPresetId,
  type ExpressionPresetParam,
} from "../expressionPresets";

const EASING_PRESETS: { label: string; easing: Easing }[] = [
  { label: "Linear", easing: { type: "linear" } },
  { label: "Ease In Out", easing: { type: "bezier", bezier: [0.42, 0, 0.58, 1] } },
  { label: "Ease In", easing: { type: "bezier", bezier: [0.42, 0, 1, 1] } },
  { label: "Ease Out", easing: { type: "bezier", bezier: [0, 0, 0.58, 1] } },
  { label: "Snappy Out", easing: { type: "bezier", bezier: [0.2, 0.9, 0.1, 1.0] } },
  { label: "Hold", easing: { type: "hold" } },
];

// §5.4d ブレンドモードの表示名（AE 風）。
const BLEND_MODE_LABELS: Record<BlendMode, string> = {
  normal: "Normal",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  darken: "Darken",
  lighten: "Lighten",
  "color-dodge": "Color Dodge",
  "color-burn": "Color Burn",
  "hard-light": "Hard Light",
  "soft-light": "Soft Light",
  difference: "Difference",
  exclusion: "Exclusion",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
};

/** Transform 等のレイヤー Inspector と同じスクロール枠（overlay scrollbar 時も右余白を揃える）。 */
const INSPECTOR_ROOT_STYLE: React.CSSProperties = {
  fontSize: 12,
  color: "#ccc",
  padding: 4,
  overflowY: "auto",
  overflowX: "hidden",
  scrollbarGutter: "stable",
  height: "100%",
  width: "100%",
  boxSizing: "border-box",
  minWidth: 0,
  background: "#1c1c1c",
};

const INSPECTOR_HEADER_STYLE: React.CSSProperties = {
  padding: "6px 8px 8px",
  fontWeight: "bold",
  color: "#eee",
  fontSize: 13,
};

export function InspectorPanel() {
  const project = useEditorStore((s) => s.project);
  const compId = useEditorStore((s) => s.currentCompId);
  const frame = useEditorStore((s) => s.currentFrame);
  const selectedIds = useEditorStore((s) => s.selectedObjectIds);
  const updateObject = useEditorStore((s) => s.updateObject);
  const updateObjects = useEditorStore((s) => s.updateObjects);
  const addExpressionPreset = useEditorStore((s) => s.addExpressionPreset);
  const removeExpressionPreset = useEditorStore((s) => s.removeExpressionPreset);
  const toggleExpressionPreset = useEditorStore((s) => s.toggleExpressionPreset);
  const getFs = useEditorStore((s) => s.getFs);
  const projectRevision = useEditorStore((s) => s.projectRevision);
  const setPreviewQualityEditing = useEditorStore((s) => s.setPreviewQualityEditing);
  const setPreviewOverride = useEditorStore((s) => s.setPreviewOverride);
  const clearPreviewOverride = useEditorStore((s) => s.clearPreviewOverride);
  const decomposeGlyphs = useEditorStore((s) => s.decomposeGlyphs);
  const addEffect = useEditorStore((s) => s.addEffect);
  const setAdjustmentMode = useEditorStore((s) => s.setAdjustmentMode);
  const setThreeD = useEditorStore((s) => s.setThreeD);
  const setThreeDMode = useEditorStore((s) => s.setThreeDMode);
  const setBlendMode = useEditorStore((s) => s.setBlendMode);
  const missingBlendModes = useEditorStore((s) => s.missingBlendModes);
  const setCompBackground = useEditorStore((s) => s.setCompBackground);
  const resizeComp = useEditorStore((s) => s.resizeComp);
  const setCompFps = useEditorStore((s) => s.setCompFps);
  const setCompDuration = useEditorStore((s) => s.setCompDuration);
  const setCompBpm = useEditorStore((s) => s.setCompBpm);
  const setCompBeatsPerBar = useEditorStore((s) => s.setCompBeatsPerBar);
  const scaleLinkEnabled = useEditorStore((s) => s.scaleLinkEnabled);
  const setScaleLinkEnabled = useEditorStore((s) => s.setScaleLinkEnabled);
  const previewCamera = useEditorStore((s) => s.previewCamera);
  const setPreviewCamera = useEditorStore((s) => s.setPreviewCamera);
  const removeEffect = useEditorStore((s) => s.removeEffect);
  const reorderEffect = useEditorStore((s) => s.reorderEffect);
  const toggleEffect = useEditorStore((s) => s.toggleEffect);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [addEffectOpen, setAddEffectOpen] = useState(false);
  const [addExprPresetOpen, setAddExprPresetOpen] = useState(false);
  const [highlightEffectId, setHighlightEffectId] = useState<string | null>(null);
  const [legacyPresetIds, setLegacyPresetIds] = useState<Partial<Record<ExpressionPresetParam, ExpressionPresetId>>>({});
  const effectRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const panelScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!highlightEffectId) return;
    const t = window.setTimeout(() => setHighlightEffectId(null), 1800);
    return () => window.clearTimeout(t);
  }, [highlightEffectId]);

  const comp = currentTimelineComp(project, compId);
  const obj = comp?.objects.find((o) => o.id === selectedIds[0]);

  useEffect(() => {
    if (!obj) {
      setLegacyPresetIds({});
      return;
    }
    let cancelled = false;
    const fs = getFs();

    void (async () => {
      const next: Partial<Record<ExpressionPresetParam, ExpressionPresetId>> = {};
      const persistedParams = new Set(
        (obj.expressionPresets ?? []).map((p) => EXPRESSION_PRESETS[p.presetId as ExpressionPresetId]?.param).filter(Boolean),
      );

      const readParam = async (param: ExpressionPresetParam, ex: { path: string; enabled: boolean } | undefined) => {
        if (!ex?.enabled || persistedParams.has(param)) return;
        const fromPath = presetIdFromExpressionPath(ex.path);
        if (fromPath) {
          next[param] = fromPath;
          return;
        }
        try {
          const id = parsePresetMarker(await fs.readText(ex.path));
          if (id) next[param] = id;
        } catch { /* file missing */ }
      };

      await readParam("position", obj.transform.position.expression);
      await readParam("scale", obj.transform.scale.expression);
      if (!cancelled) setLegacyPresetIds(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    obj,
    getFs,
    projectRevision,
  ]);

  const toggleExpanded = (section: string) => {
    const key = obj ? `${obj.id}:${section}` : `${compId}:${section}`;
    setExpanded((prev) => ({ ...prev, [key]: !(prev[key] ?? true) }));
  };
  const isExpanded = (section: string) => {
    const key = obj ? `${obj.id}:${section}` : `${compId}:${section}`;
    return expanded[key] ?? true;
  };

  if (!obj) {
    if (!comp) {
      return (
        <div style={{ padding: 16, color: "#555", fontSize: 12 }}>
          Select an object to inspect
        </div>
      );
    }
    return (
      <div ref={panelScrollRef} style={INSPECTOR_ROOT_STYLE}>
        <div style={INSPECTOR_HEADER_STYLE}>{comp.name}</div>
        <InspectorFoldout
          label="Composition"
          expanded={isExpanded("composition")}
          onToggle={() => toggleExpanded("composition")}
        >
          <Row label="Size">
            <ScrubNumber
              value={comp.width}
              onCommit={(v) => resizeComp(Math.round(v), comp.height)}
              min={1}
              decimals={0}
              step={1}
              style={numInputStyle}
            />
            <span style={{ color: "#555", fontSize: 10 }}>×</span>
            <ScrubNumber
              value={comp.height}
              onCommit={(v) => resizeComp(comp.width, Math.round(v))}
              min={1}
              decimals={0}
              step={1}
              style={numInputStyle}
            />
            <span style={{ color: "#666", fontSize: 10, marginLeft: 2 }}>px</span>
          </Row>
          <Row label="Frame Rate">
            <ScrubNumber
              value={comp.fps}
              onCommit={(v) => setCompFps(v)}
              min={1}
              step={1}
              style={numInputStyle}
            />
            <span style={{ color: "#666", fontSize: 10, marginLeft: 2 }}>fps</span>
          </Row>
          <Row label="Duration">
            <TimecodeScrub
              value={comp.duration}
              fps={comp.fps}
              onCommit={(v) => setCompDuration(Math.round(v))}
              min={1}
              style={numInputStyle}
            />
          </Row>
          <Row label="BPM">
            <ScrubNumber
              value={comp.bpm ?? 0}
              onCommit={(v) => setCompBpm(v)}
              min={0}
              decimals={1}
              step={1}
              style={numInputStyle}
            />
            <span style={{ color: "#666", fontSize: 10, marginLeft: 2 }}>bpm</span>
            {comp.bpm !== undefined && comp.bpm > 0 && (
              <span style={{ color: "#7fb8f0", fontSize: 10, marginLeft: 6, fontVariantNumeric: "tabular-nums" }}>
                {formatBarBeat(frame, comp.fps, comp.bpm, comp.beatsPerBar)}
              </span>
            )}
          </Row>
          {comp.bpm !== undefined && comp.bpm > 0 && (
            <Row label="Beats / Bar">
              <ScrubNumber
                value={comp.beatsPerBar ?? 4}
                onCommit={(v) => setCompBeatsPerBar(v)}
                min={1}
                decimals={0}
                step={1}
                style={numInputStyle}
              />
            </Row>
          )}
          <Row label="Background">
            <BackgroundControl comp={comp} onChange={setCompBackground} />
          </Row>
        </InspectorFoldout>
      </div>
    );
  }

  const pos = sampleVec3(obj.transform.position, frame);
  const anchor = sampleVec3(obj.transform.anchor, frame);
  const rot = sampleVec3(obj.transform.rotation, frame);
  const scl = sampleVec3(obj.transform.scale, frame);
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
    linkedScale = false,
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
            if (linkedScale && key === "scale") {
              const axis = (["x", "y", "z"] as const).find((ax) => deltaParts[ax] !== undefined);
              if (axis !== undefined) {
                value = applyLinkedScaleDelta(cur, axis, deltaParts[axis]!, true);
              } else {
                value = {
                  x: cur.x + (deltaParts.x ?? 0),
                  y: cur.y + (deltaParts.y ?? 0),
                  z: cur.z + (deltaParts.z ?? 0),
                };
              }
            } else {
              value = {
                x: cur.x + (deltaParts.x ?? 0),
                y: cur.y + (deltaParts.y ?? 0),
                z: cur.z + (deltaParts.z ?? 0),
              };
            }
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

  const foldoutKey = (section: string) => `${obj.id}:${section}`;

  const handleAddExpressionPreset = (presetId: ExpressionPresetId) => {
    setAddExprPresetOpen(false);
    void addExpressionPreset(obj.id, presetId);
    setExpanded((prev) => ({
      ...prev,
      [foldoutKey("expressions")]: true,
    }));
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

  const legacyInstances: ExpressionPresetInstance[] = Object.entries(legacyPresetIds).flatMap(([param, presetId]) => {
    if (!presetId) return [];
    const p = EXPRESSION_PRESETS[presetId];
    const ex =
      p.param === "position" ? obj.transform.position.expression : obj.transform.scale.expression;
    return [{
      id: `legacy-${param}`,
      presetId,
      enabled: ex?.enabled === true,
      props: buildDefaultPresetProps(presetId),
    }];
  });

  const expressionInstances: ExpressionPresetInstance[] = [
    ...(obj.expressionPresets ?? []),
    ...legacyInstances.filter(
      (leg) => !(obj.expressionPresets ?? []).some(
        (p) => EXPRESSION_PRESETS[p.presetId as ExpressionPresetId]?.param
          === EXPRESSION_PRESETS[leg.presetId as ExpressionPresetId]?.param,
      ),
    ),
  ];

  const handleRemoveExpression = (inst: ExpressionPresetInstance) => {
    if (inst.id.startsWith("legacy-")) {
      const preset = EXPRESSION_PRESETS[inst.presetId as ExpressionPresetId];
      if (preset.param === "position") {
        const { expression: _ex, ...posRest } = obj.transform.position;
        updateObject(obj.id, { transform: { ...obj.transform, position: posRest } }, `Remove ${preset.label}`);
      } else {
        const { expression: _ex, ...scaleRest } = obj.transform.scale;
        updateObject(obj.id, { transform: { ...obj.transform, scale: scaleRest } }, `Remove ${preset.label}`);
      }
      return;
    }
    removeExpressionPreset(obj.id, inst.id);
  };

  const handleToggleExpression = (inst: ExpressionPresetInstance, enabled: boolean) => {
    if (inst.id.startsWith("legacy-")) {
      const preset = EXPRESSION_PRESETS[inst.presetId as ExpressionPresetId];
      const ex = preset.param === "position" ? obj.transform.position.expression : obj.transform.scale.expression;
      if (!ex) return;
      if (preset.param === "position") {
        updateObject(
          obj.id,
          { transform: { ...obj.transform, position: { ...obj.transform.position, expression: { ...ex, enabled } } } },
          enabled ? `Enable ${preset.label}` : `Disable ${preset.label}`,
        );
      } else {
        updateObject(
          obj.id,
          { transform: { ...obj.transform, scale: { ...obj.transform.scale, expression: { ...ex, enabled } } } },
          enabled ? `Enable ${preset.label}` : `Disable ${preset.label}`,
        );
      }
      return;
    }
    toggleExpressionPreset(obj.id, inst.id, enabled);
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
    <div ref={panelScrollRef} style={INSPECTOR_ROOT_STYLE}>
      <div style={{ ...INSPECTOR_HEADER_STYLE, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <LayerNameHeader objId={obj.id} name={obj.name} />
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
          expressed={isPropExpressed(obj.transform.position)}
          speeds={{ x: 1, y: 1, z: 1 }}
        />
        <Vec3Row label="Anchor" vals={anchor}
          onChange={(v, dp) => setVec3Kf("anchor", v, dp)}
          onLiveChange={(v) => previewPatch({ transform: buildTransformPreview("anchor", v) })}
          hasKf={obj.transform.anchor.keyframes.length > 0}
          expressed={isPropExpressed(obj.transform.anchor)}
          speeds={{ x: 1, y: 1, z: 1 }}
        />
        <Vec3Row label="Rotation" vals={rot}
          onChange={(v, dp) => setVec3Kf("rotation", v, dp)}
          onLiveChange={(v) => previewPatch({ transform: buildTransformPreview("rotation", v) })}
          hasKf={obj.transform.rotation.keyframes.length > 0}
          expressed={isPropExpressed(obj.transform.rotation)}
          speeds={{ x: 0.5, y: 0.5, z: 0.5 }}
        />
        <ScaleVec3Row label="Scale" vals={scl}
          linked={scaleLinkEnabled}
          onToggleLink={() => setScaleLinkEnabled(!scaleLinkEnabled)}
          onChange={(v, dp) => setVec3Kf("scale", v, dp, { type: "linear" }, scaleLinkEnabled)}
          onLiveChange={(v) => previewPatch({ transform: buildTransformPreview("scale", v) })}
          hasKf={obj.transform.scale.keyframes.length > 0}
          expressed={isPropExpressed(obj.transform.scale)}
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
            style={numInputStyleFor(obj.opacity)}
          />
        </Row>
        <Row label="Blend Mode">
          <select
            value={missingBlendModes[obj.id] ? "__missing__" : (obj.blendMode ?? "normal")}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__missing__") return;
              setBlendMode(obj.id, v as BlendMode);
            }}
            style={selectStyle}
          >
            {missingBlendModes[obj.id] && (
              <option value="__missing__">{formatMissingBlendModeLabel(missingBlendModes[obj.id]!)}</option>
            )}
            {BLEND_MODES.map((m) => (
              <option key={m} value={m}>{BLEND_MODE_LABELS[m]}</option>
            ))}
          </select>
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
          <Row label="Preview View">
            <button
              type="button"
              title="プレビュー視点をこのカメラに切替（§6.5・AE の 3D View 相当）。出力カメラは常に最前面の可視カメラで、これは表示視点だけを変え export に影響しない。"
              onClick={() => setPreviewCamera(previewCamera === obj.id ? null : obj.id)}
              style={{ ...btnStyle, background: previewCamera === obj.id ? "#5a4a20" : "#2a2a2a", color: previewCamera === obj.id ? "#f0c060" : "#ccc" }}
            >
              {previewCamera === obj.id ? "Previewing ●" : "Preview through"}
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
          const def = globalPluginRegistry.getComponentDef(comp.type);
          if (
            comp.type !== "text" &&
            comp.type !== "solid" &&
            comp.type !== "audio" &&
            comp.type !== "video"
          ) return null;
          const label = def?.label ?? comp.type;
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
              ) : comp.type === "solid" ? (
                <SolidComponentFields
                  obj={obj}
                  compIdx={compIdx}
                  frame={frame}
                  updateObject={updateObject}
                  previewPatch={previewPatch}
                  onEditFocus={() => setPreviewQualityEditing(true)}
                  onEditBlur={() => setPreviewQualityEditing(false)}
                />
              ) : comp.type === "video" ? (
                <VideoComponentFields
                  obj={obj}
                  compIdx={compIdx}
                  frame={frame}
                  updateObject={updateObject}
                  previewPatch={previewPatch}
                  onEditFocus={() => setPreviewQualityEditing(true)}
                  onEditBlur={() => setPreviewQualityEditing(false)}
                  componentFields={ComponentFields}
                />
              ) : (
                <ComponentFields
                  obj={obj}
                  compIdx={compIdx}
                  params={def?.params ?? []}
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

      <InspectorFoldout label="Expressions" expanded={isExpanded("expressions")} onToggle={() => toggleExpanded("expressions")}>
        <button
          type="button"
          onClick={() => setAddExprPresetOpen((o) => !o)}
          style={{ ...btnStyle, width: "100%", marginBottom: 8, fontSize: 11 }}
        >
          {addExprPresetOpen ? "▾ Expression を選択" : "+ Expression を追加"}
        </button>
        {addExprPresetOpen && (
          <div style={{ marginBottom: 10, padding: "6px 4px", background: "#2a3340", border: "1px solid #5a8fd0", borderRadius: 4 }}>
            {EXPRESSION_PRESET_LIST.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleAddExpressionPreset(preset.id)}
                style={{
                  display: "block",
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
                {preset.label}
              </button>
            ))}
          </div>
        )}
        {expressionInstances.length === 0 && !addExprPresetOpen && (
          <div style={{ color: "#666", fontSize: 10, marginBottom: 6, padding: "0 2px" }}>
            Expression なし — 上のボタンから追加
          </div>
        )}
        {expressionInstances.map((inst) => {
          const def = EXPRESSION_PRESETS[inst.presetId as ExpressionPresetId];
          const label = def?.label ?? inst.presetId;
          const sectionKey = `expr:${inst.id}`;
          const isLegacy = inst.id.startsWith("legacy-");
          return (
            <div key={inst.id} style={{ marginBottom: 4 }}>
              <InspectorFoldout
                label={`${inst.enabled ? "●" : "○"} ${label}${isLegacy ? " (legacy)" : ""}`}
                expanded={isExpanded(sectionKey)}
                onToggle={() => toggleExpanded(sectionKey)}
              >
                <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
                  <button
                    onClick={() => handleToggleExpression(inst, !inst.enabled)}
                    style={{ ...btnStyle, fontSize: 10 }}
                  >
                    {inst.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    onClick={() => handleRemoveExpression(inst)}
                    style={{ ...btnStyle, fontSize: 10, color: "#f66" }}
                  >
                    ×
                  </button>
                </div>
                <ExpressionPresetFields
                  obj={obj}
                  instance={inst}
                  presetId={inst.presetId as ExpressionPresetId}
                  params={def?.params ?? []}
                  frame={frame}
                  fps={comp?.fps ?? 30}
                  readOnly={isLegacy}
                  onMigrate={(propsOverrides) =>
                    void addExpressionPreset(obj.id, inst.presetId as ExpressionPresetId, propsOverrides)
                  }
                  updateObject={updateObject}
                  previewPatch={previewPatch}
                />
              </InspectorFoldout>
            </div>
          );
        })}
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

function samplePresetStaticEnum(
  props: ExpressionPresetInstance["props"],
  key: string,
  defaultVal: string,
): string {
  const raw = props[key];
  return typeof raw === "string" ? raw : defaultVal;
}

function samplePresetScalar(
  props: ExpressionPresetInstance["props"],
  key: string,
  defaultVal: number,
  frame: number,
): number {
  const raw = props[key];
  if (raw === undefined) return defaultVal;
  if (typeof raw === "number") return raw;
  if (isAnimated(raw)) {
    const v = sampleAny(raw, frame);
    return typeof v === "number" ? v : defaultVal;
  }
  return defaultVal;
}

/** Pulse Scale: 1 周期の変調カーブ（Bend の凹/凸を即確認）。 */
function PulseScaleWavePreview({
  props,
  frame,
  fps,
}: {
  props: ExpressionPresetInstance["props"];
  frame: number;
  fps: number;
}) {
  const waveform = samplePresetStaticEnum(props, "waveform", "sine");
  const polarity = samplePresetStaticEnum(props, "polarity", "+");
  const bend = samplePresetScalar(props, "bend", 0, frame);
  const phase = samplePresetScalar(props, "phase", 0, frame);
  const frequency = samplePresetScalar(props, "frequency", 2, frame);
  const W = 168;
  const H = 44;
  const pad = 2;
  const innerW = W - pad * 2;
  const innerH = H - pad * 2;
  const midY = pad + innerH / 2;
  const pts: string[] = [];
  const steps = 80;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const w = pulseModulation(waveform, bend, t, polarity);
    const x = pad + (i / steps) * innerW;
    const y = midY - w * (innerH / 2 - 2);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const timeSec = frame / Math.max(1, fps);
  const cycleT = pulseCycleT(timeSec, frequency, phase);
  const playX = pad + cycleT * innerW;
  const bendLabel = bend === 0 ? "0" : bend > 0 ? `+${bend.toFixed(2)}` : bend.toFixed(2);

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#666", marginBottom: 3 }}>
        <span>1 cycle · bend {bendLabel} · φ{phase.toFixed(0)}° · {polarity}</span>
        <span style={{ color: waveform === "sawtooth" ? "#6ad4aa" : "#888" }}>
          {waveform === "sawtooth" ? "bend が最も分かりやすい" : "sawtooth 推奨"}
        </span>
      </div>
      <svg
        width={W}
        height={H}
        style={{ display: "block", background: "#141414", borderRadius: 3, border: "1px solid #2a2a2a" }}
        aria-label="Pulse scale waveform preview"
      >
        <line x1={pad} y1={midY} x2={W - pad} y2={midY} stroke="#2e2e2e" strokeWidth={1} />
        <polyline points={pts.join(" ")} fill="none" stroke="#5ecfaa" strokeWidth={1.5} strokeLinejoin="round" />
        <line x1={playX} y1={pad} x2={playX} y2={H - pad} stroke="#e07070" strokeWidth={1} opacity={0.85} />
      </svg>
    </div>
  );
}

function ExpressionPresetFields({
  obj,
  instance,
  presetId,
  params,
  frame,
  fps,
  readOnly,
  onMigrate,
  updateObject,
  previewPatch,
}: {
  obj: SceneObject;
  instance: ExpressionPresetInstance;
  presetId: ExpressionPresetId;
  params: ParamDescriptor[];
  frame: number;
  fps: number;
  readOnly: boolean;
  onMigrate: (propsOverrides?: Record<string, unknown>) => void;
  updateObject: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  previewPatch: (patch: Partial<SceneObject>) => void;
}) {
  const props = instance.props;
  const previewOverride = useEditorStore((s) => s.previewOverride);
  const displayProps =
    previewOverride?.objectId === obj.id && previewOverride.patch.expressionPresets
      ? previewOverride.patch.expressionPresets.find((p) => p.id === instance.id)?.props ?? props
      : props;

  const writePresets = (nextProps: ExpressionPresetInstance["props"], label: string) => {
    if (readOnly) {
      onMigrate();
      return;
    }
    const next = (obj.expressionPresets ?? []).map((p) =>
      p.id === instance.id ? { ...p, props: nextProps } : p,
    );
    updateObject(obj.id, { expressionPresets: next }, label);
  };

  const previewPresets = (nextProps: ExpressionPresetInstance["props"]) => {
    if (readOnly) return;
    previewPatch({
      expressionPresets: (obj.expressionPresets ?? []).map((p) =>
        p.id === instance.id ? { ...p, props: nextProps } : p,
      ),
    });
  };

  const writeAnim = <T,>(key: string, next: AnimatedProp<T>, label: string) => {
    writePresets({ ...props, [key]: next }, label);
  };

  const previewAnim = <T,>(key: string, next: AnimatedProp<T>) => {
    previewPresets({ ...props, [key]: next });
  };

  const toggleKf = (key: string, prop: AnimatedProp<unknown>) => {
    if (readOnly) {
      onMigrate();
      return;
    }
    if (prop.keyframes.length > 0) writeAnim(key, { value: prop.value, keyframes: [] }, `Disable ${key} keyframes`);
    else writeAnim(key, setKeyframe(prop, frame, prop.value, { type: "hold" }), `Enable ${key} keyframes`);
  };

  return (
    <>
      {readOnly && (
        <div style={{ fontSize: 10, color: "#888", marginBottom: 6 }}>
          旧形式 — パラメータ編集で新形式へ移行します
        </div>
      )}
      {presetId === "pulse-scale" && (
        <PulseScaleWavePreview
          props={displayProps}
          frame={frame}
          fps={fps}
        />
      )}
      {params.map((param) => {
        const stored = props[param.key];
        const raw =
          stored === undefined && param.animatable
            ? staticProp(param.default)
            : stored;
        if (param.key === "footageQuality") {
          const assetId = typeof props["asset"] === "string" ? (props["asset"] as string) : "";
          return (
            <QualitySelect
              key={param.key}
              label={param.label}
              value={normalizeFootageQuality(raw)}
              assetId={assetId}
              disabled={readOnly}
              onCommit={(q) => {
                if (readOnly) { onMigrate({ [param.key]: q }); return; }
                writePresets({ ...props, [param.key]: q }, `Edit ${param.label}`);
              }}
            />
          );
        }
        if (param.kind === "enum" && !param.animatable) {
          const val = typeof raw === "string" ? raw : String(param.default ?? "");
          return (
            <Row key={param.key} label={param.label}>
              <select
                value={val}
                disabled={readOnly}
                onChange={(e) => {
                  if (readOnly) { onMigrate({ [param.key]: e.target.value }); return; }
                  writePresets({ ...props, [param.key]: e.target.value }, `Edit ${param.label}`);
                }}
                style={selectStyle}
              >
                {(param.options ?? []).map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
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
                if (readOnly) { onMigrate(); return; }
                if (raw.keyframes.length > 0) writeAnim(param.key, setKeyframe(raw as AnimatedProp<number>, frame, v), `Edit ${param.label}`);
                else writeAnim(param.key, { ...raw, value: v }, `Edit ${param.label}`);
              }}
              onLiveChange={(v) => {
                if (readOnly) return;
                previewAnim(param.key, raw.keyframes.length > 0 ? setKeyframe(raw as AnimatedProp<number>, frame, v) : { ...raw, value: v });
              }}
              min={param.min}
              max={param.max}
              step={param.step}
              speed={param.key === "bend" ? 0.1 : undefined}
            />
          );
        }
        return null;
      })}
    </>
  );
}

/** §11.4b 画質ティア選択。optgroup + friendly ラベル + 選択時に lazy プロキシ生成（進捗表示）。 */
function QualitySelect({
  label,
  value,
  assetId,
  disabled,
  onCommit,
}: {
  label: string;
  value: FootageQuality;
  assetId: string;
  disabled?: boolean;
  onCommit: (q: FootageQuality) => void;
}) {
  const ensureProxyTier = useEditorStore((s) => s.ensureProxyTier);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const onChange = (q: FootageQuality) => {
    onCommit(q);
    // 画質切替で warm-up 済みフレームと旧 blob を破棄（プロキシ取り違え防止）。
    if (assetId) evictPreviewMediaAsset(assetId);
    setFailed(false);
    if (assetId && isProxyTier(q)) {
      setBusy(true);
      void (async () => {
        const ok = await ensureProxyTier(assetId, q);
        setBusy(false);
        setFailed(!ok);
      })();
    }
  };

  return (
    <Row label={label}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
        <select
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(normalizeFootageQuality(e.target.value))}
          style={selectStyle}
        >
          {QUALITY_UI_GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.tiers.map((t) => (
                <option key={t} value={t}>{footageQualityLabel(t)}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {busy && <span style={{ fontSize: 11, opacity: 0.7, whiteSpace: "nowrap" }}>generating…</span>}
        {failed && !busy && <span style={{ fontSize: 11, color: "#e57373", whiteSpace: "nowrap" }}>proxy failed</span>}
      </div>
    </Row>
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
                expressed={isPropExpressed(raw)}
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

/**
 * ComponentDef.params 駆動の汎用コンポーネント Inspector（audio / video の Volume 等）。
 * EffectFields と同型: enum/bool は非 animatable 編集、scalar は AnimScalarRow + ストップウォッチ。
 * asset / 非対応 kind は描画しない（タイムライン KF 行は ComponentDef + AnimatedProp で自動）。
 */
function ComponentFields({
  obj,
  compIdx,
  params,
  frame,
  updateObject,
  previewPatch,
  onEditFocus,
  onEditBlur,
}: {
  obj: SceneObject;
  compIdx: number;
  params: ParamDescriptor[];
  frame: number;
  updateObject: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  previewPatch: (patch: Partial<SceneObject>) => void;
  onEditFocus?: () => void;
  onEditBlur?: () => void;
}) {
  const props = obj.components[compIdx]?.props ?? {};

  const writeProps = (nextProps: Component["props"], label: string) => {
    const nextComponents = obj.components.map((c, i) =>
      i === compIdx ? { ...c, props: nextProps } : c,
    );
    updateObject(obj.id, { components: nextComponents }, label);
  };

  const previewProps = (nextProps: Component["props"]) => {
    previewPatch({
      components: obj.components.map((c, i) =>
        i === compIdx ? { ...c, props: nextProps } : c,
      ),
    });
  };

  const writeAnim = <T,>(key: string, next: AnimatedProp<T>, label: string) => {
    writeProps({ ...props, [key]: next }, label);
  };
  const previewAnim = <T,>(key: string, next: AnimatedProp<T>) => {
    previewProps({ ...props, [key]: next });
  };
  const toggleKf = (key: string, prop: AnimatedProp<unknown>) => {
    if (prop.keyframes.length > 0) writeAnim(key, { value: prop.value, keyframes: [] }, `Disable ${key} keyframes`);
    else writeAnim(key, setKeyframe(prop, frame, prop.value, { type: "hold" }), `Enable ${key} keyframes`);
  };

  return (
    <>
      {params.map((param) => {
        // plain number で保存された既存 prop（旧 gain 等）は lazy に staticProp 化して扱う。
        const stored = props[param.key];
        const raw =
          param.animatable && !isAnimated(stored)
            ? staticProp(typeof stored === "number" ? stored : param.default)
            : stored;

        if (param.kind === "enum" && !param.animatable) {
          const val = typeof raw === "string" ? raw : String(param.default ?? "");
          return (
            <Row key={param.key} label={param.label}>
              <select
                value={val}
                onChange={(e) => writeProps({ ...props, [param.key]: e.target.value }, `Edit ${param.label}`)}
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
          // §11.5.2 autoFade 等。後から追加された bool param は既存 props に無い → 既定値で描画。
          const checked = typeof raw === "boolean" ? raw : Boolean(param.default);
          return (
            <Row key={param.key} label={param.label}>
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => writeProps({ ...props, [param.key]: e.target.checked }, `Edit ${param.label}`)}
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
                onEditBlur?.();
                if (raw.keyframes.length > 0) writeAnim(param.key, setKeyframe(raw as AnimatedProp<number>, frame, v), `Edit ${param.label}`);
                else writeAnim(param.key, { ...raw, value: v }, `Edit ${param.label}`);
              }}
              onLiveChange={(v) => {
                onEditFocus?.();
                previewAnim(param.key, raw.keyframes.length > 0 ? setKeyframe(raw as AnimatedProp<number>, frame, v) : { ...raw, value: v });
              }}
              min={param.min}
              max={param.max}
              step={param.step ?? 0.05}
            />
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
  // §26.3.3 ボックスギズモ編集モード（hooks は早期 return より前に呼ぶ）。
  const boxGizmoEnabled = useEditorStore((s) => s.boxGizmoEnabled);
  const setBoxGizmoEnabled = useEditorStore((s) => s.setBoxGizmoEnabled);
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
  const boxWidthProp = props["boxWidth"];
  const boxHeightProp = props["boxHeight"];
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
  const boxWidthVal = isAnimated(boxWidthProp) && typeof sampleAny(boxWidthProp, frame) === "number"
    ? (sampleAny(boxWidthProp, frame) as number) : 0;
  const boxHeightVal = isAnimated(boxHeightProp) && typeof sampleAny(boxHeightProp, frame) === "number"
    ? (sampleAny(boxHeightProp, frame) as number) : 0;
  const strokeColorVal = isAnimated(strokeColorProp) && isRgba(sampleAny(strokeColorProp, frame))
    ? (sampleAny(strokeColorProp, frame) as RGBA) : { r: 0, g: 0, b: 0, a: 1 };
  const strokeWidthVal = isAnimated(strokeWidthProp) && typeof sampleAny(strokeWidthProp, frame) === "number"
    ? (sampleAny(strokeWidthProp, frame) as number) : 0;

  const font = typeof props["font"] === "string" ? props["font"] : "sans-serif";
  const align = props["align"] === "center" || props["align"] === "right" || props["align"] === "justify"
    ? props["align"] : "left";
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
              expressed={isPropExpressed(colorProp)}
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
              expressed={isPropExpressed(strokeColorProp)}
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
        {(["left", "center", "right", "justify"] as const).map((a) => (
          <button
            key={a}
            onClick={() => writeStatic("align", a, "Edit align")}
            style={{ ...btnStyle, background: align === a ? "#3a4a5a" : "#2a2a2a", fontSize: 10, minWidth: 28 }}
            title={a === "justify" ? "両端揃え（Box Width > 0 のときのみ有効）" : a}
          >
            {a === "left" ? "L" : a === "center" ? "C" : a === "right" ? "R" : "J"}
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
      {isAnimated(boxWidthProp) && (
        <AnimScalarRow
          label="Box Width"
          prop={boxWidthProp as AnimatedProp<number>}
          value={boxWidthVal}
          frame={frame}
          onToggle={() => toggleKf("boxWidth", boxWidthProp)}
          onCommit={(v) => {
            if (boxWidthProp.keyframes.length > 0) writeAnim("boxWidth", setKeyframe(boxWidthProp as AnimatedProp<number>, frame, v), "Edit box width");
            else writeAnim("boxWidth", { ...boxWidthProp, value: v }, "Edit box width");
          }}
          onLiveChange={(v) => {
            if (boxWidthProp.keyframes.length > 0) previewAnim("boxWidth", setKeyframe(boxWidthProp as AnimatedProp<number>, frame, v));
            else previewAnim("boxWidth", { ...boxWidthProp, value: v });
          }}
          onFocus={onEditFocus}
          onBlur={onEditBlur}
          min={0}
        />
      )}
      {isAnimated(boxHeightProp) && (
        <AnimScalarRow
          label="Box Height"
          prop={boxHeightProp as AnimatedProp<number>}
          value={boxHeightVal}
          frame={frame}
          onToggle={() => toggleKf("boxHeight", boxHeightProp)}
          onCommit={(v) => {
            if (boxHeightProp.keyframes.length > 0) writeAnim("boxHeight", setKeyframe(boxHeightProp as AnimatedProp<number>, frame, v), "Edit box height");
            else writeAnim("boxHeight", { ...boxHeightProp, value: v }, "Edit box height");
          }}
          onLiveChange={(v) => {
            if (boxHeightProp.keyframes.length > 0) previewAnim("boxHeight", setKeyframe(boxHeightProp as AnimatedProp<number>, frame, v));
            else previewAnim("boxHeight", { ...boxHeightProp, value: v });
          }}
          onFocus={onEditFocus}
          onBlur={onEditBlur}
          min={0}
        />
      )}
      {boxWidthVal > 0 && (
        <Row label="Box Edit">
          <button
            onClick={() => setBoxGizmoEnabled(!boxGizmoEnabled)}
            title="ビューポートのギズモでボックスをリサイズ（OFF=通常のスケール）"
            style={{ ...btnStyle, fontSize: 10, color: boxGizmoEnabled ? "#7c5" : "#bbb" }}
          >
            {boxGizmoEnabled ? "Box ⤡" : "Scale"}
          </button>
        </Row>
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
          expressed={isPropExpressed(colorProp)}
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
        <optgroup label="Bundled">
          {BUNDLED_FONTS.map((f) => (
            <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>{f.label}</option>
          ))}
        </optgroup>
        <optgroup label="Web safe">
          {WEB_SAFE_FONTS.map((f) => (
            <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>{f.label}</option>
          ))}
        </optgroup>
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
      style={{ ...textAreaStyle, flex: 1, ...(isPropExpressed(textProp) ? { color: EXPRESSED_VALUE_COLOR } : {}) }}
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
  label, prop, value, onToggle, onCommit, onLiveChange, min, max, step, speed,
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
  speed?: number;
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
        speed={speed}
        style={numInputStyleFor(prop)}
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
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4, flexWrap: "wrap" }}>
      <span style={{ color: "#666", width: 72, textAlign: "right", flexShrink: 0 }}>{label}</span>
      {children}
    </div>
  );
}

function ScaleVec3Row({
  label, vals, linked, onToggleLink, onChange, onLiveChange, hasKf, expressed, speeds,
}: {
  label: string;
  vals: Vec3;
  linked: boolean;
  onToggleLink: () => void;
  onChange: (v: Vec3, deltaParts?: Partial<Vec3>) => void;
  onLiveChange?: (v: Vec3) => void;
  hasKf: boolean;
  expressed?: boolean;
  speeds?: { x: number; y: number; z: number };
}) {
  const inputStyle = expressed ? { ...numInputStyle, color: EXPRESSED_VALUE_COLOR } : numInputStyle;
  const commit = (axis: "x" | "y" | "z", newVal: number, delta?: number) => {
    if (!Number.isFinite(newVal)) return;
    const v = applyLinkedScaleValue(vals, axis, newVal, linked);
    const deltaParts = delta !== undefined ? ({ [axis]: delta } as Partial<Vec3>) : undefined;
    onChange(v, deltaParts);
  };

  const live = (axis: "x" | "y" | "z", newVal: number) => {
    if (!Number.isFinite(newVal) || !onLiveChange) return;
    onLiveChange(applyLinkedScaleValue(vals, axis, newVal, linked));
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4, flexWrap: "wrap" }}>
      <span style={{ color: "#666", width: 72, textAlign: "right", flexShrink: 0 }}>{label}</span>
      <button
        type="button"
        title={linked ? "Constrain proportions (XY)" : "Edit X/Y independently"}
        onClick={onToggleLink}
        style={{
          ...btnStyle,
          fontSize: 10,
          padding: "1px 4px",
          color: linked ? "#7c5" : "#888",
          opacity: linked ? 1 : 0.55,
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        {linked ? "⛓" : "⛓"}
      </button>
      <span style={{ color: hasKf ? "#f0c040" : "#555", fontSize: 9 }}>⬦</span>
      {(["x", "y", "z"] as const).map((ax) => (
        <label key={ax} style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <span style={{ color: "#555", fontSize: 10 }}>{ax.toUpperCase()}</span>
          <ScrubNumber
            value={vals[ax]}
            onCommit={(v, d) => commit(ax, v, d)}
            onLiveChange={(v) => live(ax, v)}
            speed={speeds?.[ax] ?? 1}
            style={inputStyle}
          />
        </label>
      ))}
    </div>
  );
}

function Vec3Row({
  label, vals, onChange, onLiveChange, hasKf, expressed, speeds,
}: {
  label: string;
  vals: Vec3;
  onChange: (v: Vec3, deltaParts?: Partial<Vec3>) => void;
  onLiveChange?: (v: Vec3) => void;
  hasKf: boolean;
  expressed?: boolean;
  speeds?: { x: number; y: number; z: number };
}) {
  const inputStyle = expressed ? { ...numInputStyle, color: EXPRESSED_VALUE_COLOR } : numInputStyle;
  const commit = (axis: "x" | "y" | "z", newVal: number, delta?: number) => {
    if (!Number.isFinite(newVal)) return;
    const v: Vec3 = { ...vals, [axis]: newVal };
    const deltaParts = delta !== undefined ? ({ [axis]: delta } as Partial<Vec3>) : undefined;
    onChange(v, deltaParts);
  };

  const live = (axis: "x" | "y" | "z", newVal: number) => {
    if (!Number.isFinite(newVal) || !onLiveChange) return;
    onLiveChange({ ...vals, [axis]: newVal });
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4, flexWrap: "wrap" }}>
      <span style={{ color: "#666", width: 72, textAlign: "right", flexShrink: 0 }}>{label}</span>
      <span style={{ color: hasKf ? "#f0c040" : "#555", fontSize: 9 }}>⬦</span>
      {(["x", "y", "z"] as const).map((ax) => (
        <label key={ax} style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <span style={{ color: "#555", fontSize: 10 }}>{ax.toUpperCase()}</span>
          <ScrubNumber
            value={vals[ax]}
            onCommit={(v, d) => commit(ax, v, d)}
            onLiveChange={(v) => live(ax, v)}
            speed={speeds?.[ax] ?? 1}
            style={inputStyle}
          />
        </label>
      ))}
    </div>
  );
}

const numInputStyle: React.CSSProperties = {
  background: "#2a2a2a",
  border: "1px solid #444",
  color: "#ddd",
  borderRadius: 3,
  padding: "2px 4px",
  fontSize: 11,
  fontVariantNumeric: "tabular-nums",
};

function numInputStyleFor(prop: AnimatedProp<unknown>): React.CSSProperties {
  return isPropExpressed(prop) ? { ...numInputStyle, color: EXPRESSED_VALUE_COLOR } : numInputStyle;
}

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

function LayerNameHeader({ objId, name }: { objId: string; name: string }) {
  const renameObject = useEditorStore((s) => s.renameObject);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [objId, name]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) renameObject(objId, trimmed);
    else setDraft(name);
  };

  return (
    <input
      value={draft}
      title="レイヤー名"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = "transparent";
        e.currentTarget.style.background = "transparent";
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.currentTarget.blur(); }
        if (e.key === "Escape") { setDraft(name); e.currentTarget.blur(); }
      }}
      style={{
        flex: 1,
        minWidth: 80,
        background: "transparent",
        border: "1px solid transparent",
        borderRadius: 3,
        color: "#eee",
        fontWeight: "bold",
        fontSize: 13,
        padding: "2px 4px",
        userSelect: "text",
      }}
      onFocus={(e) => { e.currentTarget.style.borderColor = "#4a8acf"; e.currentTarget.style.background = "#2a2a2a"; }}
    />
  );
}
