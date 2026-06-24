import type { Frame, Project, TimelineComposition } from "../core/schema";

/** §23.3: renderNestedComp の再帰深度上限（depth > 4 で打ち切り）。 */
export const MAX_COMP_NEST_DEPTH = 4;

/**
 * §23.2: 秒ベースの時間マッピング（AE 既定）。
 *   parentTimeSec = (parentFrame - inPoint) / parentFps
 *   childFrame    = clamp(round(parentTimeSec * childFps) + trimStart, 0, duration - 1)
 *
 * parentFps === childFps のとき従来式 `parentFrame - inPoint + trimStart` と完全一致（後方互換）。
 * trimStart は子コンプの frame 単位なのでリスケールしない。
 */
export function compChildFrame(
  parentFrame: Frame,
  inPoint: Frame,
  trimStart: Frame,
  childDuration: Frame,
  parentFps: number,
  childFps: number,
): Frame {
  const parentTimeSec = (parentFrame - inPoint) / parentFps;
  const raw = Math.round(parentTimeSec * childFps) + trimStart;
  return Math.max(0, Math.min(raw, childDuration - 1));
}

export function isCompNestDepthAllowed(depth: number): boolean {
  return depth <= MAX_COMP_NEST_DEPTH;
}

/**
 * §23.4 循環参照検出: parentCompId に childCompId を追加したとき循環が生じるか確認する。
 * childCompId から BFS し、parentCompId に到達できれば true。
 */
export function compWouldCreateCycle(p: Project, parentCompId: string, childCompId: string): boolean {
  const visited = new Set<string>();
  const stack = [childCompId];
  while (stack.length > 0) {
    const curr = stack.pop()!;
    if (visited.has(curr)) continue;
    visited.add(curr);
    const comp = p.compositions.find((c) => c.id === curr && c.kind === "timeline") as
      | TimelineComposition
      | undefined;
    if (!comp) continue;
    for (const obj of comp.objects) {
      for (const component of obj.components) {
        if (component.type === "comp") {
          const nestedId = component.props["compId"] as string | undefined;
          if (!nestedId) continue;
          if (nestedId === parentCompId) return true;
          stack.push(nestedId);
        }
      }
    }
  }
  return false;
}
