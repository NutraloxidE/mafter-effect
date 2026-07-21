// §33 純ロジック（レンダラ非依存・INV-1 整合）— CommandLeaf 群を key 列でツリーへ畳み込み、
// path でのナビゲーションを解決する。副作用・乱数・時刻・DOM を持たない。

import type { CommandLeaf, CommandNode } from "./types";

/**
 * leaves を path の key 列でツリーへ畳み込む。
 * - 中間ノードのラベルは最初に登録した leaf のものを採用（安定・登録順保持）。
 * - 同一 path の葉が複数あれば後勝ちで run/hint を上書きする。
 */
export function buildCommandTree(leaves: CommandLeaf[]): CommandNode[] {
  const roots: CommandNode[] = [];
  for (const leaf of leaves) {
    if (leaf.path.length === 0) continue;
    let level = roots;
    let node: CommandNode | undefined;
    for (const seg of leaf.path) {
      const key = seg.key.toLowerCase();
      node = level.find((n) => n.key === key);
      if (!node) {
        node = { key, label: seg.label, children: [] };
        level.push(node);
      }
      level = node.children;
    }
    if (node) {
      node.run = leaf.run;
      if (leaf.hint !== undefined) node.hint = leaf.hint;
    }
  }
  return roots;
}

/** path（キー列）を辿った位置の子ノード群を返す。途中で見つからなければ null。 */
export function resolveLevel(roots: CommandNode[], path: string[]): CommandNode[] | null {
  let level = roots;
  for (const key of path) {
    const node = level.find((n) => n.key === key.toLowerCase());
    if (!node) return null;
    level = node.children;
  }
  return level;
}

/** path が指すノード自体（末尾ノード）を返す。ルート直下は path 長 1。 */
export function nodeAtPath(roots: CommandNode[], path: string[]): CommandNode | null {
  let level = roots;
  let node: CommandNode | null = null;
  for (const key of path) {
    const found = level.find((n) => n.key === key.toLowerCase());
    if (!found) return null;
    node = found;
    level = found.children;
  }
  return node;
}

/** path 上の各ノードのラベル列（パンくず用）。途中で外れたらそこまで返す。 */
export function pathLabels(roots: CommandNode[], path: string[]): string[] {
  const labels: string[] = [];
  let level = roots;
  for (const key of path) {
    const node = level.find((n) => n.key === key.toLowerCase());
    if (!node) break;
    labels.push(node.label);
    level = node.children;
  }
  return labels;
}
