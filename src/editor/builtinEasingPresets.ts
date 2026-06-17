// §24.4 組み込みイージングプリセット（単一 cubic-bezier 表現可のみ）。

export type BuiltinEasePreset =
  | { id: string; label: string; kind: "linear" }
  | { id: string; label: string; kind: "bezier"; bezier: [number, number, number, number] };

export const BUILTIN_EASING_PRESETS: BuiltinEasePreset[] = [
  { id: "linear", label: "Linear", kind: "linear" },
  { id: "sineIn", label: "Sine In", kind: "bezier", bezier: [0.12, 0, 0.39, 0] },
  { id: "sineOut", label: "Sine Out", kind: "bezier", bezier: [0.61, 1, 0.88, 1] },
  { id: "sine", label: "Sine", kind: "bezier", bezier: [0.37, 0, 0.63, 1] },
  { id: "quadIn", label: "Quad In", kind: "bezier", bezier: [0.11, 0, 0.5, 0] },
  { id: "quadOut", label: "Quad Out", kind: "bezier", bezier: [0.5, 1, 0.89, 1] },
  { id: "quad", label: "Quad", kind: "bezier", bezier: [0.45, 0, 0.55, 1] },
  { id: "cubicIn", label: "Cubic In", kind: "bezier", bezier: [0.32, 0, 0.67, 0] },
  { id: "cubicOut", label: "Cubic Out", kind: "bezier", bezier: [0.33, 1, 0.68, 1] },
  { id: "cubic", label: "Cubic", kind: "bezier", bezier: [0.65, 0, 0.35, 1] },
  { id: "quartIn", label: "Quart In", kind: "bezier", bezier: [0.5, 0, 0.75, 0] },
  { id: "quartOut", label: "Quart Out", kind: "bezier", bezier: [0.25, 1, 0.5, 1] },
  { id: "quart", label: "Quart", kind: "bezier", bezier: [0.76, 0, 0.24, 1] },
  { id: "quintIn", label: "Quint In", kind: "bezier", bezier: [0.64, 0, 0.78, 0] },
  { id: "quintOut", label: "Quint Out", kind: "bezier", bezier: [0.22, 1, 0.36, 1] },
  { id: "quint", label: "Quint", kind: "bezier", bezier: [0.83, 0, 0.17, 1] },
  { id: "expoIn", label: "Expo In", kind: "bezier", bezier: [0.7, 0, 0.84, 0] },
  { id: "expoOut", label: "Expo Out", kind: "bezier", bezier: [0.16, 1, 0.3, 1] },
  { id: "expo", label: "Expo", kind: "bezier", bezier: [0.87, 0, 0.13, 1] },
  { id: "circIn", label: "Circ In", kind: "bezier", bezier: [0.55, 0, 1, 0.45] },
  { id: "circOut", label: "Circ Out", kind: "bezier", bezier: [0, 0.55, 0.45, 1] },
  { id: "circ", label: "Circ", kind: "bezier", bezier: [0.85, 0, 0.15, 1] },
  { id: "backIn", label: "Back In", kind: "bezier", bezier: [0.36, 0, 0.66, -0.56] },
  { id: "backOut", label: "Back Out", kind: "bezier", bezier: [0.34, 1.56, 0.64, 1] },
  { id: "back", label: "Back", kind: "bezier", bezier: [0.68, -0.6, 0.32, 1.6] },
  { id: "easeIn", label: "Ease In", kind: "bezier", bezier: [0.42, 0, 1, 1] },
  { id: "easeOut", label: "Ease Out", kind: "bezier", bezier: [0, 0, 0.58, 1] },
  { id: "ease", label: "Ease", kind: "bezier", bezier: [0.25, 0.1, 0.25, 1] },
];
