import type { EffectDef } from "../runtime/plugin";

/** Inspector エフェクトピッカーのカテゴリ表示順。 */
export const EFFECT_PICKER_CATEGORY_ORDER = [
  "ぼかし",
  "カラー補正",
  "ディストーション",
  "ディストーション（軽量）",
  "ワイプ",
  "スタイライズ",
  "その他",
] as const;

const DEFAULT_CATEGORY = "その他";

export function groupEffectsForPicker(effects: readonly EffectDef[]): { category: string; effects: EffectDef[] }[] {
  const groups = new Map<string, EffectDef[]>();
  for (const effect of effects) {
    const category = effect.category ?? DEFAULT_CATEGORY;
    const list = groups.get(category) ?? [];
    list.push(effect);
    groups.set(category, list);
  }

  const ordered: { category: string; effects: EffectDef[] }[] = [];
  for (const category of EFFECT_PICKER_CATEGORY_ORDER) {
    const list = groups.get(category);
    if (list?.length) {
      ordered.push({ category, effects: list });
      groups.delete(category);
    }
  }
  for (const [category, list] of groups) {
    if (list.length) ordered.push({ category, effects: list });
  }
  return ordered;
}
