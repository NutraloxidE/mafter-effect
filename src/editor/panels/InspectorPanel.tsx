import { useEffect, useRef, useState, type ReactNode } from "react";
import { sampleAny, sampleScalar, sampleVec3 } from "../../runtime/interpolate";
import type { AnimatedProp, BlendMode, BooleanMergeInput, BooleanOp, Component, Easing, EffectInstance, ExpressionPresetInstance, ParamDescriptor, Project, RGBA, SceneObject, ShapeVertex, ThreeDMode, TrackMatteMode, Transform, Vec3 } from "../../core/schema";
import { BLEND_MODES, TRACK_MATTE_MODES } from "../../core/schema";
import { formatMissingBlendModeLabel } from "../../core/blendMode";
import { isTrackMatteIneligible, resolveTrackMattePairs } from "../../core/trackMatte";
import {
  currentTimelineComp,
  setKeyframe,
  useEditorStore,
} from "../store";
import { isLayerLocked } from "../layerLock";
import { EXPRESSED_VALUE_COLOR, isPropExpressed, staticProp, vec3 } from "../../core/props";
import { newVertexId } from "../../core/ids";
import { pulseCycleT, pulseModulation } from "../../runtime/pulseScaleWave";
import { ColorSwatch, isRgba } from "../ColorSwatch";
import { BUNDLED_FONTS, WEB_SAFE_FONTS, isKnownFont, is3DCapableFont } from "../fontList";
import { ScrubNumber } from "../ScrubNumber";
import { TimecodeScrub } from "../TimecodeScrub";
import { applyLinkedScaleDelta, applyLinkedScaleValue } from "../linkedScale";
import { formatBarBeat } from "../beatTimecode";
import { globalPluginRegistry } from "../../runtime/pluginRegistry";
import { geom3dWebglComponentIndex, resolveGeom3DCanvasHosts, toGeom3DLayerInfo } from "../../runtime/geom3d/geom3dCanvasGroup";
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
const TRACK_MATTE_LABELS: Record<TrackMatteMode, string> = {
  alpha: "Alpha",
  alphaInverted: "Alpha Inverted",
  luma: "Luma",
  lumaInverted: "Luma Inverted",
};

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
  const setTrackMatteMode = useEditorStore((s) => s.setTrackMatteMode);
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

  const layerLocked = isLayerLocked(obj);

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
      {layerLocked && (
        <div style={{ padding: "6px 12px", fontSize: 11, color: "#c9a227", background: "#2a2418", borderBottom: "1px solid #3a3020" }}>
          ロック中 — タイムラインの目アイコンを Shift+クリックで解除
        </div>
      )}
      <div style={{ opacity: layerLocked ? 0.55 : 1, pointerEvents: layerLocked ? "none" : "auto" }}>

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
        <Row label="Track Matte">
          {(() => {
            const ineligible = isTrackMatteIneligible(obj);
            const pairs = resolveTrackMattePairs(comp?.objects ?? []);
            const hasAbove = (comp?.objects ?? []).some(
              (o) =>
                o.id !== obj.id &&
                !isTrackMatteIneligible(o) &&
                (o.zOrder > obj.zOrder || (o.zOrder === obj.zOrder && o.id > obj.id)),
            );
            const isMatteSource = pairs.some((p) => p.matteId === obj.id);
            const disabled = layerLocked || ineligible || !hasAbove;
            return (
              <select
                value={obj.trackMatteMode ?? ""}
                disabled={disabled}
                title={
                  isMatteSource
                    ? "このレイヤーは直下のトラックマット源です"
                    : !hasAbove
                      ? "直上レイヤーがありません"
                      : ineligible
                        ? "このレイヤータイプではトラックマットを使えません"
                        : "直上レイヤーをマット源に使う（§5.4f）"
                }
                onChange={(e) => {
                  const v = e.target.value;
                  setTrackMatteMode(obj.id, v === "" ? null : (v as TrackMatteMode));
                }}
                style={selectStyle}
              >
                <option value="">なし</option>
                {TRACK_MATTE_MODES.map((m) => (
                  <option key={m} value={m}>
                    {TRACK_MATTE_LABELS[m]}
                  </option>
                ))}
              </select>
            );
          })()}
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
          <Geom3DShareCanvasRows obj={obj} objects={comp?.objects ?? []} updateObject={updateObject} />
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
            comp.type !== "shape" &&
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
              ) : comp.type === "shape" ? (
                <ShapeComponentFields
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
  // §5.5f 3D Extrude 用フォント自動アセット化・アップロード。
  const project = useEditorStore((s) => s.project);
  const ensureBundledFontAsset = useEditorStore((s) => s.ensureBundledFontAsset);
  const importFontAsset = useEditorStore((s) => s.importFontAsset);
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
          project={project}
          importFontAsset={importFontAsset}
          onChange={(v) => {
            writeStatic("font", v, "Edit font");
            if (props["geomEnabled"] === true) void ensureBundledFontAsset(v, weight);
          }}
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
          onChange={(e) => {
            const next = Number(e.target.value);
            writeStatic("weight", next, "Edit weight");
            // 3D 押し出しは weight ごとに別アウトラインを使う。取り込み忘れると 2D だけ太って
            // 3D は前の weight のままになる。
            if (props["geomEnabled"] === true) void ensureBundledFontAsset(font, next);
          }}
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
      <Geom3DFields
        props={props}
        frame={frame}
        font={font}
        weight={weight}
        project={project}
        ensureBundledFontAsset={ensureBundledFontAsset}
        writeStatic={writeStatic}
        writeAnim={writeAnim}
        previewAnim={previewAnim}
        toggleKf={toggleKf}
        onFocus={onEditFocus}
        onBlur={onEditBlur}
      />
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

/**
 * §5.5f 3D 押し出し（P1: depth/bevel/shading のみ・非破壊トグル）。
 * text の Content フォールドアウト内に直接ぶら下げる（既存 "3D" フォールドアウト＝§5.4b per-layer
 * 3D レイヤースイッチとは別概念のため独立フォールドアウトは作らず、混同を避ける）。
 * twist/bend/taper・グラデーション面塗りは未実装（doc/cloudplan/3d-text-extrusion-plan.md 次フェーズ）。
 */
function Geom3DFields({
  props, frame, font, weight, project, ensureBundledFontAsset, writeStatic, writeAnim, previewAnim, toggleKf, onFocus, onBlur,
}: {
  props: Component["props"];
  frame: number;
  font: string;
  weight: number;
  project: Project | null;
  ensureBundledFontAsset: (font: string, weight: number) => Promise<void>;
  writeStatic: (key: string, value: unknown, label: string) => void;
  writeAnim: (key: string, next: AnimatedProp<number>, label: string) => void;
  previewAnim: (key: string, next: AnimatedProp<number>) => void;
  toggleKf: (key: string, prop: AnimatedProp<unknown>) => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const enabled = props["geomEnabled"] === true;
  const canExtrude = is3DCapableFont(font, project);
  const depthProp = props["geomDepth"];
  const bevelSizeProp = props["geomBevelSize"];
  const ambientProp = props["geomAmbient"];
  const bevelSegments = typeof props["geomBevelSegments"] === "number" ? props["geomBevelSegments"] : 2;
  const bevelStyle = props["geomBevelStyle"] === "round" || props["geomBevelStyle"] === "concave" ? props["geomBevelStyle"] : "angular";
  const curveQuality = props["geomCurveQuality"] === "low" || props["geomCurveQuality"] === "high" ? props["geomCurveQuality"] : "medium";
  const shading = props["geomShading"] === "none" ? "none" : "lambert";

  const numRow = (key: string, label: string, prop: unknown, min?: number, max?: number): ReactNode => {
    if (!isAnimated(prop)) return null;
    const value = typeof sampleAny(prop, frame) === "number" ? (sampleAny(prop, frame) as number) : 0;
    return (
      <AnimScalarRow
        label={label}
        prop={prop as AnimatedProp<number>}
        value={value}
        frame={frame}
        onToggle={() => toggleKf(key, prop)}
        onCommit={(v) => {
          if (prop.keyframes.length > 0) writeAnim(key, setKeyframe(prop as AnimatedProp<number>, frame, v), `Edit ${key}`);
          else writeAnim(key, { ...(prop as AnimatedProp<number>), value: v }, `Edit ${key}`);
        }}
        onLiveChange={(v) => {
          if (prop.keyframes.length > 0) previewAnim(key, setKeyframe(prop as AnimatedProp<number>, frame, v));
          else previewAnim(key, { ...(prop as AnimatedProp<number>), value: v });
        }}
        onFocus={onFocus}
        onBlur={onBlur}
        min={min}
        max={max}
      />
    );
  };

  return (
    <>
      <Row label="3D Extrude">
        <button
          type="button"
          onClick={() => {
            const next = !enabled;
            writeStatic("geomEnabled", next, "Toggle 3D extrude");
            if (next) void ensureBundledFontAsset(font, weight);
          }}
          style={{ ...btnStyle, background: enabled ? "#2f5a44" : "#2a2a2a", color: enabled ? "#9fe8c4" : "#ccc" }}
          title="押し出し・ベベルで立体化する（テキストは編集可能なまま・非破壊。フォントが asset として取り込まれていない場合は 2D のまま — §26.4.1 と同じ制約）"
        >
          {enabled ? "ON" : "OFF"}
        </button>
      </Row>
      {enabled && !canExtrude && (
        <Row label="">
          <span style={{ color: "#e0a94a", fontSize: 11 }}>
            このフォントは 3D 化できません（Bundled フォントを選ぶかアップロードしてください）
          </span>
        </Row>
      )}
      {enabled && (
        <>
          {numRow("geomDepth", "Depth", depthProp, 0)}
          {numRow("geomBevelSize", "Bevel Size", bevelSizeProp, 0)}
          <Row label="Bevel Style">
            <select
              value={bevelStyle}
              onChange={(e) => writeStatic("geomBevelStyle", e.target.value, "Edit bevel style")}
              style={selectStyle}
            >
              <option value="angular">Angular</option>
              <option value="round">Round</option>
              <option value="concave">Concave</option>
            </select>
          </Row>
          {/* angular は 1 面で厳密＝分割数を持たないので出さない（§5.5f）。 */}
          {bevelStyle !== "angular" && (
            <Row label="Bevel Segs">
              <ScrubNumber
                value={bevelSegments}
                onCommit={(v) => writeStatic("geomBevelSegments", Math.round(Math.min(8, Math.max(1, v))), "Edit bevel segments")}
                min={1}
                max={8}
                step={1}
                style={numInputStyle}
              />
            </Row>
          )}
          <Row label="Curve Quality">
            <select
              value={curveQuality}
              onChange={(e) => writeStatic("geomCurveQuality", e.target.value, "Edit curve quality")}
              style={selectStyle}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </Row>
          <Row label="Shading">
            <select
              value={shading}
              onChange={(e) => writeStatic("geomShading", e.target.value, "Edit shading")}
              style={selectStyle}
            >
              <option value="lambert">Lambert</option>
              <option value="none">None</option>
            </select>
          </Row>
          {shading === "lambert" && numRow("geomAmbient", "Ambient", ambientProp, 0, 1)}
          {shading === "lambert" && (
            <Row label="Light Dir">
              {(["x", "y", "z"] as const).map((axis) => {
                const dir = isVec3Value(props["geomLightDir"]) ? props["geomLightDir"] : { x: -0.5, y: -0.7, z: -0.5 };
                return (
                  <ScrubNumber
                    key={axis}
                    value={dir[axis]}
                    onCommit={(v) => writeStatic("geomLightDir", { ...dir, [axis]: v }, `Edit light dir ${axis}`)}
                    step={0.1}
                    style={numInputStyle}
                  />
                );
              })}
            </Row>
          )}
        </>
      )}
    </>
  );
}

/**
 * §5.5f-1 WebGL canvas 共有トグル ＋ 解決された host 表示。
 *
 * text 固有の設定ではなく「このレイヤーが WebGL 描画か」に紐づくため、Content(text) フォールドではなく
 * **3D フォールド**に置き、WebGL レイヤーのときだけ出す。将来 shape 等の押し出しが増えても
 * `geom3dWebglComponentIndex` を広げるだけでここに出る（UI 側の分岐は増やさない）。
 * host 判定は DomRenderer と同じ純関数 — 表示と実際の描き先がズレないための唯一の担保。
 */
function Geom3DShareCanvasRows({
  obj,
  objects,
  updateObject,
}: {
  obj: SceneObject;
  objects: readonly SceneObject[];
  updateObject: (id: string, patch: Partial<SceneObject>, label?: string) => void;
}) {
  const webglIdx = geom3dWebglComponentIndex(obj.components);
  if (webglIdx < 0) return null;

  const shareCanvas = obj.components[webglIdx]?.props["geomShareCanvas"] === true;
  const hostId = resolveGeom3DCanvasHosts(objects.map(toGeom3DLayerInfo)).get(obj.id);
  const hostIsSelf = hostId === undefined || hostId === obj.id;
  const hostName = objects.find((o) => o.id === hostId)?.name;

  const toggle = () => {
    updateObject(
      obj.id,
      {
        components: obj.components.map((c, i) =>
          i === webglIdx ? { ...c, props: { ...c.props, geomShareCanvas: !shareCanvas } } : c,
        ),
      },
      "Toggle share WebGL canvas",
    );
  };

  return (
    <>
      <Row label="Share Canvas">
        <button
          type="button"
          onClick={toggle}
          style={{ ...btnStyle, background: shareCanvas ? "#2f5a44" : "#2a2a2a", color: shareCanvas ? "#9fe8c4" : "#ccc" }}
          title="§5.5f-1 上の WebGL レイヤー（3D Extrude text 等）と WebGL canvas を共有する。3D 同士が正しく相互貫入し、GL context も節約できる。Null / 音声のみのレイヤーは透過してスキップし、間に 2D の描画レイヤーがあるとチェーンは切れる（＝自分が最上位）。共有すると opacity / 描画モード / エフェクトは host レイヤー側にまとめて掛かる"
        >
          {shareCanvas ? "ON" : "OFF"}
        </button>
      </Row>
      {shareCanvas && (
        <Row label="Canvas Host">
          <span style={{ color: hostIsSelf ? "#9fe8c4" : "#8ab4f8", fontSize: 11 }}>
            {hostIsSelf ? "自分（最上位）" : (hostName ?? "自分（最上位）")}
          </span>
        </Row>
      )}
    </>
  );
}

function isVec3Value(v: unknown): v is Vec3 {
  return typeof v === "object" && v !== null && "x" in v && "y" in v && "z" in v;
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

const SHAPE_CORNER_RADIUS_KEYS = [
  ["radiusTL", "Radius TL"],
  ["radiusTR", "Radius TR"],
  ["radiusBR", "Radius BR"],
  ["radiusBL", "Radius BL"],
] as const;

/**
 * §5.5 / §5.5c shape — kind(rect/ellipse/path) プルダウンを単一入口に、fill・4隅 radius・size・
 * （path 時）頂点リストを Shape フォールドアウト内に集約する（doc/cloudplan/shape-editing-plan.md §3.3）。
 */
function ShapeComponentFields({
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
  // §26.3.3 と同じ規約 — hooks は早期 return より前に呼ぶ。
  const project = useEditorStore((s) => s.project);
  const currentCompId = useEditorStore((s) => s.currentCompId);
  const bakeShapeMerge = useEditorStore((s) => s.bakeShapeMerge);
  const [bakeMessage, setBakeMessage] = useState<string | null>(null);
  const comp = obj.components[compIdx];
  if (!comp || comp.type !== "shape") return null;
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

  const kind = typeof props["kind"] === "string" ? (props["kind"] as string) : "rect";

  const setKind = (nextKind: string) => {
    const nextProps: Component["props"] = { ...props, kind: nextKind };
    // path へ切替時、頂点が未設定なら既定の三角形を用意する（0頂点は何も描画されないため）。
    if (nextKind === "path" && !Array.isArray(props["vertices"])) {
      const sizeProp = props["size"];
      const size = isAnimated(sizeProp) ? (sampleAny(sizeProp, frame) as Vec3) : vec3(200, 200, 0);
      const w = size.x || 200;
      const h = size.y || 200;
      const nextVertices: ShapeVertex[] = [
        { id: newVertexId(), pos: staticProp(vec3(w / 2, 0, 0)) },
        { id: newVertexId(), pos: staticProp(vec3(w, h, 0)) },
        { id: newVertexId(), pos: staticProp(vec3(0, h, 0)) },
      ];
      nextProps.vertices = nextVertices;
    }
    if (nextKind === "merge" && !Array.isArray(props["mergeInputs"])) {
      nextProps.mergeInputs = [];
    }
    writeComponents(nextProps, "Edit Shape kind");
  };

  // §5.5d shape kind="merge": Illustrator Pathfinder 相当。入力は同一 comp 内の他レイヤー参照
  // （objectId）— 自分自身・他の merge shape（循環防止）は候補から除外する。
  const timelineComp = currentCompId ? currentTimelineComp(project, currentCompId) : null;
  const mergeInputs = Array.isArray(props["mergeInputs"]) ? (props["mergeInputs"] as BooleanMergeInput[]) : undefined;
  const writeMergeInputs = (next: BooleanMergeInput[], label: string) => {
    writeComponents({ ...props, mergeInputs: next }, label);
  };
  const mergeCandidateObjects = (timelineComp?.objects ?? []).filter(
    (o) => o.id !== obj.id && o.components.some((c) => c.type === "shape" && c.props["kind"] !== "merge"),
  );

  const fillProp = props["fill"];
  const fillVal = isAnimated(fillProp) && isRgba(sampleAny(fillProp, frame))
    ? (sampleAny(fillProp, frame) as RGBA) : { r: 0.5, g: 0.7, b: 0.9, a: 1 };

  const sizeProp = props["size"];
  const sizeVal = isAnimated(sizeProp) ? (sampleAny(sizeProp, frame) as Vec3) : vec3(200, 200, 0);
  const setSizeAxis = (axis: "x" | "y", v: number) => {
    if (!isAnimated(sizeProp)) return;
    const next = { ...sizeVal, [axis]: v };
    if (sizeProp.keyframes.length > 0) writeAnim("size", setKeyframe(sizeProp as AnimatedProp<Vec3>, frame, next), "Edit Shape size");
    else writeAnim("size", { ...sizeProp, value: next }, "Edit Shape size");
  };

  const vertices = Array.isArray(props["vertices"]) ? (props["vertices"] as ShapeVertex[]) : undefined;
  const writeVertices = (next: ShapeVertex[], label: string) => {
    writeComponents({ ...props, vertices: next }, label);
  };

  // §5.5e shape kind="path" 複数リング（merge Bake 由来。穴・分離図形）。存在すれば単一 vertices より優先。
  const rings = Array.isArray(props["rings"]) && (props["rings"] as ShapeVertex[][]).length > 0
    ? (props["rings"] as ShapeVertex[][])
    : undefined;
  const writeRings = (next: ShapeVertex[][], label: string) => {
    writeComponents({ ...props, rings: next }, label);
  };

  return (
    <div>
      <Row label="Kind">
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={selectStyle}>
          <option value="rect">Rectangle</option>
          <option value="ellipse">Ellipse</option>
          <option value="path">Path（頂点）</option>
          <option value="merge">Merge（他レイヤーの Boolean 合成）</option>
        </select>
      </Row>

      {isAnimated(fillProp) && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 4, marginBottom: 4 }}>
          <Stopwatch active={fillProp.keyframes.length > 0} onClick={() => toggleKf("fill", fillProp)} />
          <div style={{ flex: 1 }}>
            <ColorSwatch
              label="Fill"
              value={fillVal}
              expressed={isPropExpressed(fillProp)}
              onCommit={(v) => {
                if (fillProp.keyframes.length > 0) writeAnim("fill", setKeyframe(fillProp as AnimatedProp<RGBA>, frame, v), "Edit Shape fill");
                else writeAnim("fill", { ...fillProp, value: v }, "Edit Shape fill");
              }}
              onLiveChange={(v) => {
                if (fillProp.keyframes.length > 0) previewAnim("fill", setKeyframe(fillProp as AnimatedProp<RGBA>, frame, v));
                else previewAnim("fill", { ...fillProp, value: v });
              }}
              onFocus={onEditFocus}
              onBlur={onEditBlur}
            />
          </div>
        </div>
      )}

      {kind === "rect" && SHAPE_CORNER_RADIUS_KEYS.map(([key, label]) => {
        const prop = props[key];
        if (!isAnimated(prop)) return null;
        const val = sampleAny(prop, frame) as number;
        return (
          <AnimScalarRow
            key={key}
            label={label}
            prop={prop as AnimatedProp<number>}
            value={val}
            frame={frame}
            onToggle={() => toggleKf(key, prop)}
            onCommit={(v) => {
              onEditBlur();
              if (prop.keyframes.length > 0) writeAnim(key, setKeyframe(prop as AnimatedProp<number>, frame, v), `Edit ${label}`);
              else writeAnim(key, { ...prop, value: v }, `Edit ${label}`);
            }}
            onLiveChange={(v) => {
              onEditFocus();
              previewAnim(key, prop.keyframes.length > 0 ? setKeyframe(prop as AnimatedProp<number>, frame, v) : { ...prop, value: v });
            }}
            min={0}
          />
        );
      })}

      {kind !== "path" && kind !== "merge" && isAnimated(sizeProp) && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
          <Stopwatch active={sizeProp.keyframes.length > 0} onClick={() => toggleKf("size", sizeProp)} />
          <span style={{ color: "#666", width: 34 }}>Size</span>
          <label style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <span style={{ color: "#555", fontSize: 10 }}>W</span>
            <ScrubNumber value={sizeVal.x} onCommit={(v) => setSizeAxis("x", v)} style={numInputStyle} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <span style={{ color: "#555", fontSize: 10 }}>H</span>
            <ScrubNumber value={sizeVal.y} onCommit={(v) => setSizeAxis("y", v)} style={numInputStyle} />
          </label>
        </div>
      )}

      {kind === "path" && rings && (
        <div style={{ marginTop: 6 }}>
          <div style={{ color: "#888", fontSize: 10, marginBottom: 4, lineHeight: 1.4 }}>
            Rings（{rings.length}、Bake 由来の複数リング。穴・分離図形を含む場合があります）
          </div>
          {rings.map((ring, ringIdx) => (
            <div key={ringIdx} style={{ marginBottom: 8, padding: 6, background: "#202020", border: "1px solid #333", borderRadius: 4 }}>
              <div style={{ color: "#aaa", fontSize: 10, marginBottom: 4 }}>Ring #{ringIdx + 1}（{ring.length} 頂点）</div>
              {ring.map((v, vIdx) => (
                <ShapeVertexRow
                  key={v.id}
                  vertex={v}
                  index={vIdx}
                  frame={frame}
                  canMoveUp={vIdx > 0}
                  canMoveDown={vIdx < ring.length - 1}
                  onChange={(next) => writeRings(rings.map((r, i) => (i === ringIdx ? r.map((vv, j) => (j === vIdx ? next : vv)) : r)), `Edit ring ${ringIdx + 1} vertex ${vIdx + 1}`)}
                  onRemove={() => writeRings(rings.map((r, i) => (i === ringIdx ? r.filter((_, j) => j !== vIdx) : r)).filter((r) => r.length > 0), `Remove ring ${ringIdx + 1} vertex ${vIdx + 1}`)}
                  onMoveUp={() => {
                    const next = rings.map((r) => [...r]);
                    const ringArr = next[ringIdx]!;
                    const tmp = ringArr[vIdx - 1]!;
                    ringArr[vIdx - 1] = ringArr[vIdx]!;
                    ringArr[vIdx] = tmp;
                    writeRings(next, "Reorder ring vertices");
                  }}
                  onMoveDown={() => {
                    const next = rings.map((r) => [...r]);
                    const ringArr = next[ringIdx]!;
                    const tmp = ringArr[vIdx + 1]!;
                    ringArr[vIdx + 1] = ringArr[vIdx]!;
                    ringArr[vIdx] = tmp;
                    writeRings(next, "Reorder ring vertices");
                  }}
                />
              ))}
              <button
                type="button"
                onClick={() => writeRings(rings.filter((_, i) => i !== ringIdx), `Remove ring ${ringIdx + 1}`)}
                style={{ ...btnStyle, width: "100%", fontSize: 9, marginTop: 2, color: "#f66" }}
              >
                × この Ring を削除
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => {
              const { rings: _r, ...rest } = props;
              writeComponents({ ...rest, vertices: [] }, "Discard rings (edit as single path)");
            }}
            style={{ ...btnStyle, width: "100%", fontSize: 10 }}
          >
            Rings を破棄して単一パスに戻す
          </button>
        </div>
      )}

      {kind === "path" && !rings && (
        <div style={{ marginTop: 6 }}>
          <div style={{ color: "#888", fontSize: 10, marginBottom: 4 }}>
            Vertices（{vertices?.length ?? 0}）
          </div>
          {(vertices ?? []).map((v, idx) => (
            <ShapeVertexRow
              key={v.id}
              vertex={v}
              index={idx}
              frame={frame}
              canMoveUp={idx > 0}
              canMoveDown={idx < (vertices?.length ?? 0) - 1}
              onChange={(next) => writeVertices((vertices ?? []).map((vv, i) => (i === idx ? next : vv)), `Edit vertex ${idx + 1}`)}
              onRemove={() => writeVertices((vertices ?? []).filter((_, i) => i !== idx), `Remove vertex ${idx + 1}`)}
              onMoveUp={() => {
                const next = [...(vertices ?? [])];
                const tmp = next[idx - 1]!;
                next[idx - 1] = next[idx]!;
                next[idx] = tmp;
                writeVertices(next, "Reorder vertices");
              }}
              onMoveDown={() => {
                const next = [...(vertices ?? [])];
                const tmp = next[idx + 1]!;
                next[idx + 1] = next[idx]!;
                next[idx] = tmp;
                writeVertices(next, "Reorder vertices");
              }}
            />
          ))}
          <button
            type="button"
            onClick={() => {
              const list = vertices ?? [];
              const last = list[list.length - 1];
              const base = last ? (sampleAny(last.pos, frame) as Vec3) : vec3(0, 0, 0);
              writeVertices([...list, { id: newVertexId(), pos: staticProp(vec3(base.x + 40, base.y + 40, 0)) }], "Add vertex");
            }}
            style={{ ...btnStyle, width: "100%", fontSize: 10, marginTop: 4 }}
          >
            + 頂点を追加
          </button>
          {(vertices?.length ?? 0) < 2 && (
            <div style={{ color: "#f88", fontSize: 10, marginTop: 4 }}>頂点が2つ未満だと描画されません</div>
          )}
        </div>
      )}

      {kind === "merge" && (
        <div style={{ marginTop: 6 }}>
          <div style={{ color: "#888", fontSize: 10, marginBottom: 4, lineHeight: 1.4 }}>
            他レイヤーの Boolean 合成（Unite/Subtract/Intersect/Exclude、Illustrator の Pathfinder 相当）。
            参照したレイヤーは自身の通常描画から自動的に隠れます（合成結果としてのみ表示）。
          </div>
          {(mergeInputs ?? []).map((mi, idx) => (
            <ShapeMergeInputRow
              key={mi.id}
              input={mi}
              index={idx}
              isBase={idx === 0}
              canMoveUp={idx > 0}
              canMoveDown={idx < (mergeInputs?.length ?? 0) - 1}
              candidates={mergeCandidateObjects}
              onChangeObjectId={(objectId) => writeMergeInputs((mergeInputs ?? []).map((m, i) => (i === idx ? { ...m, objectId } : m)), `Edit merge input ${idx + 1}`)}
              onChangeOp={(op) => writeMergeInputs((mergeInputs ?? []).map((m, i) => (i === idx ? { ...m, op } : m)), `Edit merge input ${idx + 1} op`)}
              onRemove={() => writeMergeInputs((mergeInputs ?? []).filter((_, i) => i !== idx), `Remove merge input ${idx + 1}`)}
              onMoveUp={() => {
                const next = [...(mergeInputs ?? [])];
                const tmp = next[idx - 1]!;
                next[idx - 1] = next[idx]!;
                next[idx] = tmp;
                writeMergeInputs(next, "Reorder merge inputs");
              }}
              onMoveDown={() => {
                const next = [...(mergeInputs ?? [])];
                const tmp = next[idx + 1]!;
                next[idx + 1] = next[idx]!;
                next[idx] = tmp;
                writeMergeInputs(next, "Reorder merge inputs");
              }}
            />
          ))}
          <button
            type="button"
            disabled={mergeCandidateObjects.length === 0}
            onClick={() => {
              const used = new Set((mergeInputs ?? []).map((m) => m.objectId));
              const next = mergeCandidateObjects.find((o) => !used.has(o.id)) ?? mergeCandidateObjects[0];
              if (!next) return;
              writeMergeInputs([...(mergeInputs ?? []), { id: newVertexId(), objectId: next.id, op: "subtract" }], "Add merge input");
            }}
            style={{ ...btnStyle, width: "100%", fontSize: 10, marginTop: 4 }}
          >
            + レイヤーを追加
          </button>
          {mergeCandidateObjects.length === 0 && (
            <div style={{ color: "#f88", fontSize: 10, marginTop: 4 }}>
              参照できる shape レイヤー（rect/ellipse/path、merge 以外）が他にありません。
            </div>
          )}
          {(mergeInputs?.length ?? 0) < 2 && (mergeInputs?.length ?? 0) > 0 && (
            <div style={{ color: "#f88", fontSize: 10, marginTop: 4 }}>入力が1件だけだとその形状がそのまま表示されます</div>
          )}
          <button
            type="button"
            disabled={(mergeInputs?.length ?? 0) === 0}
            onClick={() => {
              const result = bakeShapeMerge(obj.id);
              setBakeMessage(result?.fallbackReason ?? null);
            }}
            style={{ ...btnStyle, width: "100%", fontSize: 10, marginTop: 8, borderColor: "#5a8fd0", color: "#8cf" }}
            title="現在の合成結果をその場で固定し、他レイヤー参照を外した独立パスに変換する（Illustrator の Expand 相当）"
          >
            Bake（合成結果を独立パスに固定）
          </button>
          {bakeMessage && (
            <div style={{ color: "#f0c060", fontSize: 10, marginTop: 4, lineHeight: 1.4 }}>{bakeMessage}</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * §5.5d shape kind="merge" — 入力1件の Inspector 行。他レイヤー参照（objectId）のプルダウン・
 * op プルダウン（ベース入力は非表示）・並べ替え・削除を持つ（頂点はレイヤー側 Inspector で編集する）。
 */
function ShapeMergeInputRow({
  input,
  index,
  isBase,
  canMoveUp,
  canMoveDown,
  candidates,
  onChangeObjectId,
  onChangeOp,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  input: BooleanMergeInput;
  index: number;
  isBase: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  candidates: SceneObject[];
  onChangeObjectId: (objectId: string) => void;
  onChangeOp: (op: BooleanOp) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const resolvedTarget = candidates.some((c) => c.id === input.objectId);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4, padding: 6, background: "#202020", border: "1px solid #333", borderRadius: 4 }}>
      <span style={{ color: "#777", fontSize: 10, width: 18 }}>#{index + 1}</span>
      <select
        value={input.objectId}
        onChange={(e) => onChangeObjectId(e.target.value)}
        style={{ ...selectStyle, fontSize: 10, padding: "1px 3px" }}
      >
        {!resolvedTarget && <option value={input.objectId}>（見つかりません）</option>}
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      {!isBase && (
        <select
          value={input.op}
          onChange={(e) => onChangeOp(e.target.value as BooleanOp)}
          style={{ ...selectStyle, flex: "unset", fontSize: 10, padding: "1px 3px" }}
        >
          <option value="unite">Unite</option>
          <option value="subtract">Subtract</option>
          <option value="intersect">Intersect</option>
          <option value="exclude">Exclude</option>
        </select>
      )}
      <button type="button" onClick={onMoveUp} disabled={!canMoveUp} style={{ ...btnStyle, fontSize: 9, padding: "1px 4px" }}>▲</button>
      <button type="button" onClick={onMoveDown} disabled={!canMoveDown} style={{ ...btnStyle, fontSize: 9, padding: "1px 4px" }}>▼</button>
      <button type="button" onClick={onRemove} style={{ ...btnStyle, fontSize: 9, padding: "1px 4px", color: "#f66" }}>×</button>
    </div>
  );
}

/** §5.5c shape kind="path" の頂点1件の Inspector 行 — x/y と in/out tangent（任意）を数値編集する。 */
function ShapeVertexRow({
  vertex,
  index,
  frame,
  canMoveUp,
  canMoveDown,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  vertex: ShapeVertex;
  index: number;
  frame: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (next: ShapeVertex) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const pos = sampleAny(vertex.pos, frame) as Vec3;
  const setPos = (axis: "x" | "y", v: number) => {
    const nextPos = { ...pos, [axis]: v };
    onChange({
      ...vertex,
      pos: vertex.pos.keyframes.length > 0 ? setKeyframe(vertex.pos, frame, nextPos) : { ...vertex.pos, value: nextPos },
    });
  };

  const tangentRow = (key: "inTangent" | "outTangent", label: string) => {
    const t = vertex[key];
    const val = t ? (sampleAny(t, frame) as Vec3) : null;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 22, marginTop: 2 }}>
        <span style={{ color: "#666", fontSize: 9, width: 26 }}>{label}</span>
        <input
          type="checkbox"
          checked={val !== null}
          onChange={(e) => {
            if (e.target.checked) onChange({ ...vertex, [key]: staticProp(vec3(0, 0, 0)) });
            else onChange({ ...vertex, [key]: undefined });
          }}
        />
        {val !== null && t !== undefined && (
          <>
            <ScrubNumber
              value={val.x}
              onCommit={(v) => {
                const next = { ...val, x: v };
                onChange({ ...vertex, [key]: t.keyframes.length > 0 ? setKeyframe(t, frame, next) : { ...t, value: next } });
              }}
              style={numInputStyle}
            />
            <ScrubNumber
              value={val.y}
              onCommit={(v) => {
                const next = { ...val, y: v };
                onChange({ ...vertex, [key]: t.keyframes.length > 0 ? setKeyframe(t, frame, next) : { ...t, value: next } });
              }}
              style={numInputStyle}
            />
          </>
        )}
      </div>
    );
  };

  return (
    <div style={{ marginBottom: 6, padding: "4px 6px", background: "#232323", borderRadius: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ color: "#777", fontSize: 10, width: 18 }}>#{index + 1}</span>
        <span style={{ color: "#555", fontSize: 9 }}>X</span>
        <ScrubNumber value={pos.x} onCommit={(v) => setPos("x", v)} style={numInputStyle} />
        <span style={{ color: "#555", fontSize: 9 }}>Y</span>
        <ScrubNumber value={pos.y} onCommit={(v) => setPos("y", v)} style={numInputStyle} />
        <button type="button" onClick={onMoveUp} disabled={!canMoveUp} style={{ ...btnStyle, fontSize: 9, padding: "1px 4px" }}>▲</button>
        <button type="button" onClick={onMoveDown} disabled={!canMoveDown} style={{ ...btnStyle, fontSize: 9, padding: "1px 4px" }}>▼</button>
        <button type="button" onClick={onRemove} style={{ ...btnStyle, fontSize: 9, padding: "1px 4px", color: "#f66" }}>×</button>
      </div>
      {tangentRow("inTangent", "In")}
      {tangentRow("outTangent", "Out")}
    </div>
  );
}

/** §26.3.1 Font — Bundled / Web safe / Uploaded のプルダウン + フォントファイルアップロード。 */
function FontField({
  font,
  project,
  importFontAsset,
  onChange,
  onEditFocus,
  onEditBlur,
}: {
  font: string;
  project: Project | null;
  importFontAsset: (file: File) => Promise<{ assetId: string; family: string } | null>;
  onChange: (value: string) => void;
  onEditFocus: () => void;
  onEditBlur: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadedFonts = (project?.assets ?? [])
    .filter((a) => a.kind === "font" && typeof a.meta?.family === "string")
    .map((a) => a.meta!.family as string)
    .filter((fam, i, arr) => arr.indexOf(fam) === i);
  const known = isKnownFont(font) || uploadedFonts.includes(font);

  const onUpload = async (file: File) => {
    const result = await importFontAsset(file);
    if (result) onChange(result.family);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
      <select
        value={known ? font : "__unknown__"}
        onChange={(e) => onChange(e.target.value)}
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
        {uploadedFonts.length > 0 && (
          <optgroup label="Uploaded">
            {uploadedFonts.map((fam) => (
              <option key={fam} value={fam} style={{ fontFamily: fam }}>{fam}</option>
            ))}
          </optgroup>
        )}
        {!known && <option value="__unknown__">{font}</option>}
      </select>
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        onFocus={onEditFocus}
        onBlur={onEditBlur}
        style={{ ...btnStyle, fontSize: 10 }}
      >
        ⬆ Upload font…
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".ttf,.otf,.woff,.woff2"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onUpload(f);
          e.target.value = "";
        }}
      />
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
