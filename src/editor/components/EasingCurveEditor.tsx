import { useCallback, useRef } from "react";
import { cubicBezier } from "../../runtime/easing";

export type Bezier4 = [number, number, number, number];

interface EasingCurveEditorProps {
  bezier: Bezier4;
  onChange: (next: Bezier4) => void;
  size?: number;
}

const PAD = 14;

export function EasingCurveEditor({ bezier, onChange, size = 160 }: EasingCurveEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [x1, y1, x2, y2] = bezier;
  const inner = size - PAD * 2;

  const toSvg = (bx: number, by: number) => ({
    x: PAD + bx * inner,
    y: PAD + (1 - by) * inner,
  });

  const p0 = toSvg(0, 0);
  const p3 = toSvg(1, 1);
  const po = toSvg(x1, y1);
  const pi = toSvg(x2, y2);

  const curveFn = cubicBezier(x1, y1, x2, y2);
  let curveD = "";
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const y = curveFn(t);
    const pt = toSvg(t, y);
    curveD += `${i === 0 ? "M" : "L"}${pt.x.toFixed(2)},${pt.y.toFixed(2)} `;
  }

  const startDrag = useCallback(
    (which: "out" | "in", e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const svg = svgRef.current;
      if (!svg) return;
      const move = (ev: MouseEvent) => {
        const rect = svg.getBoundingClientRect();
        const nx = (ev.clientX - rect.left - PAD) / inner;
        const ny = 1 - (ev.clientY - rect.top - PAD) / inner;
        const cx = Math.min(1, Math.max(0, nx));
        const cy = ny;
        onChange(
          which === "out"
            ? [cx, cy, bezier[2], bezier[3]]
            : [bezier[0], bezier[1], cx, cy],
        );
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [bezier, inner, onChange],
  );

  return (
    <svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: "block", background: "#1a1a1a", border: "1px solid #333", borderRadius: 4 }}
    >
      {/* grid */}
      {[0.25, 0.5, 0.75].map((g) => (
        <g key={g} stroke="#2a2a2a" strokeWidth={1}>
          <line x1={PAD} y1={PAD + g * inner} x2={PAD + inner} y2={PAD + g * inner} />
          <line x1={PAD + g * inner} y1={PAD} x2={PAD + g * inner} y2={PAD + inner} />
        </g>
      ))}
      <rect x={PAD} y={PAD} width={inner} height={inner} fill="none" stroke="#444" strokeWidth={1} />
      {/* handles */}
      <line x1={p0.x} y1={p0.y} x2={po.x} y2={po.y} stroke="#666" strokeWidth={1} />
      <line x1={p3.x} y1={p3.y} x2={pi.x} y2={pi.y} stroke="#666" strokeWidth={1} />
      <path d={curveD} fill="none" stroke="#7fb8f0" strokeWidth={2} />
      <circle cx={p0.x} cy={p0.y} r={3} fill="#aaa" />
      <circle cx={p3.x} cy={p3.y} r={3} fill="#aaa" />
      <circle
        cx={po.x}
        cy={po.y}
        r={5}
        fill="#6c9"
        stroke="#111"
        style={{ cursor: "move" }}
        onMouseDown={(e) => startDrag("out", e)}
      />
      <circle
        cx={pi.x}
        cy={pi.y}
        r={5}
        fill="#c96"
        stroke="#111"
        style={{ cursor: "move" }}
        onMouseDown={(e) => startDrag("in", e)}
      />
    </svg>
  );
}

/** ミニサムネ用 SVG path（viewBox 0 0 100 100）。 */
export function miniEaseCurvePath(bezier: Bezier4, samples = 24): string {
  const fn = cubicBezier(bezier[0], bezier[1], bezier[2], bezier[3]);
  let d = "";
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const y = fn(t);
    const x = 8 + t * 84;
    const py = 92 - y * 84;
    d += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${py.toFixed(1)} `;
  }
  return d;
}

/** linear 特例のミニ path。 */
export function miniLinearCurvePath(): string {
  return "M8,92 L92,8";
}
