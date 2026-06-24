import { useEffect, useRef, useState } from "react";
import {
  formatScrubDisplay,
  formatScrubEdit,
  formatScrubTitle,
} from "./formatScrubDisplay";

/**
 * min/max からスクラブ 1px あたりの delta を決める。
 * 実効レンジ ≤ 1（opacity / amount 等の正規化値）は range/100（既定 0.01）で細かく調整可能にする。
 */
export function resolveScrubSpeed(
  speed: number,
  min?: number,
  max?: number,
  step?: number,
): number {
  if (min !== undefined && max !== undefined) {
    const range = max - min;
    if (range > 0 && range <= 1) {
      if (step !== undefined && step > 0 && step <= range) return step;
      return range / 100;
    }
  }
  return speed;
}

export function resolveScrubDecimals(
  speed: number,
  decimals: number | undefined,
  min?: number,
  max?: number,
): number {
  if (decimals !== undefined) return decimals;
  if (min !== undefined && max !== undefined) {
    const range = max - min;
    if (range > 0 && range <= 1) return 2;
  }
  const effective = resolveScrubSpeed(speed, min, max);
  return effective < 0.1 ? 2 : 1;
}

/**
 * Scrubby slider (AE 準拠): ドラッグで値変更 / クリックでテキスト入力。
 * Shift=10倍速, Ctrl/Cmd=0.1倍速。
 * onCommit は1ジェスチャーにつき1回だけ呼ばれる（undo エントリ1件）。
 */
export function ScrubNumber({
  value,
  onCommit,
  onLiveChange,
  speed = 1,
  step,
  decimals,
  min,
  max,
  style,
  className,
}: {
  value: number;
  /** スクラブ終了 or テキスト確定時に呼ばれる。delta はスクラブ移動量（テキスト入力時は newValue - oldValue）。 */
  onCommit: (newValue: number, delta: number) => void;
  /** スクラブ中に Preview へ即反映する（undo なし）。 */
  onLiveChange?: (newValue: number) => void;
  speed?: number;
  /** ParamDescriptor.step — 正規化レンジ (≤1) ではスクラブ単位の優先値にも使う。 */
  step?: number;
  decimals?: number;
  min?: number;
  max?: number;
  style?: React.CSSProperties;
  className?: string;
}) {
  const effectiveSpeed = resolveScrubSpeed(speed, min, max, step);
  const displayFmt = (v: number) =>
    decimals !== undefined ? v.toFixed(decimals).replace(/\.?0+$/, "") : formatScrubDisplay(v);
  const editFmt = formatScrubEdit;
  const clamp = (v: number): number => {
    let r = v;
    if (min !== undefined) r = Math.max(min, r);
    if (max !== undefined) r = Math.min(max, r);
    return r;
  };

  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(editFmt(value));
  const [liveValue, setLiveValue] = useState<number | null>(null);
  const scrubRef = useRef<{
    startX: number;
    startValue: number;
    dragging: boolean;
  } | null>(null);

  useEffect(() => {
    if (!editing && liveValue === null) setText(editFmt(value));
  }, [value, editing, liveValue]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    scrubRef.current = { startX: e.clientX, startValue: value, dragging: false };

    const onMove = (ev: MouseEvent) => {
      const state = scrubRef.current;
      if (!state) return;
      const dx = ev.clientX - state.startX;
      if (!state.dragging && Math.abs(dx) < 3) return;
      state.dragging = true;
      const mod = ev.shiftKey ? 10 : ev.ctrlKey || ev.metaKey ? 0.1 : 1;
      const next = clamp(state.startValue + dx * effectiveSpeed * mod);
      setLiveValue(next);
      onLiveChange?.(next);
    };

    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const state = scrubRef.current;
      scrubRef.current = null;
      if (!state) return;
      setLiveValue(null);
      if (!state.dragging) {
        setEditing(true);
        setText(editFmt(value));
      } else {
        const dx = ev.clientX - state.startX;
        const mod = ev.shiftKey ? 10 : ev.ctrlKey || ev.metaKey ? 0.1 : 1;
        const delta = dx * effectiveSpeed * mod;
        onCommit(clamp(state.startValue + delta), delta);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const commitText = () => {
    setEditing(false);
    const n = parseFloat(text);
    if (Number.isFinite(n)) {
      const clamped = clamp(n);
      onCommit(clamped, clamped - value);
    } else {
      setText(editFmt(value));
    }
  };

  const merged: React.CSSProperties = { ...defaultStyle, ...style };
  const title = `${formatScrubTitle(value)} — ドラッグで値変更（Shift=10倍 / Ctrl=0.1倍）/ クリックで入力`;

  if (editing) {
    return (
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") { setEditing(false); setText(editFmt(value)); }
        }}
        onFocus={(e) => e.target.select()}
        autoFocus
        title={title}
        style={{ ...merged, cursor: "text", outline: "1px solid #5a9ff0", userSelect: "text" }}
        className={className}
      />
    );
  }

  const display = liveValue !== null ? liveValue : value;
  return (
    <div
      onMouseDown={handleMouseDown}
      title={title}
      style={{ ...merged, cursor: "ew-resize", display: "inline-flex", alignItems: "center" }}
      className={className}
    >
      {displayFmt(display)}
    </div>
  );
}

const defaultStyle: React.CSSProperties = {
  minWidth: 44,
  width: "auto",
  height: 20,
  background: "#2a2a2a",
  border: "1px solid #444",
  color: "#ddd",
  borderRadius: 3,
  padding: "2px 4px",
  fontSize: 11,
  fontVariantNumeric: "tabular-nums",
  userSelect: "none",
  boxSizing: "border-box",
};
