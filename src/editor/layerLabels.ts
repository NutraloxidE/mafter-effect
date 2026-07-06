import type { LabelIndex, SceneObject } from "../core/schema";

/** AE CC 既定 + 旧 LayerBar ベージュ（index 0–15 = AE、16 = レガシー）。§21.10 */
export const LAYER_LABEL_COLORS: readonly string[] = [
  "#e84c3d", // 0 Red
  "#f1c40f", // 1 Yellow
  "#1abc9c", // 2 Aqua
  "#e84393", // 3 Pink
  "#9b59b6", // 4 Lavender
  "#f39c12", // 5 Peach / Orange
  "#2ecc71", // 6 Sea Foam
  "#3498db", // 7 Blue
  "#27ae60", // 8 Green
  "#8e44ad", // 9 Purple
  "#d35400", // 10 Orange
  "#795548", // 11 Brown
  "#e056fd", // 12 Fuchsia
  "#00cec9", // 13 Cyan
  "#dfe6e9", // 14 Sandstone
  "#2d5016", // 15 Forest
  "#b89b6a", // 16 Beige（旧 LayerBar 既定色）
] as const;

/** パレット UI 用ツールチップ（index 16 のみ別名） */
export function labelColorTitle(index: number): string {
  if (index === 16) return "ベージュ（旧デフォルト）";
  return `ラベル色 ${index + 1}`;
}

const NEUTRAL_BAR = "#4a4a4a";
const NEUTRAL_BAR_SELECTED = "#5a5a5a";

/** §21.10.2b 種別既定ラベル index */
export function defaultLabelIndexForObject(obj: SceneObject): LabelIndex {
  if (obj.isNull) return 4;
  if (obj.isAdjustment) return 5;
  for (const c of obj.components) {
    switch (c.type) {
      case "solid": return 0;
      case "shape": return 0;
      case "text": return 1;
      case "image":
      case "audio":
      case "video": return 2;
      case "camera": return 7;
      case "html":
      case "comp": return 9;
      default: break;
    }
  }
  return 14;
}

export function isLabelIndex(n: number): n is LabelIndex {
  return Number.isInteger(n) && n >= 0 && n <= 16;
}

export function labelBarColor(index: LabelIndex | undefined): string {
  if (index === undefined) return NEUTRAL_BAR;
  return LAYER_LABEL_COLORS[index] ?? NEUTRAL_BAR;
}

/** タイムライン LayerBar / ゴーストバー用。選択時は明度アップ。 */
export function timelineBarFill(index: LabelIndex | undefined, selected: boolean): string {
  if (index === undefined) return selected ? NEUTRAL_BAR_SELECTED : NEUTRAL_BAR;
  const hex = LAYER_LABEL_COLORS[index] ?? NEUTRAL_BAR;
  if (!selected) return hex;
  return brightenHex(hex, 1.25);
}

/** 行背景 tint（選択ハイライトと両立する薄い不透明度） */
export function labelRowTint(index: LabelIndex | undefined, selected: boolean): string | undefined {
  if (index === undefined) return undefined;
  const hex = LAYER_LABEL_COLORS[index];
  if (!hex) return undefined;
  return selected ? `${hex}33` : `${hex}1a`;
}

function brightenHex(hex: string, factor: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const clamp = (n: number) => Math.min(255, Math.round(n));
  const r = clamp(parseInt(m[1]!, 16) * factor);
  const g = clamp(parseInt(m[2]!, 16) * factor);
  const b = clamp(parseInt(m[3]!, 16) * factor);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}
