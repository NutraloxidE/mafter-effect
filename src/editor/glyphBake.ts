import { staticProp } from "../core/props";
import type {
  AnimatedProp,
  Frame,
  ObjectId,
  SceneObject,
  Transform,
  Vec3,
} from "../core/schema";
import { sampleVec3 } from "../runtime/interpolate";
import { decomposeTrs, localMatrix, multiply, translation, type Mat4 } from "../runtime/mat4";
import type { ResolveContext } from "../runtime/resolve";

const LINEAR = { type: "linear" as const };

export function collectIntegerFrames(inPoint: Frame, outPoint: Frame): Frame[] {
  const frames: Frame[] = [];
  for (let f = inPoint; f < outPoint; f++) frames.push(f);
  return frames;
}

function applyExpr<T>(
  prop: AnimatedProp<T>,
  sampled: T,
  frame: Frame,
  fps: number,
  objectId: ObjectId,
  ctx?: ResolveContext,
): T {
  const ex = prop.expression;
  const evaluator = ctx?.expressions;
  if (!ex?.enabled || !evaluator) return sampled;
  try {
    return evaluator({ path: ex.path, frame, fps, value: sampled, objectId }) as T;
  } catch {
    return sampled;
  }
}

export function sampleObjectLocalMatrix(
  obj: SceneObject,
  frame: Frame,
  fps: number,
  ctx?: ResolveContext,
): Mat4 {
  const anchor = applyExpr(
    obj.transform.anchor,
    sampleVec3(obj.transform.anchor, frame),
    frame,
    fps,
    obj.id,
    ctx,
  );
  const position = applyExpr(
    obj.transform.position,
    sampleVec3(obj.transform.position, frame),
    frame,
    fps,
    obj.id,
    ctx,
  );
  const rotation = applyExpr(
    obj.transform.rotation,
    sampleVec3(obj.transform.rotation, frame),
    frame,
    fps,
    obj.id,
    ctx,
  );
  const scale = applyExpr(
    obj.transform.scale,
    sampleVec3(obj.transform.scale, frame),
    frame,
    fps,
    obj.id,
    ctx,
  );
  return localMatrix(anchor, position, rotation, scale);
}

function bakeVec3Channel(
  frames: Frame[],
  sampler: (f: Frame) => Vec3,
): AnimatedProp<Vec3> {
  if (frames.length === 0) {
    const v = sampler(0);
    return staticProp(v);
  }
  const keyframes = frames.map((f) => ({
    frame: f,
    value: sampler(f),
    easing: LINEAR,
  }));
  return { value: keyframes[0]!.value, keyframes };
}

/** §26.5.1b: L_baked(f) = L_original(f) · T(gx, gy, 0) を全整数フレームで KF 化。 */
export function bakeGlyphTransform(
  obj: SceneObject,
  gx: number,
  gy: number,
  frames: Frame[],
  fps: number,
  ctx?: ResolveContext,
): Transform {
  const glyphOffset = translation(gx, gy, 0);
  const sampleBaked = (f: Frame) => {
    const lOrig = sampleObjectLocalMatrix(obj, f, fps, ctx);
    return decomposeTrs(multiply(lOrig, glyphOffset));
  };

  return {
    anchor: staticProp({ x: 0, y: 0, z: 0 }),
    position: bakeVec3Channel(frames, (f) => sampleBaked(f).position),
    rotation: bakeVec3Channel(frames, (f) => sampleBaked(f).rotation),
    scale: bakeVec3Channel(frames, (f) => sampleBaked(f).scale),
  };
}

export function cloneAnimatedProp<T>(prop: AnimatedProp<T>): AnimatedProp<T> {
  return {
    value: structuredClone(prop.value),
    keyframes: prop.keyframes.map((k) => ({
      frame: k.frame,
      value: structuredClone(k.value),
      easing: k.easing,
    })),
  };
}
