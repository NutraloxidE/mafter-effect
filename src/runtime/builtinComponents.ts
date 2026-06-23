import type { ComponentDef } from "./plugin";
import { globalPluginRegistry } from "./pluginRegistry";

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
    { key: "align", label: "Align", kind: "enum", default: "left", animatable: false, options: ["left", "center", "right"] },
    { key: "tracking", label: "Tracking", kind: "scalar", default: 0, animatable: true },
    { key: "leading", label: "Leading", kind: "scalar", default: 0, animatable: true, min: 0 },
    { key: "weight", label: "Weight", kind: "enum", default: 400, animatable: false, options: ["100", "200", "300", "400", "500", "600", "700", "800", "900"] },
    { key: "italic", label: "Italic", kind: "bool", default: false, animatable: false },
    { key: "strokeColor", label: "Stroke", kind: "color", default: { r: 0, g: 0, b: 0, a: 1 }, animatable: true },
    { key: "strokeWidth", label: "Stroke Width", kind: "scalar", default: 0, animatable: true, min: 0 },
  ],
  // 描画は DomRenderer（§26.4）。ParamDescriptor 登録が主目的。
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

/** registry.clear() 後も再登録できる（loadPlugins 経路）。 */
export function registerBuiltinComponents(): void {
  globalPluginRegistry.registerComponent(TEXT_COMPONENT_DEF);
  globalPluginRegistry.registerComponent(IMAGE_COMPONENT_DEF);
  globalPluginRegistry.registerComponent(CAMERA_COMPONENT_DEF);
}
