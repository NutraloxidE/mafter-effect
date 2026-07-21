// §32.2 / §33 メニューバーの「マクロ ▾」ドロップダウン。
// 項目はコマンドレジストリの「マクロ」グループ（key "m"）の子から生成するため、
// registerCommand で登録した機能はドロップダウンにも自動で並ぶ（Ctrl ダブルタップ経路と共通）。

import { useEffect, useState } from "react";
import { useCommandTree } from "../commandMenu/useCommandTree";

const MACRO_GROUP_KEY = "m";

export function MacroMenu() {
  const [open, setOpen] = useState(false);
  const tree = useCommandTree();
  const group = tree.find((n) => n.key === MACRO_GROUP_KEY);
  const items = group?.children ?? [];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <span style={{ position: "relative", ...({ WebkitAppRegion: "no-drag" } as React.CSSProperties) }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={triggerStyle(open)}
        title="Ctrl ダブルタップ → M でも開けます"
      >
        {group?.label ?? "マクロ"} ▾
      </button>
      {open && (
        <>
          {/* 外側クリックで閉じる透明オーバーレイ */}
          <div style={backdropStyle} onClick={() => setOpen(false)} />
          <div style={menuStyle} role="menu">
            {items.length === 0 ? (
              <div style={{ padding: "5px 10px", fontSize: 11, color: "#777" }}>
                （マクロなし）
              </div>
            ) : (
              items.map((item) => (
                <button
                  key={item.key}
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    item.run?.();
                  }}
                  style={itemStyle}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#2a2a2a")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <span style={keyCapStyle}>{item.key.toUpperCase()}</span>
                  <span>{item.label}…</span>
                </button>
              ))
            )}
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
  minWidth: 200, background: "#1e1e1e", border: "1px solid #444",
  borderRadius: 4, padding: 4, boxShadow: "0 8px 24px rgba(0,0,0,.6)",
};

const itemStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
  background: "transparent", border: "none", color: "#ccc",
  padding: "5px 10px", fontSize: 12, borderRadius: 3, cursor: "pointer",
  WebkitAppRegion: "no-drag",
} as React.CSSProperties;

const keyCapStyle: React.CSSProperties = {
  minWidth: 18, textAlign: "center", padding: "0 5px", fontSize: 11,
  fontFamily: "ui-monospace, monospace", color: "#7fb8f0",
  background: "#2a2a2a", border: "1px solid #444", borderRadius: 3,
};
