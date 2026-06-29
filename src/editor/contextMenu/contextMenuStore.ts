import type React from "react";
import { create } from "zustand";

// アプリ全体で1つだけ開くコンテキストメニューの単一コントローラ。
// プロジェクトデータ（FS の投影 = useEditorStore）とは独立した純 UI 状態。
export type ContextMenuItem =
  | {
      kind: "action";
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      danger?: boolean;
      icon?: React.ReactNode;
      shortcut?: string;
    }
  | { kind: "separator" };

export interface ContextMenuOpenState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

interface ContextMenuState {
  open: ContextMenuOpenState | null;
  openContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void;
  closeContextMenu: () => void;
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  open: null,
  // 空 items のときは開かない（右クリックしても何も出さない）。
  openContextMenu: (x, y, items) => {
    if (items.length === 0) return;
    set({ open: { x, y, items } });
  },
  closeContextMenu: () => set({ open: null }),
}));
