import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useContextMenuStore, type ContextMenuItem } from "./contextMenuStore";

// アプリに1つだけマウントする描画ホスト。単一コントローラ store を購読し、
// open があるときだけ body ポータルに固定描画する。
// 位置クランプ・外クリック/Esc/scroll/resize/blur の「閉じる」契機をここに集約する。
export function ContextMenuHost() {
  const open = useContextMenuStore((s) => s.open);
  const close = useContextMenuStore((s) => s.closeContextMenu);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // open が変わるたび、まず要求座標で配置し、実寸測定後に画面端へクランプする。
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const el = menuRef.current;
    if (!el) {
      setPos({ x: open.x, y: open.y });
      return;
    }
    const rect = el.getBoundingClientRect();
    const margin = 4;
    const maxX = window.innerWidth - rect.width - margin;
    const maxY = window.innerHeight - rect.height - margin;
    setPos({
      x: Math.max(margin, Math.min(open.x, maxX)),
      y: Math.max(margin, Math.min(open.y, maxY)),
    });
  }, [open]);

  // 閉じる契機の共通化。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [open, close]);

  if (!open) return null;

  // 測定前（pos===null）は画面外に隠して実寸だけ取る（チラつき防止）。
  const placed = pos ?? { x: -9999, y: -9999 };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      style={{ ...menuPanel, left: placed.x, top: placed.y }}
    >
      {open.items.map((item, i) => (
        <MenuRow key={i} item={item} onClose={close} />
      ))}
    </div>,
    document.body,
  );
}

function MenuRow({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  if (item.kind === "separator") {
    return <div style={separatorStyle} />;
  }
  const { label, onSelect, disabled, danger, icon, shortcut } = item;
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // mousedown で stopPropagation して外クリック判定と競合させない。
      onMouseDown={(e) => {
        e.stopPropagation();
        if (disabled) return;
        onSelect();
        onClose();
      }}
      style={{
        ...menuItem,
        color: disabled ? "#666" : danger ? "#e08080" : "#ccc",
        cursor: disabled ? "default" : "pointer",
        background: !disabled && hover ? "#3a3a3a" : "transparent",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", minWidth: 0 }}>
        {icon != null && <span style={{ marginRight: 6, display: "inline-flex" }}>{icon}</span>}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      </span>
      {shortcut && <span style={{ marginLeft: 16, color: "#777", fontSize: 10 }}>{shortcut}</span>}
    </button>
  );
}

const menuPanel: React.CSSProperties = {
  position: "fixed",
  zIndex: 9999,
  background: "#2a2a2a",
  border: "1px solid #444",
  borderRadius: 4,
  padding: 4,
  minWidth: 160,
  boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
  userSelect: "none",
};

const menuItem: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  width: "100%",
  background: "transparent",
  border: "none",
  fontSize: 11,
  padding: "4px 8px",
  textAlign: "left",
  borderRadius: 2,
};

const separatorStyle: React.CSSProperties = {
  height: 1,
  background: "#444",
  margin: "4px 2px",
};
