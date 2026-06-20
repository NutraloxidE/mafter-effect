import type {
  AnimatedProp,
  Easing,
  Frame,
  Keyframe,
  ObjectId,
  SceneObject,
  TimelineComposition,
  Transform,
  Vec3,
} from "../core/schema";
import { sampleVec3 } from "../runtime/interpolate";
import type { ResolveContext } from "../runtime/resolve";
import { decomposeTrs, identity, invert, multiply, transformPoint, translation } from "../runtime/mat4";
import { computeWorldTransforms } from "./previewViewer";

const LINEAR: Easing = { type: "linear" };

function setVec3Keyframe(
  prop: AnimatedProp<Vec3>,
  frame: Frame,
  value: Vec3,
): AnimatedProp<Vec3> {
  if (prop.keyframes.length === 0) {
    return { ...prop, value };
  }
  const existing = prop.keyframes.findIndex((k) => k.frame === frame);
  const kf: Keyframe<Vec3> = { frame, value, easing: LINEAR };
  if (existing >= 0) {
    const kfs = [...prop.keyframes];
    kfs[existing] = kf;
    return { ...prop, keyframes: kfs };
  }
  const kfs = [...prop.keyframes, kf].sort((a, b) => a.frame - b.frame);
  return { ...prop, keyframes: kfs };
}

/** §21.8: 親変更時に world transform を維持する patch を生成（編集時のみ・INV-1 不変）。 */
export function buildReparentPatch(
  comp: TimelineComposition,
  obj: SceneObject,
  newParentId: ObjectId | null,
  frame: Frame,
  ctx?: ResolveContext,
): { parent: ObjectId | null; transform: Transform } | null {
  if (obj.parent === newParentId) return null;

  const worlds = computeWorldTransforms(comp, frame, ctx);
  const wChild = worlds.get(obj.id);
  if (!wChild) return null;

  if (newParentId !== null && !worlds.has(newParentId)) return null;

  const wParentNew = newParentId ? worlds.get(newParentId)! : identity();
  const invParent = invert(wParentNew);
  if (!invParent) return null;

  const lNew = multiply(invParent, wChild);
  const anchor = sampleVec3(obj.transform.anchor, frame);
  const decomposed = decomposeTrs(multiply(lNew, translation(anchor.x, anchor.y, anchor.z)));

  return {
    parent: newParentId,
    transform: {
      anchor: obj.transform.anchor,
      position: setVec3Keyframe(obj.transform.position, frame, decomposed.position),
      rotation: setVec3Keyframe(obj.transform.rotation, frame, decomposed.rotation),
      scale: setVec3Keyframe(obj.transform.scale, frame, decomposed.scale),
    },
  };
}

/** テスト用: comp 上の layer 原点 world 位置。 */
export function worldOriginAtFrame(
  comp: TimelineComposition,
  objectId: ObjectId,
  frame: Frame,
  ctx?: ResolveContext,
): Vec3 | null {
  const world = computeWorldTransforms(comp, frame, ctx).get(objectId);
  if (!world) return null;
  return transformPoint(world, { x: 0, y: 0, z: 0 });
}
