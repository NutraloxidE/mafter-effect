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
import { normalizeBlendMode } from "../core/blendMode";
import { sampleAny, sampleScalar, sampleVec3 } from "./interpolate";
import { identity, invert, localMatrix, lookAt, multiply, type Mat4 } from "./mat4";
import type { ResolvedComponent, ResolvedEffect, ResolvedObject, ResolvedScene } from "./resolved";
import { autoFadeMultiplierAtFrame, collectFadeClips, computeFadeSuppression, isAutoFadeEnabled } from "./footageAutoFade";

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
  /**
   * §6.5 プレビュー視点 override（エディタ専用・非永続）。AE の 3D View ポップアップ相当。
   * 未指定（既定）= その frame で最前面の可視カメラを自動選択（出力・export と一致）。
   * `ObjectId` = そのカメラを強制。`"default"` = カメラ無し（デフォルト視点）を強制。
   * export / bundle / nested comp は渡さない（INV-2: 出力は常に自動選択で決定論的）。
   */
  previewCamera?: ObjectId | "default";
}

/**
 * §6.5 その frame で出力に使われるカメラオブジェクトを返す（純関数・INV-1）。
 * 条件: camera component を持ち `isVisible(obj, frame)`。複数なら最大 zOrder（最前面）、タイは id で安定化。
 * 該当が無ければ null（= デフォルト視点）。
 */
export function activeCameraAt(comp: TimelineComposition, frame: Frame): SceneObject | null {
  let best: SceneObject | null = null;
  for (const obj of comp.objects) {
    if (!isVisible(obj, frame)) continue;
    if (!obj.components.some((c) => c.type === "camera")) continue;
    if (
      best === null ||
      obj.zOrder > best.zOrder ||
      (obj.zOrder === best.zOrder && obj.id > best.id)
    ) {
      best = obj;
    }
  }
  return best;
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
    // comp type: DomRenderer が子フレームを計算できるよう層の inPoint と
    // 親コンプ fps を注入する（§23.2 秒ベース時間マッピング）。fps は解決中コンプの
    // 値なので、マウント時スナップショット（this.currentComp）に依存せず常に最新。
    if (c.type === "comp") {
      props["_inPoint"] = objInPoint;
      props["_parentFps"] = fps;
    }
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

function isVec3ish(v: unknown): v is Vec3 {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Vec3).x === "number" &&
    typeof (v as Vec3).y === "number" &&
    typeof (v as Vec3).z === "number"
  );
}

/** §6.5b カメラ垂直画角[deg]。zoom(px) を優先、無ければ旧 fov、既定 50。 */
function cameraFovDeg(cameraComp: Component, frame: Frame, height: number): number {
  const zoom = sampleAny(cameraComp.props.zoom, frame);
  if (typeof zoom === "number" && zoom > 0) {
    return (2 * Math.atan(height / 2 / zoom) * 180) / Math.PI;
  }
  const fov = sampleAny(cameraComp.props.fov, frame);
  return typeof fov === "number" ? fov : 50;
}

/** §5.4b 実効描画経路を解決（threeD 時のみ）。 */
function effective3dMode(
  obj: SceneObject,
  renderer3d: "classic" | "advanced",
): "dom" | "raster3d" | undefined {
  if (obj.threeD !== true) return undefined;
  const mode = obj.threeDMode ?? "auto";
  if (mode === "dom") return "dom";
  if (mode === "raster3d") return "raster3d";
  return renderer3d === "advanced" ? "raster3d" : "dom"; // auto
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

  const renderer3d = comp.renderer3d ?? "classic";
  // §11.5.2 declick: video 内蔵音声の gain に焼き込むカット端フェードの抑制判定（§11.4 シームレス境界は抑制）。
  // audio comp は clocks/exporter 側、export video 音声は buildAudioMix 側で同一純関数を使う（INV-2）。
  const fadeSuppression = computeFadeSuppression(collectFadeClips(comp));
  const objects: ResolvedObject[] = [];
  for (const obj of comp.objects) {
    if (!isVisible(obj, frame)) continue;
    const resolved: ResolvedObject = {
      id: obj.id,
      worldTransform: worldOf(obj.id),
      zOrder: obj.zOrder,
      opacity: scalarProp(obj.opacity, frame, obj.id),
      blendMode: normalizeBlendMode(obj.blendMode),
      inPoint: obj.inPoint,
      components: obj.isAdjustment || obj.isNull
        ? []
        : obj.components.map((c) => resolveComponent(c, frame, obj.id, obj.inPoint)),
    };
    // §11.5.2 declick: video 内蔵音声の gain にカット端フェードを乗算（preview/bundle の video.volume）。
    for (const rc of resolved.components) {
      if (rc.type !== "video" || !isAutoFadeEnabled(rc.props)) continue;
      const g = typeof rc.props["gain"] === "number" ? (rc.props["gain"] as number) : 1;
      const m = autoFadeMultiplierAtFrame(frame, {
        inPoint: obj.inPoint,
        outPoint: obj.outPoint,
        fps: comp.fps,
        suppression: fadeSuppression.get(obj.id),
      });
      rc.props["gain"] = g * m;
    }
    if (obj.effects && obj.effects.length > 0) {
      resolved.effects = obj.effects.map((e) => resolveEffect(e, frame, obj.id));
    }
    if (obj.isAdjustment) resolved.isAdjustment = true;
    if (obj.isAdjustment && obj.adjustmentMode) resolved.adjustmentMode = obj.adjustmentMode;
    if (obj.isNull) resolved.isNull = true;
    const mode3d = effective3dMode(obj, renderer3d); // §5.4b
    if (mode3d) {
      resolved.threeD = true;
      resolved.mode3d = mode3d;
    }
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

  // active camera（§6.5 / §6.5b）。one-node: view = world の逆。two-node: lookAt で注視点を向く。
  // 出力カメラは「その frame で最前面の可視カメラ」を自動選択（AE 準拠）。エディタは previewCamera で上書き可。
  const previewCam = ctx?.previewCamera;
  const camObj =
    previewCam === "default"
      ? null
      : typeof previewCam === "string"
        ? (byId.get(previewCam) ?? null)
        : activeCameraAt(comp, frame);
  // override 指定カメラも「camera component を持ち可視」でなければデフォルト視点に倒す。
  if (camObj && isVisible(camObj, frame) && camObj.components.some((c) => c.type === "camera")) {
    const camWorld = worldOf(camObj.id);
    const cameraComp = camObj.components.find((c) => c.type === "camera");
    const camType = cameraComp ? sampleAny(cameraComp.props.cameraType, frame) : undefined;
    let view: Mat4 | null;
    if (camType === "two-node" && cameraComp) {
      const eye: Vec3 = { x: camWorld[12], y: camWorld[13], z: camWorld[14] };
      const poiRaw = sampleAny(cameraComp.props.pointOfInterest, frame);
      const poi = isVec3ish(poiRaw) ? poiRaw : { x: 0, y: 0, z: 0 };
      // up=+y: 真下視で view = invert(translate(eye))（= one-node 規約）に一致し、X 反転しない。
      view = lookAt(eye, poi, { x: 0, y: 1, z: 0 });
    } else {
      view = invert(camWorld);
    }
    if (view) {
      const fov = cameraComp ? cameraFovDeg(cameraComp, frame, comp.height) : 50;
      scene.camera = { fov, viewMatrix: view };
    }
  }

  return scene;
}
