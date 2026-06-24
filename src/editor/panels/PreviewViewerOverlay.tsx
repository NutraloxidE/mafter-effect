import { useCallback, useMemo, useRef } from "react";
import type { Font } from "opentype.js";
import type { AnimatedProp, Frame, Project, SceneObject, TimelineComposition, Transform, Vec3 } from "../../core/schema";
import type { ResolveContext } from "../../runtime/resolve";
import { setKeyframe, type PreviewOverride } from "../store";
import { sampleAny } from "../../runtime/interpolate";
import { staticProp } from "../../core/props";
import {
  anchorCompPosition,
  applyRotationFromDrag,
  boundsAabb,
  compToObjectLocal,
  compensatePositionForAnchor,
  compWithTransformOverride,
  compWithObjectPatch,
  computeWorldTransforms,
  getLayerLocalBounds,
  mergeObjectPreviewOverride,
  movedPosition,
  oppositeControlPoint,
  parentWorldMatrix,
  patchTransformAtFrame,
  projectBoundsToComp,
  resizeBoxFromOppositeEdge,
  resolveTransformAtFrame,
  scaleFromOppositeCorner,
  screenToComp,
  type LayerBoundsContext,
  type ResolvedTransform,
  type ScaleHandle,
} from "../previewViewer";
import { localMatrix, multiply, transformPoint } from "../../runtime/mat4";
import type { PreviewViewerSettings } from "../previewViewerStorage";

export type DragMode =
  | { kind: "pan" }
  | { kind: "move" }
  | { kind: "scale"; handle: ScaleHandle }
  | { kind: "boxResize"; handle: ScaleHandle }
  | { kind: "rotate" }
  | { kind: "anchor" };

/** boxWidth>0 のテキストレイヤーなら { compIdx } を返す（= ボックスリサイズ対象）。 */
function textBoxCompIdx(obj: SceneObject | null, frame: Frame): number | null {
  if (!obj) return null;
  const idx = obj.components.findIndex((c) => c.type === "text");
  if (idx < 0) return null;
  const bw = sampleAny(obj.components[idx]!.props["boxWidth"], frame);
  return typeof bw === "number" && bw > 0 ? idx : null;
}

/** boxWidth/boxHeight プロパティを非破壊に更新（KF があれば打点、無ければ値置換）。 */
function writeBoxProp(prop: unknown, frame: Frame, value: number): AnimatedProp<number> {
  if (prop && typeof prop === "object" && "value" in prop && "keyframes" in prop) {
    const p = prop as AnimatedProp<number>;
    if (p.keyframes.length > 0) return setKeyframe(p, frame, value);
    return { ...p, value };
  }
  return staticProp(value);
}

interface PreviewViewerOverlayProps {
  comp: TimelineComposition;
  project: Project;
  frame: Frame;
  settings: PreviewViewerSettings;
  viewZoom: number;
  viewPan: { x: number; y: number };
  hostRect: { left: number; top: number };
  selectedObject: SceneObject | null;
  previewOverride: PreviewOverride | null;
  draftTransform: Transform | null;
  onDraftChange: (t: Transform | null) => void;
  onCommit: (transform: Transform, label: string) => void;
  /** §26.3.3 ボックスリサイズのライブプレビュー（previewOverride 経由）。 */
  onComponentPreview?: (patch: Partial<SceneObject>) => void;
  /** §26.3.3 ボックスリサイズの確定（updateObject + previewOverride クリア）。 */
  onComponentCommit?: (patch: Partial<SceneObject>, label: string) => void;
  resolveCtx?: ResolveContext;
  onPan: (delta: { x: number; y: number }) => void;
  textQuality?: "draft" | "precise";
  getFont?: (family: string) => Font | null;
  getImageSize?: (assetId: string) => { width: number; height: number } | null;
}

const HANDLE_SIZE = 8;
const ROTATE_OFFSET = 24;

const SCALE_HANDLES: { id: ScaleHandle; x: number; y: number; cursor: string }[] = [
  { id: "nw", x: 0, y: 0, cursor: "nwse-resize" },
  { id: "n", x: 0.5, y: 0, cursor: "ns-resize" },
  { id: "ne", x: 1, y: 0, cursor: "nesw-resize" },
  { id: "e", x: 1, y: 0.5, cursor: "ew-resize" },
  { id: "se", x: 1, y: 1, cursor: "nwse-resize" },
  { id: "s", x: 0.5, y: 1, cursor: "ns-resize" },
  { id: "sw", x: 0, y: 1, cursor: "nesw-resize" },
  { id: "w", x: 0, y: 0.5, cursor: "ew-resize" },
];

export function PreviewViewerOverlay({
  comp,
  project,
  frame,
  settings,
  viewZoom,
  viewPan,
  hostRect,
  selectedObject,
  previewOverride,
  draftTransform,
  onDraftChange,
  onCommit,
  onComponentPreview,
  onComponentCommit,
  resolveCtx,
  onPan,
  textQuality = "draft",
  getFont,
  getImageSize,
}: PreviewViewerOverlayProps) {
  const dragRef = useRef<{
    mode: DragMode;
    startComp: Vec3;
    startLocal: Vec3;
    startTransform: ResolvedTransform;
    startPan: { x: number; y: number };
    startMouse: { x: number; y: number };
    baseTransform: Transform;
    fixedComp?: Vec3;
    scaleBounds?: import("../previewViewer").LocalBounds;
    startBoxW?: number;
    startBoxH?: number;
    boxCompIdx?: number;
    lastBoxPatch?: Partial<SceneObject>;
  } | null>(null);
  const lastDraftRef = useRef<Transform | null>(null);

  const effectiveObject = useMemo(
    () => (selectedObject ? mergeObjectPreviewOverride(selectedObject, previewOverride) : null),
    [selectedObject, previewOverride],
  );

  /** ドラッグ/スクラブ中の transform を反映した comp（DomRenderer の renderComp と同型）。 */
  const overlayComp = useMemo(() => {
    let c = comp;
    if (previewOverride) {
      c = compWithObjectPatch(c, previewOverride.objectId, previewOverride.patch);
    }
    if (draftTransform && selectedObject) {
      c = compWithTransformOverride(c, selectedObject.id, draftTransform);
    }
    return c;
  }, [comp, draftTransform, previewOverride, selectedObject]);

  const activeTransform = draftTransform ?? effectiveObject?.transform ?? null;
  const activeResolved = activeTransform
    ? resolveTransformAtFrame(activeTransform, frame)
    : null;

  const boundsCtx = useMemo<LayerBoundsContext>(
    () => ({ textQuality, getFont, getImageSize }),
    [textQuality, getFont, getImageSize],
  );

  const nullWireframes = useMemo(() => {
    const worlds = computeWorldTransforms(overlayComp, frame, resolveCtx);
    const items: {
      id: string;
      corners: Vec3[];
      crossH: [Vec3, Vec3];
      crossV: [Vec3, Vec3];
    }[] = [];
    for (const obj of overlayComp.objects) {
      if (!obj.isNull || !obj.enabled || frame < obj.inPoint || frame >= obj.outPoint) continue;
      const world = worlds.get(obj.id);
      if (!world) continue;
      const bounds = getLayerLocalBounds(obj, frame, project, boundsCtx);
      items.push({
        id: obj.id,
        corners: projectBoundsToComp(bounds, world),
        crossH: [
          transformPoint(world, { x: bounds.minX, y: 0, z: 0 }),
          transformPoint(world, { x: bounds.maxX, y: 0, z: 0 }),
        ],
        crossV: [
          transformPoint(world, { x: 0, y: bounds.minY, z: 0 }),
          transformPoint(world, { x: 0, y: bounds.maxY, z: 0 }),
        ],
      });
    }
    return items;
  }, [boundsCtx, frame, overlayComp, project, resolveCtx]);

  const selectionAabb = computeSelectionAabb(
    effectiveObject,
    activeTransform,
    comp,
    project,
    frame,
    resolveCtx,
    boundsCtx,
  );

  const beginDrag = useCallback(
    (mode: DragMode, e: React.MouseEvent) => {
      if (!effectiveObject || !activeTransform || !activeResolved) {
        if (mode.kind === "pan") {
          dragRef.current = {
            mode,
            startComp: { x: 0, y: 0, z: 0 },
            startLocal: { x: 0, y: 0, z: 0 },
            startTransform: { anchor: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
            startPan: { ...viewPan },
            startMouse: { x: e.clientX, y: e.clientY },
            baseTransform: effectiveObject?.transform ?? selectedObject?.transform ?? comp.objects[0]?.transform!,
          };
          const move = (ev: MouseEvent) => {
            const d = dragRef.current;
            if (!d) return;
            const dx = (ev.clientX - d.startMouse.x) / viewZoom;
            const dy = (ev.clientY - d.startMouse.y) / viewZoom;
            onPan({ x: d.startPan.x + dx, y: d.startPan.y + dy });
          };
          const up = () => {
            dragRef.current = null;
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
          };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        }
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      const startComp = screenToComp(e.clientX, e.clientY, hostRect, viewZoom, viewPan);
      const parentWorld = parentWorldMatrix(comp, effectiveObject.id, frame, resolveCtx);
      const startLocal = compToObjectLocal(startComp, parentWorld, activeResolved) ?? startComp;

      let fixedComp: Vec3 | undefined;
      let scaleBounds: import("../previewViewer").LocalBounds | undefined;
      if (mode.kind === "scale" || mode.kind === "boxResize") {
        scaleBounds = getLayerLocalBounds(effectiveObject, frame, project, boundsCtx);
        const fixedLocal = oppositeControlPoint(scaleBounds, mode.handle);
        const startWorld = multiply(
          parentWorld,
          localMatrix(
            activeResolved.anchor,
            activeResolved.position,
            activeResolved.rotation,
            activeResolved.scale,
          ),
        );
        fixedComp = transformPoint(startWorld, fixedLocal);
      }

      dragRef.current = {
        mode,
        startComp,
        startLocal,
        startTransform: activeResolved,
        startPan: { ...viewPan },
        startMouse: { x: e.clientX, y: e.clientY },
        baseTransform: activeTransform,
        fixedComp,
        scaleBounds,
        // box リサイズは scaleBounds（= [0,boxWidth]×[0,effectiveHeight]）を起点寸法に使う。
        startBoxW: scaleBounds ? scaleBounds.maxX - scaleBounds.minX : undefined,
        startBoxH: scaleBounds ? scaleBounds.maxY - scaleBounds.minY : undefined,
        boxCompIdx: mode.kind === "boxResize" ? (textBoxCompIdx(effectiveObject, frame) ?? undefined) : undefined,
      };
      if (!draftTransform) onDraftChange(activeTransform);

      const move = (ev: MouseEvent) => {
        const d = dragRef.current;
        if (!d || !effectiveObject) return;
        const curComp = screenToComp(ev.clientX, ev.clientY, hostRect, viewZoom, viewPan);
        const pw = parentWorldMatrix(comp, effectiveObject.id, frame, resolveCtx);
        let patch: Partial<Record<"anchor" | "position" | "rotation" | "scale", Vec3>> = {};

        if (d.mode.kind === "move") {
          const delta = { x: curComp.x - d.startComp.x, y: curComp.y - d.startComp.y, z: 0 };
          patch.position = movedPosition(d.startTransform.position, pw, delta);
        } else if (d.mode.kind === "anchor") {
          const local = compToObjectLocal(curComp, pw, d.startTransform) ?? curComp;
          patch.anchor = local;
          patch.position = compensatePositionForAnchor(
            d.startTransform.position,
            d.startTransform.rotation,
            d.startTransform.scale,
            d.startTransform.anchor,
            local,
          );
        } else if (d.mode.kind === "scale" && d.fixedComp && d.scaleBounds) {
          const result = scaleFromOppositeCorner(
            d.startTransform,
            d.scaleBounds,
            d.mode.handle,
            d.fixedComp,
            d.startComp,
            curComp,
            pw,
            ev.shiftKey,
          );
          patch.scale = result.scale;
          patch.position = result.position;
        } else if (
          d.mode.kind === "boxResize" &&
          d.fixedComp &&
          d.startBoxW !== undefined &&
          d.startBoxH !== undefined &&
          d.boxCompIdx !== undefined &&
          onComponentPreview
        ) {
          const result = resizeBoxFromOppositeEdge(
            d.startTransform,
            d.startBoxW,
            d.startBoxH,
            d.mode.handle,
            d.fixedComp,
            d.startComp,
            curComp,
            pw,
          );
          const compIdx = d.boxCompIdx;
          const affectsX = d.mode.handle.includes("e") || d.mode.handle.includes("w");
          const affectsY = d.mode.handle.includes("n") || d.mode.handle.includes("s");
          const components = effectiveObject.components.map((c, i) => {
            if (i !== compIdx) return c;
            const props = { ...c.props };
            // 横ハンドルは boxWidth のみ、縦ハンドルは boxHeight のみ更新（自動高さを保つ）。
            if (affectsX) props["boxWidth"] = writeBoxProp(c.props["boxWidth"], frame, result.boxWidth);
            if (affectsY) props["boxHeight"] = writeBoxProp(c.props["boxHeight"], frame, result.boxHeight);
            return { ...c, props };
          });
          const transform = patchTransformAtFrame(d.baseTransform, frame, { position: result.position });
          const boxPatch: Partial<SceneObject> = { components, transform };
          d.lastBoxPatch = boxPatch;
          onComponentPreview(boxPatch);
          return;
        } else if (d.mode.kind === "rotate") {
          const anchorComp = anchorCompPosition(pw, d.startTransform);
          const rz = applyRotationFromDrag(
            d.startTransform.rotation.z,
            anchorComp,
            d.startComp,
            curComp,
            ev.shiftKey,
          );
          patch.rotation = { ...d.startTransform.rotation, z: rz };
        } else if (d.mode.kind === "pan") {
          const dx = (ev.clientX - d.startMouse.x) / viewZoom;
          const dy = (ev.clientY - d.startMouse.y) / viewZoom;
          onPan({ x: d.startPan.x + dx, y: d.startPan.y + dy });
          return;
        }

        const next = patchTransformAtFrame(d.baseTransform, frame, patch);
        lastDraftRef.current = next;
        onDraftChange(next);
      };

      const up = () => {
        const d = dragRef.current;
        dragRef.current = null;
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        if (!d || d.mode.kind === "pan") return;
        if (d.mode.kind === "boxResize") {
          if (d.lastBoxPatch && onComponentCommit) onComponentCommit(d.lastBoxPatch, "Resize text box");
          return;
        }
        const final = lastDraftRef.current ?? d.baseTransform;
        const label =
          d.mode.kind === "move" ? "Move layer"
          : d.mode.kind === "scale" ? "Scale layer"
          : d.mode.kind === "rotate" ? "Rotate layer"
          : "Move anchor";
        onCommit(final, label);
        onDraftChange(null);
      };

      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [activeResolved, activeTransform, boundsCtx, comp, draftTransform, effectiveObject, frame, hostRect, onCommit, onComponentCommit, onComponentPreview, onDraftChange, onPan, project, resolveCtx, selectedObject, viewPan, viewZoom],
  );

  const gridStep = Math.max(10, Math.round(comp.width / 10));

  return (
    <svg
      width={comp.width}
      height={comp.height}
      style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", overflow: "visible" }}
    >
      {/* 中ボタンパン用ヒットエリア（最背面） */}
      <rect
        width={comp.width}
        height={comp.height}
        fill="transparent"
        style={{ pointerEvents: "all", cursor: "default" }}
        onMouseDown={(e) => {
          if (e.button === 1) beginDrag({ kind: "pan" }, e);
        }}
      />

      {settings.grid && (
        <g stroke="#ffffff18" strokeWidth={1}>
          {Array.from({ length: Math.ceil(comp.width / gridStep) + 1 }, (_, i) => (
            <line key={`vg-${i}`} x1={i * gridStep} y1={0} x2={i * gridStep} y2={comp.height} />
          ))}
          {Array.from({ length: Math.ceil(comp.height / gridStep) + 1 }, (_, i) => (
            <line key={`hg-${i}`} x1={0} y1={i * gridStep} x2={comp.width} y2={i * gridStep} />
          ))}
        </g>
      )}

      {settings.centerCross && (
        <g stroke="#4a8acf55" strokeWidth={1}>
          <line x1={comp.width / 2} y1={0} x2={comp.width / 2} y2={comp.height} />
          <line x1={0} y1={comp.height / 2} x2={comp.width} y2={comp.height / 2} />
        </g>
      )}

      {settings.safeMargins && (
        <g fill="none" strokeWidth={1}>
          <rect
            x={comp.width * 0.05}
            y={comp.height * 0.05}
            width={comp.width * 0.9}
            height={comp.height * 0.9}
            stroke="#ffcc0066"
          />
          <rect
            x={comp.width * 0.1}
            y={comp.height * 0.1}
            width={comp.width * 0.8}
            height={comp.height * 0.8}
            stroke="#00ccff66"
          />
        </g>
      )}

      {settings.rulers && (
        <g fill="#888" fontSize={9} fontFamily="monospace">
          {Array.from({ length: Math.ceil(comp.width / 100) }, (_, i) => (
            <text key={`rx-${i}`} x={i * 100 + 2} y={10}>{i * 100}</text>
          ))}
          {Array.from({ length: Math.ceil(comp.height / 100) }, (_, i) => (
            <text key={`ry-${i}`} x={2} y={i * 100 + 10}>{i * 100}</text>
          ))}
        </g>
      )}

      {nullWireframes.map(({ id, corners, crossH, crossV }) => {
        const selected = selectedObject?.id === id;
        const stroke = selected ? "#ff8888" : "#e0707099";
        const strokeWidth = selected ? 2 : 1;
        const points = corners.map((c) => `${c.x},${c.y}`).join(" ");
        return (
          <g key={`null-${id}`}>
            <polygon points={points} fill="none" stroke={stroke} strokeWidth={strokeWidth} />
            <line
              x1={crossH[0].x}
              y1={crossH[0].y}
              x2={crossH[1].x}
              y2={crossH[1].y}
              stroke={stroke}
              strokeWidth={strokeWidth}
            />
            <line
              x1={crossV[0].x}
              y1={crossV[0].y}
              x2={crossV[1].x}
              y2={crossV[1].y}
              stroke={stroke}
              strokeWidth={strokeWidth}
            />
          </g>
        );
      })}

      {selectionAabb && effectiveObject && activeResolved && (
        <SelectionHandles
          aabb={selectionAabb}
          resolved={activeResolved}
          parentWorld={parentWorldMatrix(comp, effectiveObject.id, frame, resolveCtx)}
          onBegin={beginDrag}
          boxMode={textBoxCompIdx(effectiveObject, frame) !== null}
        />
      )}
    </svg>
  );
}

function SelectionHandles({
  aabb,
  resolved,
  parentWorld,
  onBegin,
  boxMode = false,
}: {
  aabb: import("../previewViewer").LocalBounds;
  resolved: ResolvedTransform;
  parentWorld: import("../../runtime/mat4").Mat4;
  onBegin: (mode: DragMode, e: React.MouseEvent) => void;
  boxMode?: boolean;
}) {
  const { minX, minY, maxX, maxY } = aabb;
  const boxW = maxX - minX;
  const boxH = maxY - minY;
  const anchorComp = anchorCompPosition(parentWorld, resolved);
  // box text はハンドルが boxWidth/boxHeight を編集する（scale ではない）。枠を破線で区別。
  const frameStroke = boxMode ? "#7c5" : "#4af";
  const handleMode = (handle: ScaleHandle): DragMode =>
    boxMode ? { kind: "boxResize", handle } : { kind: "scale", handle };

  return (
    <g style={{ pointerEvents: "all" }}>
      <rect
        x={minX}
        y={minY}
        width={boxW}
        height={boxH}
        fill="none"
        stroke={frameStroke}
        strokeWidth={1}
        strokeDasharray={boxMode ? "4 3" : undefined}
        style={{ cursor: "move" }}
        onMouseDown={(e) => onBegin({ kind: "move" }, e)}
      />

      {SCALE_HANDLES.map((handle) => {
        const hx = minX + boxW * handle.x - HANDLE_SIZE / 2;
        const hy = minY + boxH * handle.y - HANDLE_SIZE / 2;
        return (
          <rect
            key={handle.id}
            x={hx}
            y={hy}
            width={HANDLE_SIZE}
            height={HANDLE_SIZE}
            fill="#fff"
            stroke={frameStroke}
            strokeWidth={1}
            style={{ cursor: handle.cursor }}
            onMouseDown={(e) => onBegin(handleMode(handle.id), e)}
          />
        );
      })}

      {/* 回転ハンドル（上辺中央の外側） */}
      <circle
        cx={minX + boxW / 2}
        cy={minY - ROTATE_OFFSET}
        r={6}
        fill="#fff"
        stroke="#fa4"
        strokeWidth={1}
        style={{ cursor: "grab" }}
        onMouseDown={(e) => onBegin({ kind: "rotate" }, e)}
      />
      <line
        x1={minX + boxW / 2}
        y1={minY}
        x2={minX + boxW / 2}
        y2={minY - ROTATE_OFFSET + 6}
        stroke="#fa4"
        strokeWidth={1}
      />

      {/* アンカー ◎ */}
      <circle
        cx={anchorComp.x}
        cy={anchorComp.y}
        r={7}
        fill="none"
        stroke="#fc4"
        strokeWidth={2}
        style={{ cursor: "crosshair" }}
        onMouseDown={(e) => onBegin({ kind: "anchor" }, e)}
      />
      <circle cx={anchorComp.x} cy={anchorComp.y} r={2} fill="#fc4" />
    </g>
  );
}

function computeSelectionAabb(
  obj: SceneObject | null,
  transform: Transform | null,
  comp: TimelineComposition,
  project: Project,
  frame: Frame,
  ctx?: ResolveContext,
  boundsCtx?: LayerBoundsContext,
): import("../previewViewer").LocalBounds | null {
  if (!obj || !transform) return null;
  const renderComp = compWithTransformOverride(comp, obj.id, transform);
  const bounds = getLayerLocalBounds(obj, frame, project, boundsCtx);
  const worlds = computeWorldTransforms(renderComp, frame, ctx);
  const world = worlds.get(obj.id);
  if (!world) return null;
  const corners = projectBoundsToComp(bounds, world);
  return boundsAabb(corners);
}