import type {
  AnimatedProp,
  SceneObject,
  TimelineComposition,
  Vec3,
} from "../core/schema";
import { isAnimatedProp } from "./keyframeEdit";

// §5.6 / §25.2 — Composition 設定（size / fps）編集の純関数。
// store の resizeComp / setCompFps はこれらの薄いラッパ。テストはここを直接叩く。

/** Vec3 AnimatedProp の base 値・全 KF を x/y だけ平行移動する（z 不変）。 */
export function offsetVec3PropXY(
  prop: AnimatedProp<Vec3>,
  dx: number,
  dy: number,
): AnimatedProp<Vec3> {
  if (dx === 0 && dy === 0) return prop;
  const shift = (v: Vec3): Vec3 => ({ x: v.x + dx, y: v.y + dy, z: v.z });
  return {
    ...prop,
    value: shift(prop.value),
    keyframes: prop.keyframes.map((k) => ({ ...k, value: shift(k.value) })),
  };
}

/** 全 KF の frame を round(frame*ratio) にリスケール。丸めで衝突した frame は昇順維持で後勝ち統合。 */
export function rescalePropFrames<T>(
  prop: AnimatedProp<T>,
  ratio: number,
): AnimatedProp<T> {
  if (ratio === 1 || prop.keyframes.length === 0) return prop;
  const byFrame = new Map<number, AnimatedProp<T>["keyframes"][number]>();
  for (const k of prop.keyframes) {
    byFrame.set(Math.round(k.frame * ratio), { ...k, frame: Math.round(k.frame * ratio) });
  }
  const keyframes = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
  return { ...prop, keyframes };
}

/** SceneObject 内の全 AnimatedProp（transform/opacity/component/effect）に変換を適用。 */
function mapObjectProps(
  obj: SceneObject,
  fn: <T>(prop: AnimatedProp<T>) => AnimatedProp<T>,
): SceneObject {
  const mapRecord = (
    props: Record<string, AnimatedProp<unknown> | unknown>,
  ): Record<string, AnimatedProp<unknown> | unknown> => {
    const out: Record<string, AnimatedProp<unknown> | unknown> = {};
    for (const [key, val] of Object.entries(props)) {
      out[key] = isAnimatedProp(val) ? fn(val) : val;
    }
    return out;
  };
  return {
    ...obj,
    transform: {
      anchor: fn(obj.transform.anchor),
      position: fn(obj.transform.position),
      rotation: fn(obj.transform.rotation),
      scale: fn(obj.transform.scale),
    },
    opacity: fn(obj.opacity),
    components: obj.components.map((c) => ({ ...c, props: mapRecord(c.props) })),
    effects: obj.effects?.map((e) => ({ ...e, props: mapRecord(e.props) })),
  };
}

/**
 * 中央基準でリサイズ。parent === null のレイヤーのみ position の x/y を
 * ((newW-oldW)/2, (newH-oldH)/2) 平行移動する（子は parent 継承で追従＝二重移動しない）。
 * width/height は >= 1 の整数に丸める。
 */
export function resizeCompCentered(
  comp: TimelineComposition,
  width: number,
  height: number,
): TimelineComposition {
  const newW = Math.max(1, Math.round(width));
  const newH = Math.max(1, Math.round(height));
  const dx = (newW - comp.width) / 2;
  const dy = (newH - comp.height) / 2;
  if (newW === comp.width && newH === comp.height) return comp;
  const objects =
    dx === 0 && dy === 0
      ? comp.objects
      : comp.objects.map((o) =>
          o.parent === null
            ? { ...o, transform: { ...o.transform, position: offsetVec3PropXY(o.transform.position, dx, dy) } }
            : o,
        );
  return { ...comp, width: newW, height: newH, objects };
}

/**
 * 秒タイミングを維持して fps を変更（再スケール）。ratio = newFps/oldFps で
 * 全 KF frame・各レイヤーの inPoint/outPoint・duration を round(*ratio)。
 * comp コンポーネントの trimStart は子 frame 単位なので変更しない。
 */
export function rescaleCompFps(
  comp: TimelineComposition,
  newFps: number,
): TimelineComposition {
  if (!(newFps > 0)) return comp;
  const ratio = newFps / comp.fps;
  if (ratio === 1) return { ...comp, fps: newFps };
  const objects = comp.objects.map((o) => {
    const mapped = mapObjectProps(o, (prop) => rescalePropFrames(prop, ratio));
    return {
      ...mapped,
      inPoint: Math.round(o.inPoint * ratio),
      outPoint: Math.round(o.outPoint * ratio),
    };
  });
  return {
    ...comp,
    fps: newFps,
    duration: Math.max(1, Math.round(comp.duration * ratio)),
    objects,
  };
}
