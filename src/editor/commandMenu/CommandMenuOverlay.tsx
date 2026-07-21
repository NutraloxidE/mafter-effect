// §33 コマンドモードの HUD（which-key 風）。Ctrl ダブルタップで表示され、
// 現在位置のパンくずと、次に押せるキー一覧を表示する。App にグローバルマウントする。

import { useCommandMenu } from "./useCommandMenu";
import { pathLabels, resolveLevel } from "./commandTree";

export function CommandMenuOverlay() {
  const { active, path, tree, cancel } = useCommandMenu();
  if (!active) return null;

  const level = resolveLevel(tree, path) ?? [];
  const trail = pathLabels(tree, path);

  return (
    <div style={overlayStyle} onMouseDown={cancel}>
      <div style={panelStyle} onMouseDown={(e) => e.stopPropagation()}>
        <div style={breadcrumbStyle}>
          <span style={{ color: "#7fb8f0" }}>⌃⌃</span>
          {trail.map((label, i) => (
            <span key={i}>
              <span style={{ color: "#555", margin: "0 6px" }}>▸</span>
              <span style={{ color: "#ccc" }}>{label}</span>
            </span>
          ))}
        </div>

        {level.length === 0 ? (
          <div style={{ color: "#888", fontSize: 12, padding: "8px 4px" }}>
            この階層に項目がありません。
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {level.map((node) => (
              <div key={node.key} style={rowStyle}>
                <span style={keyCapStyle}>{node.key.toUpperCase()}</span>
                <span style={{ color: "#ddd", flex: 1 }}>{node.label}</span>
                {node.children.length > 0 ? (
                  <span style={{ color: "#666", fontSize: 11 }}>▸</span>
                ) : node.hint ? (
                  <span style={{ color: "#666", fontSize: 10 }}>{node.hint}</span>
                ) : null}
              </div>
            ))}
          </div>
        )}

        <div style={footerStyle}>キーを押して選択 · Esc で閉じる</div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", display: "flex",
  alignItems: "flex-start", justifyContent: "center", zIndex: 10050,
  paddingTop: "18vh",
};

const panelStyle: React.CSSProperties = {
  background: "#1e1e1e", border: "1px solid #444", borderRadius: 8,
  padding: 12, width: 320, maxWidth: "90vw", color: "#ccc", fontSize: 13,
  boxShadow: "0 12px 40px rgba(0,0,0,.7)",
};

const breadcrumbStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", fontSize: 12, fontWeight: "bold",
  paddingBottom: 8, marginBottom: 6, borderBottom: "1px solid #333",
};

const rowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, padding: "4px 4px", borderRadius: 4,
};

const keyCapStyle: React.CSSProperties = {
  minWidth: 22, textAlign: "center", padding: "1px 6px", fontSize: 12,
  fontFamily: "ui-monospace, monospace", color: "#7fb8f0",
  background: "#2a2a2a", border: "1px solid #444", borderRadius: 4,
};

const footerStyle: React.CSSProperties = {
  marginTop: 8, paddingTop: 6, borderTop: "1px solid #333",
  fontSize: 10, color: "#666",
};
