// §32.2 メニューバーの「マクロ ▾」ドロップダウン。将来のマクロ追加はここに項目を足す。

import { useEffect, useState } from "react";

interface MacroMenuProps {
  /** 「テキスト一括置換…」選択時に呼ばれる（App がモーダルを開く）。 */
  onOpenTextBulkReplace: () => void;
}

export function MacroMenu({ onOpenTextBulkReplace }: MacroMenuProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const select = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <span style={{ position: "relative", ...({ WebkitAppRegion: "no-drag" } as React.CSSProperties) }}>
      <button onClick={() => setOpen((v) => !v)} style={triggerStyle(open)}>
        マクロ ▾
      </button>
      {open && (
        <>
          {/* 外側クリックで閉じる透明オーバーレイ */}
          <div style={backdropStyle} onClick={() => setOpen(false)} />
          <div style={menuStyle} role="menu">
            <button
              role="menuitem"
              onClick={() => select(onOpenTextBulkReplace)}
              style={itemStyle}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#2a2a2a")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              テキスト一括置換…
            </button>
          </div>
        </>
      )}
    </span>
  );
}

function triggerStyle(open: boolean): React.CSSProperties {
  return {
    background: open ? "#222" : "transparent",
    border: "none",
    color: "#bbb",
    cursor: "pointer",
    padding: "2px 8px",
    fontSize: 12,
    borderRadius: 3,
    WebkitAppRegion: "no-drag",
  } as React.CSSProperties;
}

const backdropStyle: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 9998,
};

const menuStyle: React.CSSProperties = {
  position: "absolute", top: "100%", left: 0, marginTop: 2, zIndex: 9999,
  minWidth: 168, background: "#1e1e1e", border: "1px solid #444",
  borderRadius: 4, padding: 4, boxShadow: "0 8px 24px rgba(0,0,0,.6)",
};

const itemStyle: React.CSSProperties = {
  display: "block", width: "100%", textAlign: "left",
  background: "transparent", border: "none", color: "#ccc",
  padding: "5px 10px", fontSize: 12, borderRadius: 3, cursor: "pointer",
  WebkitAppRegion: "no-drag",
} as React.CSSProperties;
