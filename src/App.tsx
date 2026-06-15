import { useCallback, useEffect, useState } from "react";
import { WorkspaceLayout } from "./editor/WorkspaceLayout";
import { defaultWorkspace, type LayoutNode, type WorkspaceState } from "./editor/layout";
import { useEditorStore } from "./editor/store";

const WORKSPACE_KEY = "mafter-workspace-v1";

function loadWorkspace(): WorkspaceState {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (raw) return JSON.parse(raw) as WorkspaceState;
  } catch {
    /* ignore */
  }
  return defaultWorkspace();
}

function saveWorkspace(ws: WorkspaceState) {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(ws));
  } catch {
    /* ignore */
  }
}

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(loadWorkspace);

  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const loadFromFs = useEditorStore((s) => s.loadFromFs);
  const undoStack = useEditorStore((s) => s.undoStack);

  // 起動時に FS から読み込む
  useEffect(() => {
    void loadFromFs();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Undo/Redo キーボードショートカット (Cmd/Ctrl-Z / Shift-Cmd-Z, §17)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if (mod && (e.key === "Z" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const handleSizesChange = useCallback((path: number[], sizes: number[]) => {
    setWorkspace((ws) => {
      const next = updateLayoutSizes(ws.layout, path, sizes);
      const updated = { ...ws, layout: next };
      saveWorkspace(updated);
      return updated;
    });
  }, []);

  const canUndo = undoStack.past.length > 0;
  const canRedo = undoStack.future.length > 0;

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", background: "#111", color: "#ccc", overflow: "hidden", fontFamily: "system-ui, sans-serif" }}>
      {/* menu bar */}
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 4, padding: "4px 12px", background: "#1a1a1a", borderBottom: "1px solid #333", fontSize: 12 }}>
        <span style={{ fontWeight: "bold", color: "#7fb8f0", marginRight: 8 }}>Mafter Effect</span>
        <button onClick={undo} disabled={!canUndo} style={menuBtnStyle(canUndo)}>↩ Undo</button>
        <button onClick={redo} disabled={!canRedo} style={menuBtnStyle(canRedo)}>↪ Redo</button>
        <span style={{ color: "#444", marginLeft: 4 }}>|</span>
        <span style={{ color: "#555", fontSize: 11 }}>
          {canUndo ? `${undoStack.past.length} op` : "clean"}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "#555", fontSize: 10 }}>M1 preview</span>
      </div>

      {/* workspace */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        <WorkspaceLayout node={workspace.layout} onSizesChange={handleSizesChange} />
      </div>
    </div>
  );
}

function menuBtnStyle(enabled: boolean): React.CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: enabled ? "#bbb" : "#555",
    cursor: enabled ? "pointer" : "default",
    padding: "2px 8px",
    fontSize: 12,
    borderRadius: 3,
  };
}

function updateLayoutSizes(node: LayoutNode, path: number[], sizes: number[]): LayoutNode {
  if (path.length === 0) {
    if (node.type === "split") return { ...node, sizes };
    return node;
  }
  if (node.type !== "split") return node;
  const [head, ...rest] = path;
  if (head === undefined) return node;
  return {
    ...node,
    children: node.children.map((child, i) =>
      i === head ? updateLayoutSizes(child, rest, sizes) : child,
    ),
  };
}
