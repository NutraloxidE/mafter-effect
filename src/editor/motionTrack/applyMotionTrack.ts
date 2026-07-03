import type { Project, SceneObject, TimelineComposition, Vec3 } from "../../core/schema";
import { isPropExpressed } from "../../core/props";
import type { AnimatedProp } from "../../core/schema";
import type { ApplyMotionTrackParams } from "./types";

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
