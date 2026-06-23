import type {
  AnimatedProp,
  Frame,
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

type DecomposedTrs = { position: Vec3; rotation: Vec3; scale: Vec3 };

/**
 * §21.8.2: 親変更時に world transform を維持する patch を生成（編集時のみ・INV-1 不変）。
 *
 * child の **全 KF を各 frame で補正**する: 各 frame f で
 *   L_new(f) = invert(W_parentNew(f)) · W_childOld(f)
 * を decompose し、その frame の KF 値へ上書きする。
 * - static 親（Null の常態）→ 定数オフセットなので **全フレーム厳密に world 保持**（KF 間も一致）。
 * - animated 親 → 各 KF frame で保持・KF 間は近似（KF 表現の本質的限界）。
 * - KF が無い（static）チャンネルは現フレームの decompose で `value` を更新する。
 * - KF の easing は保持する（value だけ差し替え）。
 */
export function buildReparentPatch(
  comp: TimelineComposition,
  obj: SceneObject,
  newParentId: ObjectId | null,
  frame: Frame,
  ctx?: ResolveContext,
): { parent: ObjectId | null; transform: Transform } | null {
  if (obj.parent === newParentId) return null;

  // 補正が必要な frame 集合 = child の全 KF frame ∪ 現フレーム。
  const frames = new Set<Frame>([frame]);
  for (const ch of [obj.transform.position, obj.transform.rotation, obj.transform.scale]) {
    for (const kf of ch.keyframes) frames.add(kf.frame);
  }

  // 各 frame で local TRS を decompose してキャッシュ（computeWorldTransforms は frame ごとに 1 回）。
  const decomposedAt = new Map<Frame, DecomposedTrs>();
  for (const f of frames) {
    const worlds = computeWorldTransforms(comp, f, ctx);
    const wChild = worlds.get(obj.id);
    if (!wChild) return null;
    if (newParentId !== null && !worlds.has(newParentId)) return null;

    const wParentNew = newParentId ? worlds.get(newParentId)! : identity();
    const invParent = invert(wParentNew);
    if (!invParent) return null;

    const lNew = multiply(invParent, wChild);
    const anchor = sampleVec3(obj.transform.anchor, f);
    decomposedAt.set(f, decomposeTrs(multiply(lNew, translation(anchor.x, anchor.y, anchor.z))));
  }

  const correctChannel = (
    prop: AnimatedProp<Vec3>,
    pick: (d: DecomposedTrs) => Vec3,
  ): AnimatedProp<Vec3> => {
    if (prop.keyframes.length === 0) {
      // static チャンネル: 現フレームの decompose で value を更新（KF/easing は無し）。
      return { ...prop, value: pick(decomposedAt.get(frame)!) };
    }
    // KF ありチャンネル: 各 KF をその frame で補正（easing 保持・KF 位置不変）。
    const keyframes = prop.keyframes.map((kf) => {
      const d = decomposedAt.get(kf.frame);
      return d ? { ...kf, value: pick(d) } : kf;
    });
    return { ...prop, keyframes };
  };

  return {
    parent: newParentId,
    transform: {
      anchor: obj.transform.anchor,
      position: correctChannel(obj.transform.position, (d) => d.position),
      rotation: correctChannel(obj.transform.rotation, (d) => d.rotation),
      scale: correctChannel(obj.transform.scale, (d) => d.scale),
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
