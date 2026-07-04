import type { BlendMode, Frame, ObjectId, TrackMatteMode } from "../core/schema";
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
  blendMode: BlendMode; // §5.4d 描画モード。既定 "normal"。補間しない（純粋）
  inPoint: Frame; // この comp 内での表示開始（§28.10 per-layer cache の local frame 算出用 passthrough）
  components: ResolvedComponent[];
  effects?: ResolvedEffect[];
  isAdjustment?: boolean;
  adjustmentMode?: "live" | "raster";
  isNull?: boolean;
  threeD?: boolean; // §5.4b 3D 空間に配置
  mode3d?: "dom" | "raster3d"; // §5.4b 実効描画経路（threeD 時のみ）。resolve で確定
  /** §5.4f 塗り側トラックマット（有効ペアのみ）。マット非可視フレームでも残る（空マット）。 */
  trackMatte?: { mode: TrackMatteMode; matteId: ObjectId };
  /** §5.4f 当該フレームでマット源として描画するが最終合成には出さない。 */
  isTrackMatteSource?: boolean;
}

export interface ResolvedScene {
  width: number;
  height: number;
  // camera world 変換の逆（§6.5）。無ければ正射影。
  camera?: { fov: number; viewMatrix: Mat4 };
  objects: ResolvedObject[]; // zOrder 昇順でソート済み（フラット・兄弟）
}
