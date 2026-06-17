// §19 UI / ワークスペース。エンジン SSoT とは独立した UI 層（runtime に混ぜない, INV-7）。
// レイアウト状態は project.json に入れない（§19.3）。ユーザ設定ストアに保存しプロジェクト横断で保持。

export type PanelId =
  | "preview"
  | "timeline"
  | "project" // assets
  | "inspector"
  | "ease"
  | "log";

// §19.2 直列化可能なレイアウトツリー（VSCode / docking lib と同型）。
// MVP は固定ツリー + split.sizes のスプリッタ resize のみ可変。
// ドラッグ・ドッキング / tabs 並べ替え / パネル追加削除は §19.4 将来（このツリーを編集可能にする増分）。
export type LayoutNode =
  | { type: "split"; dir: "row" | "col"; sizes: number[]; children: LayoutNode[] }
  | { type: "tabs"; active: number; panels: PanelId[] }
  | { type: "panel"; panel: PanelId };

// §19.2 MVP 既定レイアウト: 中央 preview / 下 timeline / 左 project / 右 ease+inspector。
// 外側 row: [左 project | 中央列 | 右列]、中央列 col: [preview / timeline]、右列 col: [ease / inspector]。
export function rightColumnLayout(): LayoutNode {
  return {
    type: "split",
    dir: "col",
    sizes: [0.38, 0.62],
    children: [
      { type: "panel", panel: "ease" },
      { type: "panel", panel: "inspector" },
    ],
  };
}

/** 右カラムに ease パネルが常時見えるようレイアウトを補正する（localStorage 旧レイアウト移行用）。 */
export function ensureEasePanelVisible(layout: LayoutNode): LayoutNode {
  if (layout.type !== "split" || layout.dir !== "row" || layout.children.length < 3) return layout;
  const right = layout.children[2];
  if (!right) return layout;

  const easeVisible =
    right.type === "panel"
      ? right.panel === "ease"
      : right.type === "split" && right.dir === "col" && right.children[0]?.type === "panel" && right.children[0].panel === "ease";

  if (easeVisible) return layout;

  return {
    ...layout,
    children: layout.children.map((child, i) => (i === 2 ? rightColumnLayout() : child)),
  };
}

export function defaultLayout(): LayoutNode {
  return {
    type: "split",
    dir: "row",
    sizes: [0.18, 0.62, 0.20],
    children: [
      { type: "panel", panel: "project" },
      {
        type: "split",
        dir: "col",
        sizes: [0.7, 0.3],
        children: [
          { type: "panel", panel: "preview" },
          { type: "panel", panel: "timeline" },
        ],
      },
      rightColumnLayout(),
    ],
  };
}

export const WORKSPACE_SCHEMA_VERSION = 1 as const;

export interface WorkspaceState {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  layout: LayoutNode;
}

export function defaultWorkspace(): WorkspaceState {
  return { schemaVersion: WORKSPACE_SCHEMA_VERSION, layout: defaultLayout() };
}
