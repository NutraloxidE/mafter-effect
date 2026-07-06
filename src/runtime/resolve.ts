import type {
  AnimatedProp,
  BooleanMergeInput,
  Component,
  EffectInstance,
  Frame,
  ObjectId,
  SceneObject,
  ShapeVertex,
  TimelineComposition,
  Transform,
  Vec3,
} from "../core/schema";
import { normalizeBlendMode } from "../core/blendMode";
import { resolveTrackMattePairs } from "../core/trackMatte";
import { sampleAny, sampleScalar, sampleVec3 } from "./interpolate";
import { identity, invert, localMatrix, lookAt, multiply, transformPoint, type Mat4 } from "./mat4";
import type { ResolvedComponent, ResolvedEffect, ResolvedObject, ResolvedScene } from "./resolved";
import { autoFadeMultiplierAtFrame, collectFadeClips, computeFadeSuppression, isAutoFadeEnabled } from "./footageAutoFade";
import { ellipseToRing, flattenVerticesToRing, rectToRing } from "./shapePathBoolean";
import type { Ring } from "polygon-clipping";
import type { ResolvedShapeVertex } from "./shapePath";

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

  const byId = new Map<ObjectId, SceneObject>();
  for (const obj of comp.objects) byId.set(obj.id, obj);

  // world 行列を全オブジェクトについて計算（parent の可視性に依らず transform は継承される）。
  // §5.5d merge の cross-object 参照からも参照先の world を引けるよう resolveComponent と同じ
  // クロージャに置く（旧: resolve() 側で個別構築していたが、resolveComponent がここへ移った際に統合）。
  const worldCache = new Map<ObjectId, Mat4>();
  const visiting = new Set<ObjectId>();

  const worldOf = (id: ObjectId, frame: Frame): Mat4 => {
    const cached = worldCache.get(id);
    if (cached) return cached;
    const obj = byId.get(id);
    if (!obj) return identity();
    if (visiting.has(id)) return identity(); // 異常系: 循環。root 扱いで打ち切り。
    visiting.add(id);

    const local = localOf(obj.transform, frame, id);
    const world =
      obj.parent && byId.has(obj.parent)
        ? multiply(worldOf(obj.parent, frame), local) // W_child = W_parent · L_child
        : local;

    visiting.delete(id);
    worldCache.set(id, world);
    return world;
  };

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

  function resolveShapeVertices(vertices: ShapeVertex[], frame: Frame, objectId: ObjectId) {
    return vertices.map((v) => ({
      id: v.id,
      pos: vec3Prop(v.pos, frame, objectId),
      ...(v.inTangent !== undefined ? { inTangent: vec3Prop(v.inTangent, frame, objectId) } : {}),
      ...(v.outTangent !== undefined ? { outTangent: vec3Prop(v.outTangent, frame, objectId) } : {}),
    }));
  }

  /** resolve 済み shape props（kind + vertices/size）から局所空間のポリゴン輪を得る（merge 入力用）。 */
  function shapeGeometryToRing(kind: unknown, props: Record<string, unknown>): Ring {
    if (kind === "path") {
      const vertices = props["vertices"];
      return Array.isArray(vertices) ? flattenVerticesToRing(vertices as ResolvedShapeVertex[]) : [];
    }
    const size = props["size"] as { x: number; y: number } | undefined;
    if (!size) return [];
    return kind === "ellipse" ? ellipseToRing(size) : rectToRing(size);
  }

  /**
   * §5.5d merge 入力1件を「host（merge shape 自身）のローカル空間」のポリゴン輪へ解決する。
   * 参照先が存在しない・shape でない・kind="merge"（循環防止）なら null。
   */
  function resolveMergeInputRing(
    mi: BooleanMergeInput,
    frame: Frame,
    hostObjectId: ObjectId,
  ): { op: BooleanMergeInput["op"]; ring: Ring } | null {
    const inputObj = byId.get(mi.objectId);
    if (!inputObj) return null;
    const shapeComp = inputObj.components.find((c) => c.type === "shape");
    if (!shapeComp || shapeComp.props["kind"] === "merge") return null;
    const resolvedInput = resolveComponent(shapeComp, frame, mi.objectId);
    const localRing = shapeGeometryToRing(resolvedInput.props["kind"], resolvedInput.props);
    if (localRing.length < 3) return null;

    const hostInv = invert(worldOf(hostObjectId, frame));
    if (!hostInv) return null;
    const relative = multiply(hostInv, worldOf(mi.objectId, frame));
    const ring: Ring = localRing.map(([x, y]) => {
      const p = transformPoint(relative, { x, y, z: 0 });
      return [p.x, p.y];
    });
    return { op: mi.op, ring };
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
    // §5.5c shape kind="path": vertices は「AnimatedProp を含むオブジェクトの配列」であり
    // 上のループ（トップレベル AnimatedProp のみ判定）では中身が resolve されないため個別に処理する。
    if (c.type === "shape" && Array.isArray(c.props["vertices"])) {
      props["vertices"] = resolveShapeVertices(c.props["vertices"] as ShapeVertex[], frame, objectId);
    }
    // §5.5e shape kind="path" 複数リング（merge の Bake 出力）: vertices と同様、配列の配列。
    if (c.type === "shape" && Array.isArray(c.props["rings"])) {
      props["rings"] = (c.props["rings"] as ShapeVertex[][]).map((ring) => resolveShapeVertices(ring, frame, objectId));
    }
    // §5.5d shape kind="merge": mergeInputs は他 SceneObject への参照（Illustrator Pathfinder 相当）。
    // 各参照先の shape ジオメトリを resolveComponent で再帰的に解決し、参照先の world 行列 →
    // このオブジェクト自身の world 行列の逆、で「このオブジェクトのローカル空間」へ座標変換する。
    if (c.type === "shape" && c.props["kind"] === "merge" && Array.isArray(c.props["mergeInputs"])) {
      const mergeInputs = c.props["mergeInputs"] as BooleanMergeInput[];
      props["resolvedMergeRings"] = mergeInputs
        .map((mi) => resolveMergeInputRing(mi, frame, objectId))
        .filter((r): r is { op: BooleanMergeInput["op"]; ring: Ring } => r !== null);
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

  return { scalarProp, localOf, resolveComponent, resolveEffect, worldOf, byId };
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
  const { scalarProp, resolveComponent, resolveEffect, worldOf, byId } = resolverFor(comp, ctx);

  const renderer3d = comp.renderer3d ?? "classic";
  // §5.4f: enabled スタックで直上ペアをフレーム非依存に決定。
  const trackMattePairs = resolveTrackMattePairs(comp.objects);
  const trackMatteByFill = new Map(trackMattePairs.map((p) => [p.fillId, p]));
  const trackMatteSourceIds = new Set(trackMattePairs.map((p) => p.matteId));
  // §5.5d merge の入力として参照されたオブジェクトは自身の通常描画から除外する（AE/Illustrator の
  // Pathfinder 同様、合成結果としてのみ見える）。参照集合は frame に依らない構造的なものなので
  // frame ループの外で一度だけ求める（trackMattePairs と同じ扱い）。
  const mergeInputSourceIds = new Set<ObjectId>();
  for (const obj of comp.objects) {
    for (const c of obj.components) {
      if (c.type !== "shape" || c.props["kind"] !== "merge") continue;
      const mergeInputs = c.props["mergeInputs"];
      if (!Array.isArray(mergeInputs)) continue;
      for (const mi of mergeInputs as BooleanMergeInput[]) {
        if (mi.objectId) mergeInputSourceIds.add(mi.objectId);
      }
    }
  }
  // §11.5.2 declick: video 内蔵音声の gain に焼き込むカット端フェードの抑制判定（§11.4 シームレス境界は抑制）。
  // audio comp は clocks/exporter 側、export video 音声は buildAudioMix 側で同一純関数を使う（INV-2）。
  const fadeSuppression = computeFadeSuppression(collectFadeClips(comp));
  const objects: ResolvedObject[] = [];
  for (const obj of comp.objects) {
    if (!isVisible(obj, frame) || mergeInputSourceIds.has(obj.id)) continue;
    const pair = trackMatteByFill.get(obj.id);
    const resolved: ResolvedObject = {
      id: obj.id,
      worldTransform: worldOf(obj.id, frame),
      zOrder: obj.zOrder,
      opacity: scalarProp(obj.opacity, frame, obj.id),
      blendMode: normalizeBlendMode(obj.blendMode),
      inPoint: obj.inPoint,
      components: obj.isAdjustment || obj.isNull
        ? []
        : obj.components.map((c) => resolveComponent(c, frame, obj.id, obj.inPoint)),
    };
    if (pair) {
      resolved.trackMatte = { mode: pair.mode, matteId: pair.matteId };
    }
    if (trackMatteSourceIds.has(obj.id)) {
      resolved.isTrackMatteSource = true;
    }
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
    const camWorld = worldOf(camObj.id, frame);
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
