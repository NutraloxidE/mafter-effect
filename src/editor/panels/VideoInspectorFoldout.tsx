import type { CSSProperties, ReactNode } from "react";

/** Video Inspector 内セクション（Motion Track / Subject Extract 等）共通 foldout。 */
export function VideoInspectorFoldout({
  label,
  expanded,
  onToggle,
  children,
}: {
  label: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        marginBottom: 4,
        border: "1px solid #333",
        borderRadius: 3,
        overflow: "hidden",
        background: "#252525",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          width: "100%",
          padding: "4px 6px",
          border: "none",
          background: "#383838",
          color: "#8cf",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ width: 10, flexShrink: 0, color: "#aaa", fontSize: 10 }}>
          {expanded ? "▼" : "▶"}
        </span>
        <span style={{ flex: 1 }}>{label}</span>
      </button>
      {expanded && (
        <div style={{ padding: "6px 8px 8px", background: "#1e1e1e" }}>{children}</div>
      )}
    </div>
  );
}

/** Motion Track / Subject Extract で共有する Inspector コントロール styles。 */
export const videoInspectorBtnStyle: CSSProperties = {
  background: "#2a2a2a",
  border: "1px solid #444",
  color: "#bbb",
  borderRadius: 3,
  padding: "2px 5px",
  cursor: "pointer",
  fontSize: 10,
};

export const videoInspectorSelectStyle: CSSProperties = {
  background: "#2a2a2a",
  border: "1px solid #444",
  color: "#ddd",
  borderRadius: 3,
  padding: "2px 4px",
  fontSize: 11,
  flex: 1,
  width: "100%",
  marginTop: 2,
};

export const videoInspectorScrubInputStyle: CSSProperties = {
  background: "#2a2a2a",
  border: "1px solid #444",
  color: "#ddd",
  borderRadius: 3,
  padding: "2px 4px",
  fontSize: 11,
};

export const videoInspectorScrubRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 10,
  color: "#aaa",
};

export const videoInspectorFieldLabelStyle: CSSProperties = {
  fontSize: 10,
  color: "#aaa",
  display: "block",
};
