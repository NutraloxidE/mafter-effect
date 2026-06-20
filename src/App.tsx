import { useCallback, useEffect, useState } from "react";
import { WorkspaceLayout } from "./editor/WorkspaceLayout";
import { defaultWorkspace, ensureEasePanelVisible, ensurePipelinePanelVisible, type LayoutNode, type WorkspaceState } from "./editor/layout";
import { useEditorStore } from "./editor/store";

const WORKSPACE_KEY = "mafter-workspace-v1";

function loadWorkspace(): WorkspaceState {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (raw) {
      const ws = JSON.parse(raw) as WorkspaceState;
      const layout = ensurePipelinePanelVisible(ensureEasePanelVisible(ws.layout));
      if (layout !== ws.layout) {
        const migrated = { ...ws, layout };
        saveWorkspace(migrated);
        return migrated;
      }
      return ws;
    }
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

function updateLayoutTabs(node: LayoutNode, path: number[], active: number): LayoutNode {
  if (path.length === 0) {
    if (node.type === "tabs") return { ...node, active };
    return node;
  }
  if (node.type !== "split") return node;
  const [head, ...rest] = path;
  if (head === undefined) return node;
  return {
    ...node,
    children: node.children.map((child, i) =>
      i === head ? updateLayoutTabs(child, rest, active) : child,
    ),
  };
}

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(loadWorkspace);

  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const loadFromFs = useEditorStore((s) => s.loadFromFs);
  const undoStack = useEditorStore((s) => s.undoStack);
  const duplicateSelected = useEditorStore((s) => s.duplicateSelected);
  const splitSelected = useEditorStore((s) => s.splitSelected);

  // 起動時に FS から読み込む
  useEffect(() => {
    void loadFromFs();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // キーボードショートカット
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inputType = t?.tagName === "INPUT" ? (t as HTMLInputElement).type : null;
      const mod = e.metaKey || e.ctrlKey;
      // §17 Undo/Redo — color/range 入力中もアプリ undo を効かせる（Fill/Stroke 等）
      const blockAppUndo =
        t &&
        (t.tagName === "TEXTAREA" ||
          t.isContentEditable ||
          (t.tagName === "INPUT" && inputType !== "color" && inputType !== "range"));
      if (mod) {
        if (e.key === "z" && !e.shiftKey) {
          if (!blockAppUndo) { e.preventDefault(); undo(); }
          return;
        }
        if (e.key === "Z" || (e.key === "z" && e.shiftKey)) {
          if (!blockAppUndo) { e.preventDefault(); redo(); }
          return;
        }
      }
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!mod) return;
      // §21.7 Duplicate / Split Layer
      if (e.key === "d" && !e.shiftKey) { e.preventDefault(); duplicateSelected(); }
      if (e.key === "D" || (e.key === "d" && e.shiftKey)) { e.preventDefault(); splitSelected(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, duplicateSelected, splitSelected]);

  const handleSizesChange = useCallback((path: number[], sizes: number[]) => {
    setWorkspace((ws) => {
      const next = updateLayoutSizes(ws.layout, path, sizes);
      const updated = { ...ws, layout: next };
      saveWorkspace(updated);
      return updated;
    });
  }, []);

  const handleTabsChange = useCallback((path: number[], active: number) => {
    setWorkspace((ws) => {
      const next = updateLayoutTabs(ws.layout, path, active);
      const updated = { ...ws, layout: next };
      saveWorkspace(updated);
      return updated;
    });
  }, []);

  const canUndo = undoStack.past.length > 0;
  const canRedo = undoStack.future.length > 0;

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#111", color: "#ccc", overflow: "hidden", fontFamily: "system-ui, sans-serif" }}>
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
        <WorkspaceLayout node={workspace.layout} onSizesChange={handleSizesChange} onTabsChange={handleTabsChange} />
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
