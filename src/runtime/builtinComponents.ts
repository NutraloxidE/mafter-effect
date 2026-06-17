import type { ComponentDef } from "./plugin";
import { globalPluginRegistry } from "./pluginRegistry";

/** §26.2 builtin ComponentDef 登録（text）。ParamDescriptor で Timeline/Inspector の kind を正す。 */
const TEXT_COMPONENT_DEF: ComponentDef = {
  type: "text",
  label: "Text",
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

let registered = false;

export function registerBuiltinComponents(): void {
  if (registered) return;
  globalPluginRegistry.registerComponent(TEXT_COMPONENT_DEF);
  registered = true;
}
