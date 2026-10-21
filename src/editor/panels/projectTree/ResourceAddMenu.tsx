import { useEffect, useRef, useState } from "react";
import { toolbarBtn } from "./toolbarStyles";

export interface ResourceAddMenuProps {
  onAddTimelineComp: () => void;
  onAddHtmlComp: () => void;
  onImportImage: () => void;
  onImportVideo: () => void;
  onImportAudio: () => void;
}

const ITEMS: {
  label: string;
  title?: string;
  run: (p: ResourceAddMenuProps) => void;
}[] = [
  { label: "Comp", title: "タイムラインコンポを追加", run: (p) => p.onAddTimelineComp() },
  { label: "HTML", title: "HTML コンポを追加", run: (p) => void p.onAddHtmlComp() },
  { label: "Image / SVG", title: "画像・SVG をレイヤーとしてインポート", run: (p) => p.onImportImage() },
  { label: "Video", title: "動画 Footage をインポート", run: (p) => p.onImportVideo() },
  { label: "Audio", title: "音声 Footage をインポート", run: (p) => p.onImportAudio() },
];

export function ResourceAddMenu(props: ResourceAddMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={menuRef} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={toolbarBtn}
        title="リソースを追加"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        + リソース ▾
      </button>
      {open && (
        <div role="menu" style={menuPanel}>
          {ITEMS.map(({ label, title, run }) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              title={title}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => {
                setOpen(false);
                run(props);
              }}
              style={menuItem}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const menuPanel: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  marginTop: 2,
  zIndex: 100,
  background: "#2a2a2a",
  border: "1px solid #444",
  borderRadius: 4,
  padding: 4,
  minWidth: 120,
  boxShadow: "0 4px 12px rgba(0,0,0,0.45)",
};

const menuItem: React.CSSProperties = {
  display: "block",
  width: "100%",
  background: "transparent",
  border: "none",
  color: "#ccc",
  cursor: "pointer",
  fontSize: 11,
  padding: "5px 10px",
  textAlign: "left",
  borderRadius: 2,
};
