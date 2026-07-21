import { useCallback, useEffect, useState } from "react";
import { WorkspaceLayout } from "./editor/WorkspaceLayout";
import { ContextMenuHost } from "./editor/contextMenu/ContextMenuHost";
import { defaultWorkspace, ensureEasePanelVisible, ensurePipelinePanelVisible, type LayoutNode, type WorkspaceState } from "./editor/layout";
import { useEditorStore } from "./editor/store";
import { FeedbackPrompt, FeedbackSendModal } from "./editor/FeedbackPrompt";
import { isFeedbackEnabled } from "./editor/feedbackCollector";
import { MacroMenu } from "./editor/menu/MacroMenu";
import { TextBulkReplaceDialog } from "./editor/menu/TextBulkReplaceDialog";
import { CommandMenuOverlay } from "./editor/commandMenu/CommandMenuOverlay";
import { registerCommand } from "./editor/commandMenu/commandRegistry";

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
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [showTextBulkReplace, setShowTextBulkReplace] = useState(false);

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

  // §33 マクロ「テキスト一括置換」をコマンドレジストリへ登録（ドロップダウン＋Ctrl ダブルタップ共通）。
  // 将来の機能はここに registerCommand を足すだけで両経路にトリガが増える。
  useEffect(() => {
    return registerCommand({
      id: "macro.textBulkReplace",
      path: [
        { key: "m", label: "マクロ" },
        { key: "t", label: "テキスト一括置換" },
      ],
      run: () => setShowTextBulkReplace(true),
    });
  }, []);

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
  const isDesktop = typeof window !== "undefined" && !!window.mafterDesktop?.isElectron;

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#111", color: "#ccc", overflow: "hidden", fontFamily: "system-ui, sans-serif" }}>
      {/* menu bar（Electron ではタイトルバー兼ドラッグ領域） */}
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 4, padding: "4px 12px", background: "#1a1a1a", borderBottom: "1px solid #333", fontSize: 12, ...(isDesktop ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : {}) }}>
        <span style={{ fontWeight: "bold", color: "#7fb8f0", marginRight: 8 }}>Mafter Effect</span>
        <button onClick={undo} disabled={!canUndo} style={menuBtnStyle(canUndo)}>↩ Undo</button>
        <button onClick={redo} disabled={!canRedo} style={menuBtnStyle(canRedo)}>↪ Redo</button>
        <span style={{ color: "#555", fontSize: 11, marginLeft: 2 }}>
          {canUndo ? `${undoStack.past.length} op` : "clean"}
        </span>
        <span style={{ color: "#444", marginLeft: 4 }}>|</span>
        <MacroMenu />
        <span style={{ flex: 1 }} />
        {isFeedbackEnabled() && (
          <button onClick={() => setShowFeedbackModal(true)} style={feedbackLinkStyle}>
            バグ報告 / フィードバックを送信
          </button>
        )}
        <span style={{ color: "#555", fontSize: 10 }}>M1 preview</span>
        {isDesktop && <WindowControls />}
      </div>

      {/* workspace */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        <WorkspaceLayout node={workspace.layout} onSizesChange={handleSizesChange} onTabsChange={handleTabsChange} />
      </div>

      {/* 単一コントローラのコンテキストメニュー描画ホスト（body ポータル） */}
      <ContextMenuHost />

      {/* §33 コマンドモード HUD（Ctrl ダブルタップで起動） */}
      <CommandMenuOverlay />

      {/* フィードバックループ: 不便シグナルの催促トースト（doc/feedback-loop.md） */}
      <FeedbackPrompt />

      {showFeedbackModal && <FeedbackSendModal onClose={() => setShowFeedbackModal(false)} />}

      {showTextBulkReplace && <TextBulkReplaceDialog onClose={() => setShowTextBulkReplace(false)} />}
    </div>
  );
}

const feedbackLinkStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#7fb8f0",
  cursor: "pointer",
  padding: "2px 8px",
  fontSize: 11,
  textDecoration: "underline",
  marginRight: 8,
  WebkitAppRegion: "no-drag",
} as React.CSSProperties;

function menuBtnStyle(enabled: boolean): React.CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: enabled ? "#bbb" : "#555",
    cursor: enabled ? "pointer" : "default",
    padding: "2px 8px",
    fontSize: 12,
    borderRadius: 3,
    WebkitAppRegion: "no-drag",
  } as React.CSSProperties;
}

/** Electron 用の自前ウィンドウ操作ボタン（VS Code 風・右端）。全 OS で同一デザイン。 */
function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const desktop = window.mafterDesktop;
    if (!desktop) return;
    desktop.isMaximized().then(setMaximized).catch(() => {});
    return desktop.onMaximizeChange(setMaximized);
  }, []);

  const btnStyle: React.CSSProperties = {
    background: "transparent",
    border: "none",
    color: "#bbb",
    cursor: "pointer",
    padding: "2px 10px",
    fontSize: 12,
    marginLeft: 4,
    WebkitAppRegion: "no-drag",
  } as React.CSSProperties;

  return (
    <span style={{ display: "flex", alignItems: "center", marginLeft: 8 }}>
      <button onClick={() => window.mafterDesktop?.minimize()} style={btnStyle} title="最小化">
        ⎯
      </button>
      <button onClick={() => window.mafterDesktop?.toggleMaximize()} style={btnStyle} title={maximized ? "元に戻す" : "最大化"}>
        {maximized ? "❐" : "▢"}
      </button>
      <button
        onClick={() => window.mafterDesktop?.close()}
        style={{ ...btnStyle, marginRight: -4 }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "#e33")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "#bbb")}
        title="閉じる"
      >
        ✕
      </button>
    </span>
  );
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
