import type { ObjectId } from "../core/schema";
import type { Mat4 } from "./mat4";

// §8 resolve() の出力。レンダラはこれだけを受け取る (INV-3)。フラット・兄弟・ネストしない。

export interface ResolvedComponent {
  type: string;
  props: Record<string, unknown>; // frame で解決済みの具体値（AnimatedProp → 値）
  exportStrategy?: "live" | "bake";
}

export interface ResolvedEffect {
  type: string;
  enabled: boolean;
  props: Record<string, unknown>;
}

export interface ResolvedObject {
  id: ObjectId;
  worldTransform: Mat4; // parent チェーンを畳んだ world 行列（§6.3）。ネストしない
  zOrder: number; // 描画順
  opacity: number; // per-object。親から継承しない
  components: ResolvedComponent[];
  effects?: ResolvedEffect[];
  isAdjustment?: boolean;
}

export interface ResolvedScene {
  width: number;
  height: number;
  // camera world 変換の逆（§6.5）。無ければ正射影。
  camera?: { fov: number; viewMatrix: Mat4 };
  objects: ResolvedObject[]; // zOrder 昇順でソート済み（フラット・兄弟）
}
