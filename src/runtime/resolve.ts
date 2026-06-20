import type {
  AnimatedProp,
  Component,
  EffectInstance,
  Frame,
  ObjectId,
  SceneObject,
  TimelineComposition,
  Transform,
  Vec3,
} from "../core/schema";
import { sampleAny, sampleScalar, sampleVec3 } from "./interpolate";
import { identity, invert, localMatrix, multiply, type Mat4 } from "./mat4";
import type { ResolvedComponent, ResolvedEffect, ResolvedObject, ResolvedScene } from "./resolved";

// §6.3 / §8 resolve(comp, frame): 純関数 (INV-1)。
// parent チェーンを畳んで各オブジェクトに world 行列を焼き込み、フラットな ResolvedScene を返す。
// Math.random / Date.now / DOM / network 禁止。frame は整数 (INV-5)。

// ─────────────────────────────────────────────────────────────────────────
// §9 expression 評価の凍結シーム（M2 で実体を渡す）。
//
//   設計決定（凍結ゲート）: resolve は **同期・純粋** のまま保つ。expression の
//   JS module ロード（§11.3, blob URL + dynamic import, 非同期）は resolve の外で
//   事前に行い、ロード済みの純関数を ExpressionEvaluator として注入する。
//   - expression があれば keyframe/static 解決値を上書きする（§5.2）。評価前の値は
//     `value`（ctx.value）として渡る（§9）。
//   - 評価が throw / 不正型なら **その frame・その prop は value にフォールバック**し
//     レンダリングは止めない（§9 確定フォールバック）。
//   - INV-1: resolve は evaluator が純粋である限り純粋。M2 が §11.3 loader + 凍結 ctx +
//     §16 ハードニング（乱数/時刻/DOM/network 検出）で evaluator の純粋性を担保する。
// ─────────────────────────────────────────────────────────────────────────
export interface ExpressionEvalArgs {
  path: string; // scripts/<objectId>/<param>.js（ExpressionRef.path）
  frame: Frame;
  fps: number;
  value: unknown; // expression 適用前の解決値（= ctx.value）
  objectId: ObjectId;
}

export type ExpressionEvaluator = (args: ExpressionEvalArgs) => unknown;

export interface ResolveContext {
  /** 事前ロード済み expression 評価関数（§9 / §11.3）。未指定なら expression は無視され keyframe/static 値が使われる。 */
  expressions?: ExpressionEvaluator;
}

function resolverFor(comp: TimelineComposition, ctx: ResolveContext | undefined) {
  const fps = comp.fps;
  const evaluator = ctx?.expressions;

  /** expression があれば適用、throw/未提供なら sampled にフォールバック（§9）。 */
  function applyExpr<T>(
    prop: AnimatedProp<T>,
    sampled: T,
    frame: Frame,
    objectId: ObjectId,
  ): T {
    const ex = prop.expression;
    if (!ex?.enabled || !evaluator) return sampled;
    try {
      const r = evaluator({ path: ex.path, frame, fps, value: sampled, objectId });
      // 型検証は M2（§9 戻り値型一致）。MVP は trusted-author 前提でそのまま採用。
      return r as T;
    } catch {
      return sampled; // §9 フォールバック
    }
  }

  function vec3Prop(prop: AnimatedProp<Vec3>, frame: Frame, objectId: ObjectId): Vec3 {
    return applyExpr(prop, sampleVec3(prop, frame), frame, objectId);
  }

  function scalarProp(prop: AnimatedProp<number>, frame: Frame, objectId: ObjectId): number {
    return applyExpr(prop, sampleScalar(prop, frame), frame, objectId);
  }

  function localOf(transform: Transform, frame: Frame, objectId: ObjectId): Mat4 {
    return localMatrix(
      vec3Prop(transform.anchor, frame, objectId),
      vec3Prop(transform.position, frame, objectId),
      vec3Prop(transform.rotation, frame, objectId),
      vec3Prop(transform.scale, frame, objectId),
    );
  }

  function resolveComponent(c: Component, frame: Frame, objectId: ObjectId, objInPoint: Frame = 0): ResolvedComponent {
    const props: Record<string, unknown> = {};
    for (const key of Object.keys(c.props)) {
      const raw = c.props[key];
      const sampled = sampleAny(raw, frame);
      // AnimatedProp で expression を持つ場合のみ評価を上書き。
      props[key] = isAnimatedProp(raw)
        ? applyExpr(raw, sampled, frame, objectId)
        : sampled;
    }
    // comp type: DomRenderer が子フレームを計算できるよう層の inPoint を注入する。
    if (c.type === "comp") props["_inPoint"] = objInPoint;
    props["_hostInPoint"] = objInPoint;
    const out: ResolvedComponent = { type: c.type, props };
    if (c.exportStrategy !== undefined) out.exportStrategy = c.exportStrategy;
    return out;
  }

  function resolveEffect(e: EffectInstance, frame: Frame, objectId: ObjectId): ResolvedEffect {
    const props: Record<string, unknown> = {};
    for (const key of Object.keys(e.props)) {
      const raw = e.props[key];
      const sampled = sampleAny(raw, frame);
      props[key] = isAnimatedProp(raw)
        ? applyExpr(raw, sampled, frame, objectId)
        : sampled;
    }
    return { type: e.type, enabled: e.enabled, props };
  }

  return { scalarProp, localOf, resolveComponent, resolveEffect };
}

function isAnimatedProp(v: unknown): v is AnimatedProp<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    "value" in v &&
    "keyframes" in v &&
    Array.isArray((v as AnimatedProp<unknown>).keyframes)
  );
}

function isVisible(obj: SceneObject, frame: Frame): boolean {
  return obj.enabled && frame >= obj.inPoint && frame < obj.outPoint;
}

export function resolve(
  comp: TimelineComposition,
  frame: Frame,
  ctx?: ResolveContext,
): ResolvedScene {
  const { scalarProp, localOf, resolveComponent, resolveEffect } = resolverFor(comp, ctx);

  const byId = new Map<ObjectId, SceneObject>();
  for (const obj of comp.objects) byId.set(obj.id, obj);

  // world 行列を全オブジェクトについて計算（parent の可視性に依らず transform は継承される）。
  // load 時検証で循環は排除済み（§5.4-note）だが、安全のため訪問中マークでガードする。
  const worldCache = new Map<ObjectId, Mat4>();
  const visiting = new Set<ObjectId>();

  const worldOf = (id: ObjectId): Mat4 => {
    const cached = worldCache.get(id);
    if (cached) return cached;
    const obj = byId.get(id);
    if (!obj) return identity();
    if (visiting.has(id)) return identity(); // 異常系: 循環。root 扱いで打ち切り。
    visiting.add(id);

    const local = localOf(obj.transform, frame, id);
    const world =
      obj.parent && byId.has(obj.parent)
        ? multiply(worldOf(obj.parent), local) // W_child = W_parent · L_child
        : local;

    visiting.delete(id);
    worldCache.set(id, world);
    return world;
  };

  const objects: ResolvedObject[] = [];
  for (const obj of comp.objects) {
    if (!isVisible(obj, frame)) continue;
    const resolved: ResolvedObject = {
      id: obj.id,
      worldTransform: worldOf(obj.id),
      zOrder: obj.zOrder,
      opacity: scalarProp(obj.opacity, frame, obj.id),
      inPoint: obj.inPoint,
      components: obj.isAdjustment || obj.isNull
        ? []
        : obj.components.map((c) => resolveComponent(c, frame, obj.id, obj.inPoint)),
    };
    if (obj.effects && obj.effects.length > 0) {
      resolved.effects = obj.effects.map((e) => resolveEffect(e, frame, obj.id));
    }
    if (obj.isAdjustment) resolved.isAdjustment = true;
    if (obj.isAdjustment && obj.adjustmentMode) resolved.adjustmentMode = obj.adjustmentMode;
    if (obj.isNull) resolved.isNull = true;
    objects.push(resolved);
  }

  // zOrder 昇順（小→奥）。安定ソートのため tie は id で割る。
  objects.sort((a, b) =>
    a.zOrder !== b.zOrder ? a.zOrder - b.zOrder : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const scene: ResolvedScene = {
    width: comp.width,
    height: comp.height,
    objects,
  };

  // active camera: viewMatrix = world の逆（§6.5）。
  if (comp.activeCamera && byId.has(comp.activeCamera)) {
    const camObj = byId.get(comp.activeCamera)!;
    const view = invert(worldOf(camObj.id));
    if (view) {
      const cameraComp = camObj.components.find((c) => c.type === "camera");
      const fovRaw = cameraComp ? sampleAny(cameraComp.props.fov, frame) : undefined;
      const fov = typeof fovRaw === "number" ? fovRaw : 50;
      scene.camera = { fov, viewMatrix: view };
    }
  }

  return scene;
}
