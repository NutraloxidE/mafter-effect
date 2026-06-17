import { cubicBezier } from "../../runtime/easing";
import type { EaseApplyMode } from "../easingApply";

/** AE / Flow 相当のミニ easing カーブ（§24.2 方向別。in/out は視認性のためやや強め）。 */
const MODE_BEZIER: Record<EaseApplyMode, [number, number, number, number]> = {
  in: [0.72, 0, 1, 0.15],
  both: [0.5, 0, 0.5, 1],
  out: [0, 0.85, 0.28, 1],
};

const MODE_LABEL: Record<EaseApplyMode, string> = {
  in: "Ease In — 入りハンドル",
  both: "Easy Ease — 入り＋出し",
  out: "Ease Out — 出ハンドル",
};

function curvePath(bezier: [number, number, number, number], pad: number, size: number): string {
  const fn = cubicBezier(...bezier);
  const inner = size - pad * 2;
  let d = "";
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const x = pad + t * inner;
    const y = pad + (1 - fn(t)) * inner;
    d += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)} `;
  }
  return d;
}

function KfDiamond({ cx, cy, r, fill }: { cx: number; cy: number; r: number; fill: string }) {
  return (
    <polygon
      points={`${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`}
      fill={fill}
      stroke="#1a1a1a"
      strokeWidth={0.8}
    />
  );
}

interface EaseModeIconProps {
  mode: EaseApplyMode;
  active?: boolean;
  size?: number;
}

/** AE タイムライン KF ダイヤ + Flow 風ミニグラフ。 */
export function EaseModeIcon({ mode, active = false, size = 32 }: EaseModeIconProps) {
  const pad = 5;
  const inner = size - pad * 2;
  const x0 = pad;
  const y0 = pad + inner;
  const x1 = pad + inner;
  const y1 = pad;

  const curveStroke = active ? "#8ec8ff" : "#777";
  const refStroke = active ? "#444" : "#333";
  const kfFill = active ? "#f0c040" : "#b8922a";

  const diamonds: { cx: number; cy: number }[] =
    mode === "in"
      ? [{ cx: x1, cy: y1 }]
      : mode === "out"
        ? [{ cx: x0, cy: y0 }]
        : [
            { cx: x0, cy: y0 },
            { cx: x1, cy: y1 },
          ];

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ display: "block" }}>
      <rect x={0.5} y={0.5} width={size - 1} height={size - 1} rx={2} fill={active ? "#1a2430" : "#161616"} stroke={active ? "#4a7090" : "#333"} />
      <line x1={x0} y1={y0} x2={x1} y2={y1} stroke={refStroke} strokeWidth={0.75} strokeDasharray="2 2" />
      <path
        d={curvePath(MODE_BEZIER[mode], pad, size)}
        fill="none"
        stroke={curveStroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {diamonds.map((d, i) => (
        <KfDiamond key={i} cx={d.cx} cy={d.cy} r={3.2} fill={kfFill} />
      ))}
    </svg>
  );
}

export function easeModeTitle(mode: EaseApplyMode): string {
  return MODE_LABEL[mode];
}
