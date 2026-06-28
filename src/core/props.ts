import type { AnimatedProp, Transform, Vec3 } from "./schema";

// AnimatedProp / Transform のデフォルト生成ヘルパー。
// キーフレームが空のとき value が使われる（§5.2）。

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function staticProp<T>(value: T): AnimatedProp<T> {
  return { value, keyframes: [] };
}

export function defaultTransform(): Transform {
  return {
    anchor: staticProp(vec3(0, 0, 0)),
    position: staticProp(vec3(0, 0, 0)),
    rotation: staticProp(vec3(0, 0, 0)),
    scale: staticProp(vec3(1, 1, 1)),
  };
}

/** AE 風 — 有効な expression が値を上書きしている AnimatedProp。 */
export function isPropExpressed(prop: AnimatedProp<unknown>): boolean {
  return prop.expression?.enabled === true;
}

export const EXPRESSED_VALUE_COLOR = "#f55";
