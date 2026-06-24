import type { CSSProperties } from "react";
import type { RGBA, TimelineComposition } from "../../core/schema";
import { CHECKERBOARD_STYLE } from "../checkerboardStyle";

function rgbaToHexInput(c: RGBA): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function hexToRgba(hex: string): RGBA {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
    a: 1,
  };
}

const swatchBtnStyle: CSSProperties = {
  background: "#2a2a2a",
  border: "1px solid #444",
  color: "#bbb",
  borderRadius: 3,
  padding: "2px 5px",
  cursor: "pointer",
  fontSize: 10,
};

/** §5.6 コンポ背景色（色スウォッチ + 透明トグル）。 */
export function BackgroundControl({
  comp,
  onChange,
}: {
  comp: TimelineComposition;
  onChange: (bg: RGBA | null) => void;
}) {
  const transparent = !comp.background;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title="コンポ背景色（透明可）">
      <label
        style={{
          position: "relative",
          width: 18,
          height: 18,
          borderRadius: 3,
          border: "1px solid #555",
          cursor: "pointer",
          overflow: "hidden",
          flexShrink: 0,
          ...(transparent
            ? CHECKERBOARD_STYLE
            : { background: `rgba(${Math.round(comp.background!.r * 255)},${Math.round(comp.background!.g * 255)},${Math.round(comp.background!.b * 255)},${comp.background!.a})` }),
        }}
        title={transparent ? "透明（クリックで色を設定）" : "クリックで色を変更"}
      >
        <input
          type="color"
          value={comp.background ? rgbaToHexInput(comp.background) : "#000000"}
          onChange={(e) => onChange(hexToRgba(e.target.value))}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, padding: 0, border: "none", cursor: "pointer" }}
        />
      </label>
      <button
        type="button"
        onClick={() => onChange(transparent ? hexToRgba("#000000") : null)}
        style={{ ...swatchBtnStyle, background: transparent ? "#2a3a4a" : "#333" }}
        title={transparent ? "背景は透明（クリックで黒に）" : "背景を透明にする"}
      >
        透明
      </button>
    </span>
  );
}
