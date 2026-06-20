import type { AssetEntry, Project, TimelineComposition } from "../core/schema";
import { canonicalStringify } from "../core/serialize";
import { MAX_COMP_NEST_DEPTH } from "../runtime/compLayer";

// §28.11 comp 内容ハッシュ（content hash 基準の precomp キャッシュ同一性）。
//
//   グローバル projectRevision と独立に「その comp の見た目が変わったか」だけを表す
//   安定ハッシュ。comp(A) のレンダリングに効く内容（objects/effects/参照アセット/被参照
//   ネスト comp の内容）から導出する。comp(B) を編集しても comp(A) の内容が不変なら
//   ハッシュは不変 → precomp キャッシュを流用できる（§28.11）。

/** FNV-1a 32bit（決定論・純関数）。キーを短く保つための文字列ハッシュ。 */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function findTimelineComp(project: Project, compId: string): TimelineComposition | null {
  const c = project.compositions.find((x) => x.id === compId);
  return c && c.kind === "timeline" ? (c as TimelineComposition) : null;
}

/** props を深く走査し、asset id 集合に含まれる文字列値を収集する。 */
function collectAssetIds(value: unknown, assetIds: Set<string>, out: Set<string>): void {
  if (typeof value === "string") {
    if (assetIds.has(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectAssetIds(v, assetIds, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectAssetIds(v, assetIds, out);
    }
  }
}

/** comp が参照するネスト compId 一覧（component.type === "comp" の props.compId）。 */
function nestedCompIds(comp: TimelineComposition): string[] {
  const ids: string[] = [];
  for (const obj of comp.objects) {
    for (const c of obj.components) {
      if (c.type === "comp") {
        const id = c.props["compId"];
        if (typeof id === "string") ids.push(id);
      }
    }
  }
  return ids;
}

function compContentString(
  project: Project,
  compId: string,
  assetIds: Set<string>,
  visiting: Set<string>,
  depth: number,
): string {
  const comp = findTimelineComp(project, compId);
  if (!comp) return `missing:${compId}`;
  if (visiting.has(compId)) return `cycle:${compId}`; // 循環は打ち切り（§23.4 同型ガード）
  if (depth > MAX_COMP_NEST_DEPTH) return `depth:${compId}`;
  visiting.add(compId);

  // objects は id 昇順（配列順に意味を持たせない・§5.4-note）。
  const canonComp: TimelineComposition = {
    ...comp,
    objects: [...comp.objects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };

  // 参照アセット（id+path+kind+meta）を畳み込む。アセット差し替えでハッシュが変わる。
  const referenced = new Set<string>();
  collectAssetIds(comp.objects, assetIds, referenced);
  const assets: AssetEntry[] = project.assets
    .filter((a) => referenced.has(a.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // 被参照ネスト comp の内容ハッシュも畳み込む（変更が親へ伝播）。
  const nested: Record<string, string> = {};
  for (const childId of [...new Set(nestedCompIds(comp))].sort()) {
    nested[childId] = compContentString(project, childId, assetIds, visiting, depth + 1);
  }

  visiting.delete(compId);
  return canonicalStringify({ comp: canonComp, assets, nested });
}

/**
 * comp(A) の内容ハッシュ（§28.11）。projectRevision 非依存・純関数。
 * 同一内容なら同一ハッシュ。comp(A) を変えると変化。comp(B) のみ変えても不変。
 */
export function compContentHash(project: Project, compId: string): string {
  const assetIds = new Set(project.assets.map((a) => a.id));
  return fnv1a(compContentString(project, compId, assetIds, new Set(), 0));
}
