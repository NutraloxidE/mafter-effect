import type { ComponentDef } from "./plugin";
import { globalPluginRegistry } from "./pluginRegistry";
import { FOOTAGE_QUALITY_TIERS } from "./footageQuality";

/** §26.2 builtin ComponentDef 登録（text）。ParamDescriptor で Timeline/Inspector の kind を正す。 */
const TEXT_COMPONENT_DEF: ComponentDef = {
  type: "text",
  label: "Text",
  previewBakeRequired: false,
  params: [
    { key: "text", label: "Source Text", kind: "string", default: "Text", animatable: true },
    { key: "font", label: "Font", kind: "string", default: "sans-serif", animatable: false },
    { key: "size", label: "Size", kind: "scalar", default: 48, animatable: true, min: 1 },
    { key: "color", label: "Fill", kind: "color", default: { r: 1, g: 1, b: 1, a: 1 }, animatable: true },
    { key: "align", label: "Align", kind: "enum", default: "left", animatable: false, options: ["left", "center", "right", "justify"] },
    { key: "tracking", label: "Tracking", kind: "scalar", default: 0, animatable: true },
    { key: "leading", label: "Leading", kind: "scalar", default: 0, animatable: true, min: 0 },
    { key: "boxWidth", label: "Box Width", kind: "scalar", default: 0, animatable: true, min: 0 },
    { key: "boxHeight", label: "Box Height", kind: "scalar", default: 0, animatable: true, min: 0 },
    { key: "weight", label: "Weight", kind: "enum", default: 400, animatable: false, options: ["100", "200", "300", "400", "500", "600", "700", "800", "900"] },
    { key: "italic", label: "Italic", kind: "bool", default: false, animatable: false },
    { key: "strokeColor", label: "Stroke", kind: "color", default: { r: 0, g: 0, b: 0, a: 1 }, animatable: true },
    { key: "strokeWidth", label: "Stroke Width", kind: "scalar", default: 0, animatable: true, min: 0 },
  ],
  // 描画は DomRenderer（§26.4）。ParamDescriptor 登録が主目的。
  render() { /* DomRenderer */ },
};

/**
 * §5.5 / §5.5c shape（rect/ellipse は CSS box、path は vertices から SVG <path>）。
 * `radiusTL/TR/BR/BL` は kind==="rect" のときのみ描画に効く（DomRenderer 側で判定）。
 * `size` は既存 solid と同じ生 prop（{x,y,z} の Vec3。z は未使用）。
 * `vertices?: ShapeVertex[]`（kind==="path"）は params に載せない — 単一 AnimatedProp ではなく
 * 「AnimatedProp を内包するオブジェクトの配列」のため、ParamDescriptor 駆動の汎用 UI/KF行の対象外
 * （Inspector 専用フィールドで直接編集。§26.2 の契約から意図的に外れる）。
 */
const SHAPE_COMPONENT_DEF: ComponentDef = {
  type: "shape",
  label: "Shape",
  previewBakeRequired: false,
  params: [
    { key: "kind", label: "Kind", kind: "enum", default: "rect", animatable: false, options: ["rect", "ellipse", "path"] },
    { key: "fill", label: "Fill", kind: "color", default: { r: 0.5, g: 0.7, b: 0.9, a: 1 }, animatable: true },
    { key: "radiusTL", label: "Radius TL", kind: "scalar", default: 0, animatable: true, min: 0 },
    { key: "radiusTR", label: "Radius TR", kind: "scalar", default: 0, animatable: true, min: 0 },
    { key: "radiusBR", label: "Radius BR", kind: "scalar", default: 0, animatable: true, min: 0 },
    { key: "radiusBL", label: "Radius BL", kind: "scalar", default: 0, animatable: true, min: 0 },
    { key: "size", label: "Size", kind: "vec2", default: { x: 200, y: 200 }, animatable: true },
  ],
  render() { /* DomRenderer */ },
};

const IMAGE_COMPONENT_DEF: ComponentDef = {
  type: "image",
  label: "Image",
  previewBakeRequired: false,
  params: [
    { key: "asset", label: "Source", kind: "asset", default: "", animatable: false },
    { key: "fit", label: "Fit", kind: "enum", default: "contain", animatable: false, options: ["contain", "cover", "fill"] },
  ],
  render() { /* DomRenderer */ },
};

const VIDEO_COMPONENT_DEF: ComponentDef = {
  type: "video",
  label: "Video",
  previewBakeRequired: false,
  params: [
    { key: "asset", label: "Source", kind: "asset", default: "", animatable: false },
    { key: "fit", label: "Fit", kind: "enum", default: "contain", animatable: false, options: ["contain", "cover", "fill"] },
    { key: "trimStart", label: "Trim Start", kind: "scalar", default: 0, animatable: true, min: 0 },
    // §11.4 内蔵音声の音量（0..1, keyframe 可）。UI 表示名は Volume。
    { key: "gain", label: "Volume", kind: "scalar", default: 1, animatable: true, min: 0, max: 1 },
    // §11.5.2 カット端のポップ音防止 自動フェード（declick）。既定 ON。
    { key: "autoFade", label: "Auto-fade (declick)", kind: "bool", default: true, animatable: false },
    // §11.4b 画質ティア。原本/プロキシの映像ファイル切替（音声は常に原本）。既定 original（後方互換）。
    { key: "footageQuality", label: "Quality", kind: "enum", default: "original", animatable: false, options: [...FOOTAGE_QUALITY_TIERS] },
  ],
  render() { /* DomRenderer */ },
};

const AUDIO_COMPONENT_DEF: ComponentDef = {
  type: "audio",
  label: "Audio",
  previewBakeRequired: false,
  params: [
    { key: "asset", label: "Source", kind: "asset", default: "", animatable: false },
    // §11.5 音量（0..1, keyframe 可）。UI 表示名は Volume。
    { key: "gain", label: "Volume", kind: "scalar", default: 1, animatable: true, min: 0, max: 1 },
    { key: "trimStart", label: "Trim Start", kind: "scalar", default: 0, animatable: true, min: 0 },
    // §11.5.2 カット端のポップ音防止 自動フェード（declick）。既定 ON。
    { key: "autoFade", label: "Auto-fade (declick)", kind: "bool", default: true, animatable: false },
  ],
  render() { /* PreviewAudioClock / export mux */ },
};

/**
 * §6.5b カメラ（AE 準拠）。render は no-op — resolve() が props を読んで scene.camera を供給する。
 * 可変は zoom(px)。fov = 2·atan((compHeight/2)/zoom)。two-node は pointOfInterest を向く。
 */
const CAMERA_COMPONENT_DEF: ComponentDef = {
  type: "camera",
  label: "Camera",
  previewBakeRequired: false,
  params: [
    { key: "cameraType", label: "Type", kind: "enum", default: "two-node", animatable: false, options: ["one-node", "two-node"] },
    { key: "pointOfInterest", label: "Point of Interest", kind: "vec3", default: { x: 0, y: 0, z: 0 }, animatable: true },
    { key: "zoom", label: "Zoom", kind: "scalar", default: 1158, animatable: true, min: 1 },
    { key: "filmSize", label: "Film Size (mm)", kind: "scalar", default: 36, animatable: false, min: 1 },
    { key: "near", label: "Near", kind: "scalar", default: 1, animatable: false, min: 0.001 },
    { key: "far", label: "Far", kind: "scalar", default: 10000, animatable: false, min: 1 },
  ],
  render() { /* resolve() が scene.camera を供給。描画要素は持たない */ },
};

/**
 * `solid`/`html`/`comp` は ComponentDef 未登録（DomRenderer 等でハードコード分岐）だが、
 * bake 判定除外・plugin 一覧フィルタ双方で「builtin 全体」を指すため solid/html/comp も含めておく。
 */
export const BUILTIN_COMPONENT_TYPES = new Set([
  "solid",
  "shape",
  "text",
  "image",
  "html",
  "comp",
  "audio",
  "video",
  "camera", // §6.5b 非描画（transform/メタのみ）。bundle で bake してはいけない
]);

/** registry.clear() 後も再登録できる（loadPlugins 経路）。 */
export function registerBuiltinComponents(): void {
  globalPluginRegistry.registerComponent(TEXT_COMPONENT_DEF);
  globalPluginRegistry.registerComponent(SHAPE_COMPONENT_DEF);
  globalPluginRegistry.registerComponent(IMAGE_COMPONENT_DEF);
  globalPluginRegistry.registerComponent(VIDEO_COMPONENT_DEF);
  globalPluginRegistry.registerComponent(AUDIO_COMPONENT_DEF);
  globalPluginRegistry.registerComponent(CAMERA_COMPONENT_DEF);
}
