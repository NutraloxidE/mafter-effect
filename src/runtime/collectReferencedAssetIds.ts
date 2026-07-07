// §Phase3（preview-rendering-pipeline-optimization-plan）: 起動時プレビューに表示される
// comp から参照されている asset を先に読み込むための優先集合を作る（純関数・DOM 非依存）。

import type { Project, TimelineComposition } from "../core/schema";

/**
 * `rootCompId` から到達可能な timeline comp（ネスト `comp` component を再帰、循環ガード付き）が
 * 参照する image/video の assetId を集める。ロード順序決定専用（project.json 直列化・resolve
 * には無関係）。
 */
export function collectReferencedAssetIds(project: Project, rootCompId: string): Set<string> {
  const result = new Set<string>();
  const visited = new Set<string>();
  const compById = new Map<string, TimelineComposition>(
    project.compositions
      .filter((c): c is TimelineComposition => c.kind === "timeline")
      .map((c) => [c.id, c]),
  );

  function visit(compId: string): void {
    if (visited.has(compId)) return;
    visited.add(compId);
    const comp = compById.get(compId);
    if (!comp) return;
    for (const obj of comp.objects) {
      for (const c of obj.components) {
        if (c.type === "image" || c.type === "video") {
          const assetId = c.props["asset"];
          if (typeof assetId === "string" && assetId) result.add(assetId);
        } else if (c.type === "comp") {
          const nestedCompId = c.props["compId"];
          if (typeof nestedCompId === "string" && nestedCompId) visit(nestedCompId);
        }
      }
    }
  }

  visit(rootCompId);
  return result;
}
