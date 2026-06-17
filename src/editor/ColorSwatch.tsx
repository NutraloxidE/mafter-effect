import type { RGBA } from "../core/schema";

export interface ColorSwatchProps {
  label: string;
  value: RGBA;
  onChange: (next: RGBA) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

function rgbaToHex(c: RGBA): string {
  const r = Math.round(c.r * 255).toString(16).padStart(2, "0");
  const g = Math.round(c.g * 255).toString(16).padStart(2, "0");
  const b = Math.round(c.b * 255).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export function ColorSwatch({ label, value, onChange, onFocus, onBlur }: ColorSwatchProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
      <span style={{ color: "#666", width: 52, textAlign: "right", flexShrink: 0, fontSize: 11 }}>{label}</span>
      <input
        type="color"
        value={rgbaToHex(value)}
        onChange={(e) => {
          const rgb = hexToRgb(e.target.value);
          if (rgb) onChange({ ...rgb, a: value.a });
        }}
        onFocus={onFocus}
        onBlur={onBlur}
        style={{ width: 28, height: 22, padding: 0, border: "1px solid #444", background: "#222", cursor: "pointer" }}
      />
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(value.a * 100)}
        onChange={(e) => onChange({ ...value, a: Number(e.target.value) / 100 })}
        onFocus={onFocus}
        onBlur={onBlur}
        title="Alpha"
        style={{ width: 60 }}
      />
      <span style={{ color: "#888", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>
        {Math.round(value.a * 100)}%
      </span>
    </div>
  );
}

export function isRgba(v: unknown): v is RGBA {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as RGBA).r === "number" &&
    typeof (v as RGBA).g === "number" &&
    typeof (v as RGBA).b === "number" &&
    typeof (v as RGBA).a === "number"
  );
}
