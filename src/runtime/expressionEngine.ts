import type { AnimatedProp, Frame, ObjectId, TimelineComposition, Vec3 } from "../core/schema";
import { sampleScalar, sampleVec3 } from "./interpolate";
import { identity, localMatrix, multiply } from "./mat4";
import type { Mat4 } from "./mat4";
import type { IModuleLoader } from "./moduleLoader";
import type { ExpressionEvaluator } from "./resolve";
import {
  clamp,
  easeRemap,
  lerp,
  linearRemap,
  seededOnce,
  wiggleNumber,
  wiggleVec3,
} from "./exprHelpers";

// §9 ExprContext — expression 関数に渡す実行コンテキスト。
// 全ての helper は決定論的（INV-1）。Math.random / Date.now / DOM / network 禁止。

export interface ExprObjectView {
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
  readonly anchor: Vec3;
  readonly opacity: number;
  param(componentType: string, key: string): unknown;
  toWorld(p: Vec3): Vec3;
  toComp(p: Vec3): Vec3; // alias
}

export interface ExprCompView {
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  object(idOrName: string): ExprObjectView | null;
}

// T は scalar(number) か Vec3 のみ想定（§9）。
export interface ExprContext<T> {
  readonly frame: number;
  readonly time: number; // frame / fps
  readonly fps: number;
  readonly value: T;
  readonly thisObject: ExprObjectView;
  readonly comp: ExprCompView;
  // 決定論ヘルパー (INV-1)
  random(seed?: number): number;
  wiggle(freq: number, amp: number, seed?: number): T;
  linear(t: number, tMin: number, tMax: number, vMin: number, vMax: number): number;
  ease(t: number, tMin: number, tMax: number, vMin: number, vMax: number): number;
  clamp(v: number, lo: number, hi: number): number;
  lerp(a: number, b: number, t: number): number;
}

// ─── World matrix helper (expression 内の toWorld/toComp 用) ─────────────────
// resolve() の内部キャッシュとは独立して計算する。
// expression 評価前の生サンプル値（non-expression）を使うことで再帰を防ぐ。

function buildWorldMatrix(
  objectId: ObjectId,
  comp: TimelineComposition,
  frame: Frame,
): Mat4 {
  const byId = new Map<ObjectId, (typeof comp.objects)[number]>();
  for (const o of comp.objects) byId.set(o.id, o);

  const cache = new Map<ObjectId, Mat4>();
  const visiting = new Set<ObjectId>();

  function worldOf(id: ObjectId): Mat4 {
    const hit = cache.get(id);
    if (hit) return hit;
    const obj = byId.get(id);
    if (!obj) return identity();
    if (visiting.has(id)) return identity();
    visiting.add(id);
    const local = localMatrix(
      sampleVec3(obj.transform.anchor, frame),
      sampleVec3(obj.transform.position, frame),
      sampleVec3(obj.transform.rotation, frame),
      sampleVec3(obj.transform.scale, frame),
    );
    const world =
      obj.parent && byId.has(obj.parent) ? multiply(worldOf(obj.parent), local) : local;
    visiting.delete(id);
    cache.set(id, world);
    return world;
  }

  return worldOf(objectId);
}

// 4×4 行列で Vec3 を変換（w=1 の同次座標）
function applyMat4(m: Mat4, p: Vec3): Vec3 {
  const x = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
  const y = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
  const z = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14];
  return { x, y, z };
}

// ─── ExprObjectView factory ──────────────────────────────────────────────────

function makeObjectView(
  objectId: ObjectId,
  comp: TimelineComposition,
  frame: Frame,
): ExprObjectView {
  const obj = comp.objects.find((o) => o.id === objectId);
  const position = obj ? sampleVec3(obj.transform.position, frame) : { x: 0, y: 0, z: 0 };
  const rotation = obj ? sampleVec3(obj.transform.rotation, frame) : { x: 0, y: 0, z: 0 };
  const scale = obj ? sampleVec3(obj.transform.scale, frame) : { x: 1, y: 1, z: 1 };
  const anchor = obj ? sampleVec3(obj.transform.anchor, frame) : { x: 0, y: 0, z: 0 };
  const opacity = obj ? sampleScalar(obj.opacity, frame) : 1;

  const worldMat = buildWorldMatrix(objectId, comp, frame);

  return {
    position,
    rotation,
    scale,
    anchor,
    opacity,
    param(componentType: string, key: string): unknown {
      if (!obj) return undefined;
      const c = obj.components.find((c) => c.type === componentType);
      if (!c) return undefined;
      const v = c.props[key];
      if (isAnimatedProp(v)) return sampleScalar(v as AnimatedProp<number>, frame);
      return v;
    },
    toWorld(p: Vec3): Vec3 {
      return applyMat4(worldMat, p);
    },
    toComp(p: Vec3): Vec3 {
      return applyMat4(worldMat, p);
    },
  };
}

// ─── ExprCompView factory ────────────────────────────────────────────────────

function makeCompView(comp: TimelineComposition, frame: Frame): ExprCompView {
  return {
    duration: comp.duration,
    width: comp.width,
    height: comp.height,
    object(idOrName: string): ExprObjectView | null {
      const found = comp.objects.find((o) => o.id === idOrName || o.name === idOrName);
      if (!found) return null;
      return makeObjectView(found.id, comp, frame);
    },
  };
}

// ─── ExprContext builder ─────────────────────────────────────────────────────

function buildContext<T>(
  frame: Frame,
  fps: number,
  value: T,
  objectId: ObjectId,
  comp: TimelineComposition,
): ExprContext<T> {
  const thisObject = makeObjectView(objectId, comp, frame);
  const compView = makeCompView(comp, frame);
  const isVec = typeof value === "object" && value !== null && "x" in value;

  return {
    frame,
    time: frame / fps,
    fps,
    value,
    thisObject,
    comp: compView,

    random(seed = frame): number {
      return seededOnce((seed * 9301 + 49297) >>> 0);
    },

    wiggle(freq: number, amp: number, seed = 0): T {
      if (isVec) {
        return wiggleVec3(value as unknown as Vec3, frame, fps, freq, amp, seed) as unknown as T;
      }
      return wiggleNumber(value as unknown as number, frame, fps, freq, amp, seed) as unknown as T;
    },

    linear: linearRemap,
    ease: easeRemap,
    clamp,
    lerp,
  };
}

function isAnimatedProp(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    "value" in v &&
    "keyframes" in v &&
    Array.isArray((v as Record<string, unknown>).keyframes)
  );
}

// ─── ExpressionEngine ────────────────────────────────────────────────────────
// 使い方:
//   1. engine.prepare(comp) を await する（非同期 module ロード）
//   2. engine.makeEvaluator(comp) で sync ExpressionEvaluator を取得
//   3. resolve(comp, frame, { expressions: evaluator }) に渡す

export class ExpressionEngine {
  private readonly loaded = new Map<string, (ctx: unknown) => unknown>();

  constructor(private readonly loader: IModuleLoader) {}

  /** comp 内の全 expression ファイルを preload する（非同期）。 */
  async prepare(comp: TimelineComposition): Promise<void> {
    const paths = collectExprPaths(comp);
    await Promise.all(
      [...paths].map(async (path) => {
        if (this.loaded.has(path)) return;
        const fn = await this.loader.load(path);
        if (fn) this.loaded.set(path, fn);
      }),
    );
  }

  /** preload 済みモジュールを使う sync ExpressionEvaluator を返す（resolve に渡す）。 */
  makeEvaluator(comp: TimelineComposition): ExpressionEvaluator {
    const loaded = this.loaded;
    const fps = comp.fps;

    return function evaluator({ path, frame, value, objectId }) {
      const fn = loaded.get(path);
      if (!fn) return value;
      const ctx = buildContext(frame, fps, value, objectId, comp);
      return fn(ctx);
    };
  }

  /** 指定ファイルのキャッシュを破棄する（ファイル保存時等）。 */
  invalidate(path: string): void {
    this.loaded.delete(path);
    this.loader.invalidate(path);
  }

  /** 全キャッシュクリア。 */
  clear(): void {
    this.loaded.clear();
    this.loader.clear();
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function collectExprPaths(comp: TimelineComposition): Set<string> {
  const paths = new Set<string>();
  for (const obj of comp.objects) {
    addIfEnabled(obj.opacity.expression, paths);
    for (const key of ["anchor", "position", "rotation", "scale"] as const) {
      addIfEnabled(obj.transform[key].expression, paths);
    }
    for (const c of obj.components) {
      for (const v of Object.values(c.props)) {
        if (isAnimatedPropWithExpr(v)) {
          const ap = v as AnimatedProp<unknown>;
          addIfEnabled(ap.expression, paths);
        }
      }
    }
  }
  return paths;
}

function addIfEnabled(
  ref: { path: string; enabled: boolean } | undefined,
  paths: Set<string>,
): void {
  if (ref?.enabled) paths.add(ref.path);
}

function isAnimatedPropWithExpr(v: unknown): boolean {
  return (
    isAnimatedProp(v) &&
    (v as AnimatedProp<unknown>).expression !== undefined
  );
}
