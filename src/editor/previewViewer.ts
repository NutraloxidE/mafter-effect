import type {
  AnimatedProp,
  Easing,
  Frame,
  Keyframe,
  Project,
  SceneObject,
  ShapeVertex,
  TimelineComposition,
  Transform,
  Vec3,
} from "../core/schema";
import { sampleAny, sampleVec3 } from "../runtime/interpolate";
import { computeTextBoundsForHandles, parseTextProps } from "../runtime/textRender";
import { identity, invert, localMatrix, multiply, rotationEuler, scaling, transformPoint, type Mat4 } from "../runtime/mat4";
import type { ResolveContext } from "../runtime/resolve";

function setKeyframeAtFrame<T>(
  prop: AnimatedProp<T>,
  frame: Frame,
  value: T,
  easing: Easing = { type: "linear" },
): AnimatedProp<T> {
  const existing = prop.keyframes.findIndex((k) => k.frame === frame);
  const kf: Keyframe<T> = { frame, value, easing };
  if (existing >= 0) {
    const kfs = [...prop.keyframes];
    kfs[existing] = kf;
    return { ...prop, keyframes: kfs };
  }
  const kfs = [...prop.keyframes, kf].sort((a, b) => a.frame - b.frame);
  return { ...prop, keyframes: kfs };
}

export interface ViewPan {
  x: number;
  y: number;
}

export type ZoomMode = "fit" | "fit100" | "manual";
export type ResolutionProxy = "full" | "half" | "quarter";

export type TransformVecKey = "anchor" | "position" | "rotation" | "scale";

export interface LocalBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface LayerBoundsContext {
  getFont?: (family: string) => import("opentype.js").Font | null;
  getImageSize?: (assetId: string) => { width: number; height: number } | null;
  textQuality?: "draft" | "precise";
}

export interface ResolvedTransform {
  anchor: Vec3;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

const PROXY_SCALE: Record<ResolutionProxy, number> = {
  full: 1,
  half: 0.5,
  quarter: 0.25,
};

export function resolutionProxyScale(proxy: ResolutionProxy): number {
  return PROXY_SCALE[proxy];
}

/** §25.1 Fit / Fit≤100% の viewZoom を導出する。 */
export function computeFitZoom(
  viewportW: number,
  viewportH: number,
  compW: number,
  compH: number,
  capAt100 = false,
): number {
  if (viewportW <= 0 || viewportH <= 0 || compW <= 0 || compH <= 0) return 1;
  const s = Math.min(viewportW / compW, viewportH / compH);
  return capAt100 ? Math.min(s, 1) : s;
}

/** §25.1 Fit 時の viewPan（comp px）— ビューポート中央に comp を置く。 */
export function computeFitPan(
  viewportW: number,
  viewportH: number,
  compW: number,
  compH: number,
  viewZoom: number,
): ViewPan {
  return {
    x: (viewportW / viewZoom - compW) / 2,
    y: (viewportH / viewZoom - compH) / 2,
  };
}

/** §25.4 screen px → comp px。stageHost はビューポート左上基準。 */
export function screenToComp(
  clientX: number,
  clientY: number,
  hostRect: { left: number; top: number },
  viewZoom: number,
  viewPan: ViewPan,
): Vec3 {
  const sx = clientX - hostRect.left;
  const sy = clientY - hostRect.top;
  return {
    x: sx / viewZoom - viewPan.x,
    y: sy / viewZoom - viewPan.y,
    z: 0,
  };
}

/** comp px → screen px（stageHost 左上基準）。 */
export function compToScreen(
  compX: number,
  compY: number,
  viewZoom: number,
  viewPan: ViewPan,
): { x: number; y: number } {
  return {
    x: (compX + viewPan.x) * viewZoom,
    y: (compY + viewPan.y) * viewZoom,
  };
}

/** §25.1 Ctrl+ホイール: カーソルアンカーで viewZoom / viewPan を更新する。 */
export function zoomAtCursor(
  viewZoom: number,
  viewPan: ViewPan,
  cursorComp: Vec3,
  factor: number,
): { viewZoom: number; viewPan: ViewPan } {
  const nextZoom = Math.max(0.05, Math.min(16, viewZoom * factor));
  const scale = viewZoom / nextZoom;
  return {
    viewZoom: nextZoom,
    viewPan: {
      x: (cursorComp.x + viewPan.x) * scale - cursorComp.x,
      y: (cursorComp.y + viewPan.y) * scale - cursorComp.y,
    },
  };
}

/** resolve と同型の world 行列キャッシュ（エディタ層のみ・INV-7 不変）。 */
export function computeWorldTransforms(
  comp: TimelineComposition,
  frame: Frame,
  ctx?: ResolveContext,
): Map<string, Mat4> {
  const byId = new Map(comp.objects.map((o) => [o.id, o]));
  const cache = new Map<string, Mat4>();
  const visiting = new Set<string>();

  const resolver = createLocalResolver(comp, frame, ctx);

  const worldOf = (id: string): Mat4 => {
    const hit = cache.get(id);
    if (hit) return hit;
    const obj = byId.get(id);
    if (!obj) return identity();
    if (visiting.has(id)) return identity();
    visiting.add(id);
    const local = resolver.localOf(obj.transform, obj.id);
    const world =
      obj.parent && byId.has(obj.parent)
        ? multiply(worldOf(obj.parent), local)
        : local;
    visiting.delete(id);
    cache.set(id, world);
    return world;
  };

  for (const obj of comp.objects) worldOf(obj.id);
  return cache;
}

export function parentWorldMatrix(
  comp: TimelineComposition,
  objectId: string,
  frame: Frame,
  ctx?: ResolveContext,
): Mat4 {
  const obj = comp.objects.find((o) => o.id === objectId);
  if (!obj?.parent) return identity();
  return computeWorldTransforms(comp, frame, ctx).get(obj.parent) ?? identity();
}

/** comp 座標 → オブジェクト local 座標（親 world の逆を適用）。 */
export function compToLocal(
  compPt: Vec3,
  parentWorld: Mat4,
): Vec3 | null {
  const inv = invert(parentWorld);
  if (!inv) return null;
  return transformPoint(inv, compPt);
}

/** comp 座標 → オブジェクト content-local 座標。 */
export function compToObjectLocal(
  compPt: Vec3,
  parentWorld: Mat4,
  transform: ResolvedTransform,
): Vec3 | null {
  const L = localMatrix(transform.anchor, transform.position, transform.rotation, transform.scale);
  const world = multiply(parentWorld, L);
  const inv = invert(world);
  if (!inv) return null;
  return transformPoint(inv, compPt);
}

/** local 座標 → comp 座標（親 world 空間）。 */
export function localToComp(localPt: Vec3, parentWorld: Mat4): Vec3 {
  return transformPoint(parentWorld, localPt);
}

/** §25.4 往復: local → comp → local が元に戻ることの検証用。 */
export function roundTripLocalToComp(
  localPt: Vec3,
  parentWorld: Mat4,
): Vec3 | null {
  const compPt = localToComp(localPt, parentWorld);
  return compToLocal(compPt, parentWorld);
}

/** レイヤーのローカル境界（コンテンツ px）。 */
export function getLayerLocalBounds(
  obj: SceneObject,
  frame: Frame,
  project: Project,
  boundsCtx?: LayerBoundsContext,
): LocalBounds {
  if (obj.isNull) {
    return { minX: -50, minY: -50, maxX: 50, maxY: 50 };
  }

  let minX = 0;
  let minY = 0;
  let maxX = 100;
  let maxY = 100;
  let found = false;

  for (const c of obj.components) {
    const b = boundsForComponent(c.type, c.props, frame, project, boundsCtx);
    if (!b) continue;
    if (!found) {
      minX = b.minX;
      minY = b.minY;
      maxX = b.maxX;
      maxY = b.maxY;
      found = true;
    } else {
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
  }

  if (!found) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  return { minX, minY, maxX, maxY };
}

function resolveTextPropsAtFrame(
  props: Record<string, unknown>,
  frame: Frame,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...props };
  for (const key of ["text", "size", "tracking", "leading", "boxWidth", "boxHeight", "color", "strokeColor", "strokeWidth"] as const) {
    if (key in props) out[key] = sampleAny(props[key], frame);
  }
  return out;
}

function boundsForComponent(
  type: string,
  props: Record<string, unknown>,
  frame: Frame,
  project: Project,
  boundsCtx?: LayerBoundsContext,
): LocalBounds | null {
  // §5.5c shape kind="path": size prop を持たないため頂点の bounding box から算出する。
  if (type === "shape" && props["kind"] === "path") {
    const vertices = props["vertices"] as ShapeVertex[] | undefined;
    if (!vertices || vertices.length === 0) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const v of vertices) {
      const pos = sampleAny(v.pos, frame) as Vec3;
      minX = Math.min(minX, pos.x);
      maxX = Math.max(maxX, pos.x);
      minY = Math.min(minY, pos.y);
      maxY = Math.max(maxY, pos.y);
    }
    return { minX, minY, maxX, maxY };
  }
  switch (type) {
    case "solid":
    case "shape": {
      const size = sampleAny(props["size"], frame) as Vec3 | undefined;
      const w = size?.x ?? 100;
      const h = size?.y ?? 100;
      return { minX: 0, minY: 0, maxX: w, maxY: h };
    }
    case "text": {
      const p = parseTextProps(resolveTextPropsAtFrame(props, frame));
      const font = boundsCtx?.getFont?.(p.font) ?? null;
      const useFontMetrics = boundsCtx?.textQuality === "precise";
      return computeTextBoundsForHandles(p, font, useFontMetrics);
    }
    case "image": {
      const assetId = props["asset"];
      if (typeof assetId === "string") {
        const fromCache = boundsCtx?.getImageSize?.(assetId);
        if (fromCache) {
          return { minX: 0, minY: 0, maxX: fromCache.width, maxY: fromCache.height };
        }
      }
      const w = (props["width"] as number | undefined) ?? 200;
      const h = (props["height"] as number | undefined) ?? 200;
      return { minX: 0, minY: 0, maxX: w, maxY: h };
    }
    case "comp": {
      const compId = props["compId"];
      if (typeof compId !== "string") return null;
      const child = project.compositions.find((x) => x.id === compId && x.kind === "timeline");
      if (!child || child.kind !== "timeline") return null;
      return { minX: 0, minY: 0, maxX: child.width, maxY: child.height };
    }
    case "html": {
      const compId = props["compId"];
      if (typeof compId !== "string") return null;
      const html = project.compositions.find((x) => x.id === compId && x.kind === "html");
      if (!html || html.kind !== "html") return null;
      return { minX: 0, minY: 0, maxX: html.width, maxY: html.height };
    }
    default: {
      const w = (sampleAny(props["width"], frame) as number | undefined) ?? 100;
      const h = (sampleAny(props["height"], frame) as number | undefined) ?? 100;
      if (typeof w === "number" && typeof h === "number") {
        return { minX: 0, minY: 0, maxX: w, maxY: h };
      }
      return null;
    }
  }
}

/** ローカル矩形の 4 隅を comp 座標へ投影。 */
export function projectBoundsToComp(
  bounds: LocalBounds,
  worldMatrix: Mat4,
): Vec3[] {
  const corners = [
    { x: bounds.minX, y: bounds.minY, z: 0 },
    { x: bounds.maxX, y: bounds.minY, z: 0 },
    { x: bounds.maxX, y: bounds.maxY, z: 0 },
    { x: bounds.minX, y: bounds.maxY, z: 0 },
  ];
  return corners.map((c) => transformPoint(worldMatrix, c));
}

export function boundsAabb(points: Vec3[]): LocalBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** §25.5 animated → 現 frame KF / static → value。 */
export function writeVec3AtFrame(
  prop: AnimatedProp<Vec3>,
  frame: Frame,
  value: Vec3,
): AnimatedProp<Vec3> {
  if (prop.keyframes.length > 0) {
    return setKeyframeAtFrame(prop, frame, value, { type: "linear" });
  }
  return { ...prop, value };
}

export function patchTransformAtFrame(
  transform: Transform,
  frame: Frame,
  patch: Partial<Record<TransformVecKey, Vec3>>,
): Transform {
  const next: Transform = { ...transform };
  for (const key of ["anchor", "position", "rotation", "scale"] as TransformVecKey[]) {
    const v = patch[key];
    if (v !== undefined) next[key] = writeVec3AtFrame(transform[key], frame, v);
  }
  return next;
}

/** §25.3 アンカー移動時に見た目を保つ position 補正。 */
export function compensatePositionForAnchor(
  position: Vec3,
  rotation: Vec3,
  scale: Vec3,
  oldAnchor: Vec3,
  newAnchor: Vec3,
): Vec3 {
  const d = {
    x: newAnchor.x - oldAnchor.x,
    y: newAnchor.y - oldAnchor.y,
    z: newAnchor.z - oldAnchor.z,
  };
  const rs = multiply(rotationEuler(rotation), scaling(scale.x, scale.y, scale.z));
  const shifted = transformPoint(rs, d);
  return {
    x: position.x + shifted.x,
    y: position.y + shifted.y,
    z: position.z + shifted.z,
  };
}

/** §25.3 移動: comp 空間の delta を parent-local に変換して position に加算。 */
export function movedPosition(
  startPosition: Vec3,
  parentWorld: Mat4,
  deltaComp: Vec3,
): Vec3 {
  const inv = invert(parentWorld);
  if (!inv) return startPosition;
  const origin = transformPoint(inv, { x: 0, y: 0, z: 0 });
  const shifted = transformPoint(inv, { x: deltaComp.x, y: deltaComp.y, z: 0 });
  return {
    x: startPosition.x + (shifted.x - origin.x),
    y: startPosition.y + (shifted.y - origin.y),
    z: startPosition.z,
  };
}

/** anchor の comp 座標を求める。 */
export function anchorCompPosition(
  parentWorld: Mat4,
  transform: ResolvedTransform,
): Vec3 {
  const L = localMatrix(transform.anchor, transform.position, transform.rotation, transform.scale);
  return transformPoint(multiply(parentWorld, L), transform.anchor);
}

/** ハンドルに対応するバウンディングボックス上の制御点（content-local）。 */
export function handleControlPoint(bounds: LocalBounds, handle: ScaleHandle): Vec3 {
  const { minX, minY, maxX, maxY } = bounds;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  switch (handle) {
    case "nw": return { x: minX, y: minY, z: 0 };
    case "n": return { x: midX, y: minY, z: 0 };
    case "ne": return { x: maxX, y: minY, z: 0 };
    case "e": return { x: maxX, y: midY, z: 0 };
    case "se": return { x: maxX, y: maxY, z: 0 };
    case "s": return { x: midX, y: maxY, z: 0 };
    case "sw": return { x: minX, y: maxY, z: 0 };
    case "w": return { x: minX, y: midY, z: 0 };
  }
}

const OPPOSITE_HANDLE: Record<ScaleHandle, ScaleHandle> = {
  nw: "se", n: "s", ne: "sw", e: "w", se: "nw", s: "n", sw: "ne", w: "e",
};

/** ドラッグ中に固定する反対側の制御点（AE 準拠: 反対コーナー/辺を固定）。 */
export function oppositeControlPoint(bounds: LocalBounds, handle: ScaleHandle): Vec3 {
  return handleControlPoint(bounds, OPPOSITE_HANDLE[handle]);
}

function safeRatio(numerator: number, denominator: number, fallback = 1): number {
  return Math.abs(denominator) < 1e-6 ? fallback : numerator / denominator;
}

/** 固定点の comp 座標を維持する position を求める。 */
export function positionForFixedLocalPoint(
  fixedComp: Vec3,
  fixedLocal: Vec3,
  anchor: Vec3,
  rotation: Vec3,
  scale: Vec3,
  parentWorld: Mat4,
): Vec3 {
  const linear = multiply(rotationEuler(rotation), scaling(scale.x, scale.y, scale.z));
  const v = {
    x: fixedLocal.x - anchor.x,
    y: fixedLocal.y - anchor.y,
    z: fixedLocal.z - anchor.z,
  };
  const offset = transformPoint(linear, v);
  const invP = invert(parentWorld);
  if (!invP) return { x: 0, y: 0, z: 0 };
  const parentPt = transformPoint(invP, fixedComp);
  return {
    x: parentPt.x - offset.x,
    y: parentPt.y - offset.y,
    z: parentPt.z - offset.z,
  };
}

export interface ScaleDragResult {
  scale: Vec3;
  position: Vec3;
}

/**
 * §25.3 スケール（AE 準拠）: 反対コーナー/辺を comp 空間で固定し scale + position を同時更新。
 * アンカーはピボットではなく、固定点の位置補正にのみ使う。
 */
export function scaleFromOppositeCorner(
  startTransform: ResolvedTransform,
  bounds: LocalBounds,
  handle: ScaleHandle,
  fixedComp: Vec3,
  startComp: Vec3,
  curComp: Vec3,
  parentWorld: Mat4,
  uniform: boolean,
): ScaleDragResult {
  const fixedLocal = oppositeControlPoint(bounds, handle);
  const handleLocal = handleControlPoint(bounds, handle);

  const startWorld = multiply(
    parentWorld,
    localMatrix(
      startTransform.anchor,
      startTransform.position,
      startTransform.rotation,
      startTransform.scale,
    ),
  );
  const handleCompStart = transformPoint(startWorld, handleLocal);
  const deltaStart = {
    x: handleCompStart.x - fixedComp.x,
    y: handleCompStart.y - fixedComp.y,
    z: 0,
  };
  const deltaNow = {
    x: deltaStart.x + (curComp.x - startComp.x),
    y: deltaStart.y + (curComp.y - startComp.y),
    z: 0,
  };

  const affectsX = handle.includes("e") || handle.includes("w");
  const affectsY = handle.includes("n") || handle.includes("s");

  let fx = 1;
  let fy = 1;
  if (affectsX) fx = safeRatio(deltaNow.x, deltaStart.x);
  if (affectsY) fy = safeRatio(deltaNow.y, deltaStart.y);

  fx = Math.max(0.01, Math.abs(fx));
  fy = Math.max(0.01, Math.abs(fy));

  if (uniform) {
    const f = affectsX && !affectsY ? fx : affectsY && !affectsX ? fy : Math.max(fx, fy);
    fx = f;
    fy = f;
  }

  const signX = startTransform.scale.x < 0 ? -1 : 1;
  const signY = startTransform.scale.y < 0 ? -1 : 1;

  const newScale: Vec3 = {
    x: signX * Math.abs(startTransform.scale.x) * fx,
    y: signY * Math.abs(startTransform.scale.y) * fy,
    z: startTransform.scale.z,
  };

  const newPosition = positionForFixedLocalPoint(
    fixedComp,
    fixedLocal,
    startTransform.anchor,
    startTransform.rotation,
    newScale,
    parentWorld,
  );

  return { scale: newScale, position: newPosition };
}

export interface BoxResizeResult {
  boxWidth: number;
  boxHeight: number;
  position: Vec3;
}

const MIN_BOX_DIM = 4;

/**
 * §26.3.3 ボックステキストのリサイズ。反対辺/コーナーを comp 空間で固定して
 * boxWidth/boxHeight を local px で更新し、左/上辺ドラッグ時は position を補正する。
 * scale は変えない（テキストは拡大せず箱だけ変わり、中身は再折返しされる）。
 */
export function resizeBoxFromOppositeEdge(
  startTransform: ResolvedTransform,
  startBoxW: number,
  startBoxH: number,
  handle: ScaleHandle,
  fixedComp: Vec3,
  startComp: Vec3,
  curComp: Vec3,
  parentWorld: Mat4,
): BoxResizeResult {
  const startWorld = multiply(
    parentWorld,
    localMatrix(startTransform.anchor, startTransform.position, startTransform.rotation, startTransform.scale),
  );
  const inv = invert(startWorld);
  const startLocal = inv ? transformPoint(inv, startComp) : startComp;
  const curLocal = inv ? transformPoint(inv, curComp) : curComp;
  const dx = curLocal.x - startLocal.x;
  const dy = curLocal.y - startLocal.y;

  let boxWidth = startBoxW;
  let boxHeight = startBoxH;
  if (handle.includes("e")) boxWidth = startBoxW + dx;
  if (handle.includes("w")) boxWidth = startBoxW - dx;
  if (handle.includes("s")) boxHeight = startBoxH + dy;
  if (handle.includes("n")) boxHeight = startBoxH - dy;
  boxWidth = Math.max(MIN_BOX_DIM, boxWidth);
  boxHeight = Math.max(MIN_BOX_DIM, boxHeight);

  // 反対辺/コーナー（新 bounds 基準）を fixedComp に保つよう position を補正。
  const fixedLocalNew = oppositeControlPoint(
    { minX: 0, minY: 0, maxX: boxWidth, maxY: boxHeight },
    handle,
  );
  const position = positionForFixedLocalPoint(
    fixedComp,
    fixedLocalNew,
    startTransform.anchor,
    startTransform.rotation,
    startTransform.scale,
    parentWorld,
  );
  return { boxWidth, boxHeight, position };
}

export type ScaleHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** §25.3 回転: anchor 周りの角度差（度）。Shift で 45° スナップ。 */
export function applyRotationFromDrag(
  startRotationZ: number,
  anchorComp: Vec3,
  startComp: Vec3,
  currentComp: Vec3,
  snap45: boolean,
): number {
  const a0 = Math.atan2(startComp.y - anchorComp.y, startComp.x - anchorComp.x);
  const a1 = Math.atan2(currentComp.y - anchorComp.y, currentComp.x - anchorComp.x);
  let deg = startRotationZ + (a1 - a0) * (180 / Math.PI);
  if (snap45) deg = Math.round(deg / 45) * 45;
  return deg;
}

/** Inspector/Timeline スクラブ中の patch を SceneObject にマージ（ハンドル bounds 用）。 */
export function mergeObjectPreviewOverride(
  obj: SceneObject,
  previewOverride: { objectId: string; patch: Partial<SceneObject> } | null | undefined,
): SceneObject {
  if (!previewOverride || previewOverride.objectId !== obj.id) return obj;
  return { ...obj, ...previewOverride.patch };
}

/** ドラッグ中の transform を comp に一時適用（resolve 用）。 */
export function compWithTransformOverride(
  comp: TimelineComposition,
  objectId: string,
  transform: Transform,
): TimelineComposition {
  return compWithObjectPatch(comp, objectId, { transform });
}

/** Inspector/Timeline スクラブ中の patch を comp に一時適用（resolve 用）。 */
export function compWithObjectPatch(
  comp: TimelineComposition,
  objectId: string,
  patch: Partial<SceneObject>,
): TimelineComposition {
  return {
    ...comp,
    objects: comp.objects.map((o) =>
      o.id === objectId ? { ...o, ...patch } : o,
    ),
  };
}

/** frame で解決済み Transform 値を取得。 */
export function resolveTransformAtFrame(
  transform: Transform,
  frame: Frame,
): ResolvedTransform {
  return {
    anchor: sampleVec3(transform.anchor, frame),
    position: sampleVec3(transform.position, frame),
    rotation: sampleVec3(transform.rotation, frame),
    scale: sampleVec3(transform.scale, frame),
  };
}

/** §25.4 往復: local → world(comp) → local が元に戻ることの検証用。 */
export function roundTripTransformPoint(
  localPt: Vec3,
  parentWorld: Mat4,
  transform: ResolvedTransform,
): Vec3 | null {
  const L = localMatrix(transform.anchor, transform.position, transform.rotation, transform.scale);
  const world = multiply(parentWorld, L);
  const compPt = transformPoint(world, localPt);
  const invWorld = invert(world);
  if (!invWorld) return null;
  return transformPoint(invWorld, compPt);
}

// ── resolve localOf の軽量複製（エディタ層のみ）──

function createLocalResolver(comp: TimelineComposition, frame: Frame, ctx?: ResolveContext) {
  const fps = comp.fps;
  const evaluator = ctx?.expressions;

  function applyExpr<T>(prop: AnimatedProp<T>, sampled: T, objectId: string): T {
    const ex = prop.expression;
    if (!ex?.enabled || !evaluator) return sampled;
    try {
      return evaluator({ path: ex.path, frame, fps, value: sampled, objectId }) as T;
    } catch {
      return sampled;
    }
  }

  function vec3Prop(prop: AnimatedProp<Vec3>, objectId: string): Vec3 {
    return applyExpr(prop, sampleVec3(prop, frame), objectId);
  }

  function localOf(transform: Transform, objectId: string): Mat4 {
    return localMatrix(
      vec3Prop(transform.anchor, objectId),
      vec3Prop(transform.position, objectId),
      vec3Prop(transform.rotation, objectId),
      vec3Prop(transform.scale, objectId),
    );
  }

  return { localOf };
}
