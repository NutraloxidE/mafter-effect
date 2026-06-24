import { useEffect, useRef, useState } from "react";
import { framesToTimecode, parseTimecode } from "./timecode";

/**
 * Duration 等の Frame 値を AE 既定タイムコード `H:MM:SS:FF` で表示・編集する（§5.6）。
 * ドラッグ=1px/frame で値変更（従来 ScrubNumber と同 UX）、クリックで timecode テキスト入力。
 * onCommit は1ジェスチャーにつき1回（undo エントリ1件）。値・パースは整数 frame。
 */
export function TimecodeScrub({
  value,
  fps,
  onCommit,
  min = 1,
  style,
  className,
}: {
  /** 整数 frame。 */
  value: number;
  fps: number;
  onCommit: (newValue: number) => void;
  min?: number;
  style?: React.CSSProperties;
  className?: string;
}) {
  const clamp = (v: number): number => Math.max(min, Math.round(v));

  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(framesToTimecode(value, fps));
  const [liveValue, setLiveValue] = useState<number | null>(null);
  const scrubRef = useRef<{ startX: number; startValue: number; dragging: boolean } | null>(null);

  useEffect(() => {
    if (!editing && liveValue === null) setText(framesToTimecode(value, fps));
  }, [value, fps, editing, liveValue]);

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
      setLiveValue(clamp(state.startValue + dx * mod));
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
        setText(framesToTimecode(value, fps));
      } else {
        const dx = ev.clientX - state.startX;
        const mod = ev.shiftKey ? 10 : ev.ctrlKey || ev.metaKey ? 0.1 : 1;
        const next = clamp(state.startValue + dx * mod);
        if (next !== value) onCommit(next);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const commitText = () => {
    setEditing(false);
    const parsed = parseTimecode(text, fps);
    if (parsed !== null) {
      const clamped = clamp(parsed);
      if (clamped !== value) onCommit(clamped);
      else setText(framesToTimecode(value, fps));
    } else {
      setText(framesToTimecode(value, fps));
    }
  };

  const display = liveValue !== null ? liveValue : value;
  const shown = framesToTimecode(display, fps);
  const widthForText = (s: string) => `max(72px, calc(${Math.max(8, s.length)}ch + 8px))` as const;
  const merged: React.CSSProperties = {
    ...defaultStyle,
    minWidth: widthForText(editing ? text : shown),
    ...style,
  };
  const title = `${shown} (${value}f @ ${fps}fps) — ドラッグで値変更（Shift=10倍 / Ctrl=0.1倍）/ クリックで H:MM:SS:FF 入力`;

  if (editing) {
    return (
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setEditing(false);
            setText(framesToTimecode(value, fps));
          }
        }}
        onFocus={(e) => e.target.select()}
        autoFocus
        title={title}
        style={{ ...merged, cursor: "text", outline: "1px solid #5a9ff0", userSelect: "text" }}
        className={className}
      />
    );
  }

  return (
    <div
      onMouseDown={handleMouseDown}
      title={title}
      style={{ ...merged, cursor: "ew-resize", display: "inline-flex", alignItems: "center" }}
      className={className}
    >
      {shown}
    </div>
  );
}

const defaultStyle: React.CSSProperties = {
  flexShrink: 0,
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
