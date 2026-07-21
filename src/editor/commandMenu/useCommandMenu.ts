// §33 Ctrl ダブルタップ→キー列のリーダーキー機構。
// - Ctrl を素早く 2 回タップ（間に他キーを挟まない）でコマンドモードを起動。
// - 起動後は登録済みツリーをキーで辿る（子があれば潜り、葉なら run して終了）。
// - Esc / 背景クリック / 無操作タイムアウトでキャンセル。
// 検出の純粋部分は leaderTap.ts に分離（テスト可能）。

import { useCallback, useEffect, useRef, useState } from "react";
import { useCommandTree } from "./useCommandTree";
import { resolveLevel } from "./commandTree";
import { isSecondTap } from "./leaderTap";
import type { CommandNode } from "./types";

const IDLE_TIMEOUT_MS = 3000;

export interface CommandMenuState {
  active: boolean;
  path: string[];
  tree: CommandNode[];
  cancel: () => void;
}

export function useCommandMenu(): CommandMenuState {
  const tree = useCommandTree();
  const [active, setActive] = useState(false);
  const [path, setPath] = useState<string[]>([]);

  // リスナは 1 度だけ張り、最新値は ref 経由で読む（再インストールを避ける）。
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const activeRef = useRef(active);
  activeRef.current = active;
  const pathRef = useRef(path);
  pathRef.current = path;

  // リーダー検出用の状態
  const ctrlDownRef = useRef(false);
  const ctrlModifiedRef = useRef(false); // この Ctrl 押下中に他キーが押されたか
  const lastTapRef = useRef(0); // 直近の「単独 Ctrl タップ」時刻
  const idleTimerRef = useRef<number | null>(null);

  const cancel = useCallback(() => {
    setActive(false);
    setPath([]);
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const armIdle = useCallback(() => {
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => cancel(), IDLE_TIMEOUT_MS);
  }, [cancel]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (activeRef.current) {
        // コマンドモード中：ナビゲーションキーを奪う。
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
          return;
        }
        if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const level = resolveLevel(treeRef.current, pathRef.current) ?? [];
        const node = level.find((n) => n.key === e.key.toLowerCase());
        if (!node) return; // 未対応キーは無視（モードは維持）
        if (node.children.length > 0) {
          setPath((p) => [...p, node.key]);
          armIdle();
        } else if (node.run) {
          const run = node.run;
          cancel();
          run();
        }
        return;
      }

      // 非アクティブ時：ダブルタップ判定のための状態追跡。
      if (e.key === "Control") {
        if (!e.repeat) {
          ctrlDownRef.current = true;
          ctrlModifiedRef.current = false;
        }
        return;
      }
      // Ctrl 以外の実キー押下 → タップ連鎖を断ち、修飾扱いを記録。
      if (ctrlDownRef.current || e.ctrlKey) ctrlModifiedRef.current = true;
      lastTapRef.current = 0;
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Control") return;
      ctrlDownRef.current = false;
      if (activeRef.current) return;
      if (ctrlModifiedRef.current) {
        // Ctrl+X として使われた → タップではない。
        ctrlModifiedRef.current = false;
        lastTapRef.current = 0;
        return;
      }
      const now = Date.now();
      if (isSecondTap(lastTapRef.current, now)) {
        lastTapRef.current = 0;
        if (treeRef.current.length > 0) {
          setActive(true);
          setPath([]);
          armIdle();
        }
      } else {
        lastTapRef.current = now;
      }
    };

    // capture: true で他のハンドラ・input より先に奪う（コマンドモード中の M/T が入力に漏れない）。
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [cancel, armIdle]);

  return { active, path, tree, cancel };
}
