// §5 データスキーマ — project.json の中核型。
// この型が SSoT。散文より優先される（CLAUDE.md / spec §0）。

// §5.1 基本型
export type ObjectId = string; // ULID. stable, 表示名とは独立 (INV-6)
export type CompId = string; // ULID
export type AssetId = string; // ULID
export type Frame = number; // 整数 (INV-5)

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
} // 0..1

// §5.3 イージング
export type Easing =
  | { type: "linear" }
  | { type: "hold" } // ステップ補間
  | { type: "bezier"; bezier: [number, number, number, number] } // CSS cubic-bezier 形式
  | { type: "preset"; id: string }; // presets/easing/<id>.json を解決

// §5.2 アニメーション可能プロパティ
export interface ExpressionRef {
  path: string; // scripts/<objectId>/<param>.js への相対パス
  enabled: boolean;
}

export interface Keyframe<T> {
  frame: Frame;
  value: T;
  easing: Easing; // この KF から「次の」KF への区間に適用 (§9)
}

export interface AnimatedProp<T> {
  value: T; // base 値（keyframe が空のとき使用）
  keyframes: Keyframe<T>[]; // frame 昇順。空 = 静的
  expression?: ExpressionRef;
}

// §5.4 Transform / Object
export interface Transform {
  anchor: AnimatedProp<Vec3>; // アンカーポイント
  position: AnimatedProp<Vec3>; // z は CSS-3D 奥行き
  rotation: AnimatedProp<Vec3>; // euler XYZ degrees
  scale: AnimatedProp<Vec3>; // {1,1,1} = 100%
}

// §5.5 Component
export interface Component {
  type: string;
  props: Record<string, AnimatedProp<unknown> | unknown>;
  exportStrategy?: "live" | "bake"; // web bundle export 時の扱い（§11.7）。未指定なら type の既定
}

// §5.5c shape コンポーネント Phase 2（頂点/ベジェパス編集・additive-optional）。
// Component.props.vertices?: ShapeVertex[] に乗る。存在しなければ従来通り kind=rect/ellipse の CSS box。
// tangent は AE 同様「頂点位置からの相対オフセットベクトル」（絶対座標ではない）。
// 頂点順 = パス順（id 昇順ソート対象外。serialize.ts は配列順を保持する）。
export interface ShapeVertex {
  id: string; // ULID (INV-6)
  pos: AnimatedProp<Vec3>;
  inTangent?: AnimatedProp<Vec3>;
  outTangent?: AnimatedProp<Vec3>;
}

// §5.5e shape kind="path" 複数リング（穴・分離図形・additive-optional・確定 2026-07）。
// kind="merge" の Bake（Illustrator Expand 相当。§5.5d 参照）の出力形式。
// Component.props.rings?: ShapeVertex[][] に乗り、存在すれば単一の vertices より優先して
// 描画される（fill-rule="evenodd" — 穴は内側リングとして表現。輪の入れ子/穴か分離図形かの
// 区別は evenodd 塗りつぶし自体が吸収するため区別しない）。手動生成の単一図形は従来通り
// vertices のまま（rings は bake 由来のみ・後方互換）。
export type ShapeRings = ShapeVertex[][];

// §5.5d shape Phase 3（Boolean/Pathfinder 合成・他レイヤー参照・additive-optional・確定 2026-07）。
// kind==="merge" のとき Component.props.mergeInputs?: BooleanMergeInput[] を使う
// （AE の Merge Paths ではなく Illustrator の Pathfinder に相当 — 合成対象は「同一 comp 内の
// 他 SceneObject」であり、同一レイヤー内のサブパスではない。この engine の objects はフラットで
// レイヤー内ネストを持たないため、こちらが自然なモデル）。
// objectId は安定 ID 参照（INV-6）。参照先は kind が rect/ellipse/path の shape のみ
// （merge の入れ子・循環を避けるため、merge 同士は参照不可）。
// mergeInputs[0].op は無意味（直前の合成結果が無いベース図形のため無視される）。
// mergeInputs[1] 以降は「直前までの合成結果」に対する自分の合成規則。
// 参照された側のレイヤーは自身の通常描画から自動的に除外される（合成結果としてのみ見える）。
export type BooleanOp = "unite" | "subtract" | "intersect" | "exclude";

export interface BooleanMergeInput {
  id: string; // ULID (INV-6)
  objectId: ObjectId; // 参照先 SceneObject（同一 comp 内、shape kind=rect/ellipse/path）
  op: BooleanOp;
}

// §5.5b / §27 エフェクト（レイヤー描画結果への後処理）
export interface EffectInstance {
  id: string; // ULID (INV-6)
  type: string;
  enabled: boolean;
  props: Record<string, AnimatedProp<unknown> | unknown>;
}

/** §9 Phase 0.5 — レイヤーに付いた expression プリセット（EffectInstance の軽量版） */
export interface ExpressionPresetInstance {
  id: string; // ULID (INV-6)
  presetId: string;
  enabled: boolean;
  props: Record<string, AnimatedProp<unknown> | unknown>;
}

export type ParamKind =
  | "scalar"
  | "vec2"
  | "vec3"
  | "color"
  | "bool"
  | "enum"
  | "string"
  | "asset";

export interface ParamDescriptor {
  key: string;
  label: string;
  kind: ParamKind;
  default: unknown;
  animatable: boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[]; // enum 用
}

export interface SceneObject {
  id: ObjectId;
  name: string; // 表示専用
  parent: ObjectId | null; // transform 継承のみ。描画順とは無関係
  zOrder: number; // comp 内グローバル描画順。fractional（小→奥）
  enabled: boolean;
  inPoint: Frame; // この comp 内での表示開始
  outPoint: Frame; // 表示終了
  transform: Transform;
  opacity: AnimatedProp<number>; // 0..1, 全 Object 共通
  components: Component[];
  effects?: EffectInstance[]; // 省略/[] = なし。配列順 = 適用順
  expressionPresets?: ExpressionPresetInstance[]; // 省略/未設定 = なし（§9 Phase 0.5）
  isAdjustment?: boolean; // true = 調整レイヤー（§27.4）
  adjustmentMode?: "live" | "raster"; // §27.4 省略=live（backdrop-filter）。isAdjustment 時のみ有効
  isNull?: boolean; // true = Null レイヤー（§30）
  threeD?: boolean; // §5.4b true = 3D 空間に配置（AE の 3D レイヤースイッチ）。省略/false = 平面 2D
  threeDMode?: ThreeDMode; // §5.4b 描画経路。省略 = "auto"（comp.renderer3d に従う）
  labelIndex?: LabelIndex; // §5.4c AE ラベル色。省略 = 無色（エディタ UI のみ）
  locked?: boolean; // §5.4e true = ロック（エディタ UI のみ）。省略/false = 編集可
  blendMode?: BlendMode; // §5.4d 描画モード。省略 = "normal"
  trackMatteMode?: TrackMatteMode; // §5.4f トラックマット。省略 = なし。マット源は直上レイヤー
}

// §5.4b 3D レイヤー描画経路。"auto" は comp.renderer3d に従う。
export type ThreeDMode = "auto" | "dom" | "raster3d";
// §5.4d 描画モード / ブレンドモード。CSS mix-blend-mode が直接持つ 16 種（normal 含む）。
export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";
// 許可値（validate / UI 用）。順序は UI ドロップダウンの並びも兼ねる。
export const BLEND_MODES: readonly BlendMode[] = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
];
// §5.4f トラックマット（塗り側）。マット源は enabled スタックの直上レイヤー（ID 参照なし）。
export type TrackMatteMode = "alpha" | "alphaInverted" | "luma" | "lumaInverted";
export const TRACK_MATTE_MODES: readonly TrackMatteMode[] = [
  "alpha",
  "alphaInverted",
  "luma",
  "lumaInverted",
];

// §5.4c AE ラベル色インデックス 0–15。
export type LabelIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;
// §5.4b comp の 3D レンダラー。"classic"≈dom / "advanced"≈raster3d。
export type Renderer3d = "classic" | "advanced";

// §5.6 Composition / Project
export type CompKind = "timeline" | "html";

export interface CompositionMeta {
  id: CompId;
  name: string;
  kind: CompKind;
  width: number; // px
  height: number; // px
  fps: number;
  duration: Frame; // 総フレーム数
  background?: RGBA;
  /** §20.5 Project Bin 整理用。省略 = ルート。resolve 非参照。 */
  binId?: string;
  /** §21.1b 編集補助 BPM。0/省略 = 無効（タイムコードのみ）。表示専用・resolve 非参照。 */
  bpm?: number;
  /** §21.1b 1 小節の拍数。省略 = 4。bpm > 0 のときのみ意味を持つ。resolve 非参照。 */
  beatsPerBar?: number;
}

export interface TimelineComposition extends CompositionMeta {
  kind: "timeline";
  objects: SceneObject[]; // flat list, id 昇順で直列化（§5.4-note）
  // active camera は永続しない。resolve() が frame ごとに最前面の可視 camera を自動選択（§6.5）。
  // 旧 `activeCamera?: ObjectId` はロード時に無視（後方互換）。
  renderer3d?: Renderer3d; // §5.4b 3D レンダラー。省略 = "classic"
}

export interface HtmlComposition extends CompositionMeta {
  kind: "html";
  // 実体は compositions/<id>/ のファイル。params は script.js manifest が宣言（§7）
}

export type Composition = TimelineComposition | HtmlComposition;

export type AssetKind = "image" | "video" | "font" | "audio" | "other";

export interface AssetEntry {
  id: AssetId;
  path: string; // assets/ 下の相対パス
  kind: AssetKind;
  meta?: Record<string, unknown>;
  /** §20.5 Project Bin 整理用。省略 = ルート。resolve 非参照。 */
  binId?: string;
}

/** §20.5 AE 型 Project パネル仮想フォルダ。描画・参照には影響しない。 */
export interface ProjectBin {
  id: string;
  name: string;
  parentId: string | null;
}

/** §20.5 フォルダ内の表示順エントリ。 */
export type ProjectTreeEntry =
  | { kind: "bin"; id: string }
  | { kind: "composition"; id: CompId }
  | { kind: "asset"; id: AssetId };

export interface PluginRef {
  id: string;
  version: string;
  enabled: boolean;
}

export interface ProjectMeta {
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  schemaVersion: 1;
  meta: ProjectMeta;
  assets: AssetEntry[];
  compositions: Composition[];
  rootComposition: CompId; // 既定で開く comp
  pluginRefs: PluginRef[]; // plugins/ の有効化リスト
  /** §20.5 仮想フォルダ定義。省略 = フォルダなし。 */
  bins?: ProjectBin[];
  /**
   * §20.5 各親フォルダ内の表示順。キー "" = ルート、否则 bin id。
   * 配列順はユーザー順を保持（id ソート対象外）。省略 = ロード時に導出。
   */
  treeOrder?: Record<string, ProjectTreeEntry[]>;
}

export const CURRENT_SCHEMA_VERSION = 1 as const;

// §11.2 ExportConfig — browser best-effort エクスポート設定（セッション用・project.json 非直列化）。
export type ExportVideoQuality = "low" | "medium" | "high" | "max" | "custom";

export interface ExportConfig {
  range: [Frame, Frame];
  fps: number;
  scale: number;
  format: "mp4" | "webm" | "png-seq" | "html-bundle";
  alpha: boolean;
  /** §26.7 テキスト描画方式。未指定時 precise。 */
  textRenderMode?: "precise" | "draft";
  /** §11.7 html-bundle のみ。true=ループ再生 / false=1回再生。未指定時 true。 */
  bundleLoop?: boolean;
  /** 映像エンコード品質プリセット。未指定 = "high"（bitrate 8_000_000）。mp4/webm / bundle bake のみ。 */
  videoQuality?: ExportVideoQuality;
  /** bps。`videoQuality === "custom"` のとき使用。clamp 50_000..50_000_000。 */
  videoBitrate?: number;
  /**
   * WebCodecs `latencyMode`。未指定 = フィールドを渡さない（ブラウザ既定）。
   * "quality" = 画質優先 / "realtime" = 速度優先。
   */
  encodeLatencyMode?: "quality" | "realtime";
  /** 音声エンコード bitrate（bps）。未指定 = 192_000。mp4(AAC)/webm(Opus) のみ。clamp 32_000..320_000。 */
  audioBitrate?: number;
}
