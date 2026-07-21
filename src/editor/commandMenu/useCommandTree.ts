// §33 レジストリを購読して CommandNode ツリーを返す共有フック。
// ドロップダウン（MacroMenu）と HUD（CommandMenuOverlay）の双方から使う。

import { useMemo, useSyncExternalStore } from "react";
import { commandRegistry } from "./commandRegistry";
import { buildCommandTree } from "./commandTree";
import type { CommandNode } from "./types";

const subscribe = (cb: () => void) => commandRegistry.subscribe(cb);
const getSnapshot = () => commandRegistry.getLeaves();

export function useCommandTree(): CommandNode[] {
  const leaves = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => buildCommandTree(leaves), [leaves]);
}
