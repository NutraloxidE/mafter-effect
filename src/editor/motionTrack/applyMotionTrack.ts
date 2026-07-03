import type { Project, SceneObject, TimelineComposition, Vec3 } from "../../core/schema";
import { isPropExpressed } from "../../core/props";
import type { AnimatedProp } from "../../core/schema";
import type { ApplyMotionTrackParams, ApplyRotationTrackParams } from "./types";

const LINEAR = { type: "linear" as const };

/**
 * ベイク範囲内 KF を置換し、範囲外は保持。expression クリアは同一 patch に含める。
 */
export function bakePositionKeyframes(
  position: AnimatedProp<Vec3>,
  params: ApplyMotionTrackParams,
): AnimatedProp<Vec3> {
  const { positionsByFrame, bakeStart, bakeEnd, clearExpression } = params;
  const kept = position.keyframes.filter((kf) => kf.frame < bakeStart || kf.frame >= bakeEnd);
  const baked = [...positionsByFrame.entries()]
    .filter(([f]) => f >= bakeStart && f < bakeEnd)
    .map(([frame, value]) => ({ frame, value, easing: LINEAR }))
    .sort((a, b) => a.frame - b.frame);
  const merged = [...kept, ...baked].sort((a, b) => a.frame - b.frame);
  const baseValue = merged.length > 0 ? merged[0]!.value : params.baselinePosition;
  let next: AnimatedProp<Vec3> = { value: baseValue, keyframes: merged };
  if (clearExpression && position.expression) {
    const { expression: _ex, ...rest } = next;
    next = rest;
  }
  return next;
}

export function applyMotionTrackToObject(
  target: SceneObject,
  params: ApplyMotionTrackParams,
): SceneObject {
  const position = bakePositionKeyframes(target.transform.position, params);
  return {
    ...target,
    transform: {
      ...target.transform,
      position,
    },
  };
}

export function applyMotionTrackToProject(
  project: Project,
  compId: string,
  targetId: string,
  params: ApplyMotionTrackParams,
): { before: Project; after: Project } {
  const before = project;
  const comp = before.compositions.find((c) => c.id === compId && c.kind === "timeline") as
    | TimelineComposition
    | undefined;
  if (!comp) throw new Error("composition not found");
  const target = comp.objects.find((o) => o.id === targetId);
  if (!target) throw new Error("target object not found");

  const updated = applyMotionTrackToObject(target, params);
  const after: Project = {
    ...before,
    compositions: before.compositions.map((c) => {
      if (c.id !== compId || c.kind !== "timeline") return c;
      return {
        ...c,
        objects: c.objects.map((o) => (o.id === targetId ? updated : o)),
      };
    }),
  };
  return { before, after };
}

export function targetHasPositionExpression(target: SceneObject): boolean {
  return isPropExpressed(target.transform.position);
}

export function bakeRotationKeyframes(
  rotation: AnimatedProp<Vec3>,
  params: ApplyRotationTrackParams,
): AnimatedProp<Vec3> {
  const { rotationsByFrame, bakeStart, bakeEnd, clearExpression } = params;
  const kept = rotation.keyframes.filter((kf) => kf.frame < bakeStart || kf.frame >= bakeEnd);
  const baked = [...rotationsByFrame.entries()]
    .filter(([f]) => f >= bakeStart && f < bakeEnd)
    .map(([frame, value]) => ({ frame, value, easing: LINEAR }))
    .sort((a, b) => a.frame - b.frame);
  const merged = [...kept, ...baked].sort((a, b) => a.frame - b.frame);
  const baseValue = merged.length > 0 ? merged[0]!.value : params.baselineRotation;
  let next: AnimatedProp<Vec3> = { value: baseValue, keyframes: merged };
  if (clearExpression && rotation.expression) {
    const { expression: _ex, ...rest } = next;
    next = rest;
  }
  return next;
}

export function applyRotationTrackToObject(
  target: SceneObject,
  params: ApplyRotationTrackParams,
): SceneObject {
  const rot = bakeRotationKeyframes(target.transform.rotation, params);
  return {
    ...target,
    transform: {
      ...target.transform,
      rotation: rot,
    },
  };
}

export function applyRotationTrackToProject(
  project: Project,
  compId: string,
  targetId: string,
  params: ApplyRotationTrackParams,
): { before: Project; after: Project } {
  const before = project;
  const comp = before.compositions.find((c) => c.id === compId && c.kind === "timeline") as
    | TimelineComposition
    | undefined;
  if (!comp) throw new Error("composition not found");
  const target = comp.objects.find((o) => o.id === targetId);
  if (!target) throw new Error("target object not found");

  const updated = applyRotationTrackToObject(target, params);
  const after: Project = {
    ...before,
    compositions: before.compositions.map((c) => {
      if (c.id !== compId || c.kind !== "timeline") return c;
      return {
        ...c,
        objects: c.objects.map((o) => (o.id === targetId ? updated : o)),
      };
    }),
  };
  return { before, after };
}

export function applyCombinedTrackToObject(
  target: SceneObject,
  positionParams: ApplyMotionTrackParams,
  rotationParams: ApplyRotationTrackParams,
): SceneObject {
  const withPosition = applyMotionTrackToObject(target, positionParams);
  return applyRotationTrackToObject(withPosition, rotationParams);
}

export function applyCombinedTrackToProject(
  project: Project,
  compId: string,
  targetId: string,
  positionParams: ApplyMotionTrackParams,
  rotationParams: ApplyRotationTrackParams,
): { before: Project; after: Project } {
  const before = project;
  const comp = before.compositions.find((c) => c.id === compId && c.kind === "timeline") as
    | TimelineComposition
    | undefined;
  if (!comp) throw new Error("composition not found");
  const target = comp.objects.find((o) => o.id === targetId);
  if (!target) throw new Error("target object not found");

  const updated = applyCombinedTrackToObject(target, positionParams, rotationParams);
  const after: Project = {
    ...before,
    compositions: before.compositions.map((c) => {
      if (c.id !== compId || c.kind !== "timeline") return c;
      return {
        ...c,
        objects: c.objects.map((o) => (o.id === targetId ? updated : o)),
      };
    }),
  };
  return { before, after };
}

export function targetHasRotationExpression(target: SceneObject): boolean {
  return isPropExpressed(target.transform.rotation);
}

/**
 * 3D Solve のベイク: position + rotation + （カメラなら）推定 zoom を単一 undo で適用。
 * cameraZoomPx は解像度換算済みの comp 高さ基準 zoom（px）。
 */
export function applySolveTrackToProject(
  project: Project,
  compId: string,
  targetId: string,
  positionParams: ApplyMotionTrackParams,
  rotationParams: ApplyRotationTrackParams,
  cameraZoomPx?: number,
): { before: Project; after: Project } {
  const before = project;
  const comp = before.compositions.find((c) => c.id === compId && c.kind === "timeline") as
    | TimelineComposition
    | undefined;
  if (!comp) throw new Error("composition not found");
  const target = comp.objects.find((o) => o.id === targetId);
  if (!target) throw new Error("target object not found");

  let updated = applyCombinedTrackToObject(target, positionParams, rotationParams);
  if (cameraZoomPx !== undefined && cameraZoomPx > 0) {
    updated = {
      ...updated,
      components: updated.components.map((c) =>
        c.type === "camera" ? { ...c, props: { ...c.props, zoom: cameraZoomPx } } : c,
      ),
    };
  }
  const after: Project = {
    ...before,
    compositions: before.compositions.map((c) => {
      if (c.id !== compId || c.kind !== "timeline") return c;
      return {
        ...c,
        objects: c.objects.map((o) => (o.id === targetId ? updated : o)),
      };
    }),
  };
  return { before, after };
}
