/** Fixed right padding (px) so action buttons stay aligned at the panel edge. */
export const PROJECT_TREE_ROW_PAD_RIGHT = 6;

/** Left padding (px) for project tree rows at a given folder nesting depth. */
export function projectTreeRowPadLeft(depth: number): number {
  return 10 + depth * 14;
}
