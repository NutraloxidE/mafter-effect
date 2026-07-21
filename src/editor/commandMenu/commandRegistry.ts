// §33 コマンドレジストリ（UI 層のシングルトン）。
// 機能側は registerCommand({ id, path, run }) を呼ぶだけで、メニューのドロップダウンと
// Ctrl ダブルタップ→キー列の両方から起動可能になる（＝拡張点はここ 1 箇所）。
// getLeaves() は変更があるまで同一参照を返す（useSyncExternalStore の getSnapshot 契約）。

import type { CommandLeaf } from "./types";

type Listener = () => void;

class CommandRegistry {
  private leaves = new Map<string, CommandLeaf>();
  private cache: CommandLeaf[] | null = null;
  private listeners = new Set<Listener>();

  register(leaf: CommandLeaf): () => void {
    this.leaves.set(leaf.id, leaf);
    this.invalidate();
    return () => {
      if (this.leaves.delete(leaf.id)) this.invalidate();
    };
  }

  getLeaves(): CommandLeaf[] {
    if (this.cache === null) this.cache = [...this.leaves.values()];
    return this.cache;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private invalidate(): void {
    this.cache = null;
    for (const l of this.listeners) l();
  }
}

export const commandRegistry = new CommandRegistry();

/** 機能を 1 コマンドとして登録する。戻り値を呼ぶと登録解除（useEffect の cleanup 用）。 */
export function registerCommand(leaf: CommandLeaf): () => void {
  return commandRegistry.register(leaf);
}
