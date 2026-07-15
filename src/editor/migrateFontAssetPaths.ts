// フォントアセットの置き場を assets/font/ に揃えるための移行（§3 プロジェクト構造）。
// assets/font/ 導入前のプロジェクトはフォントが assets/ 直下に散らばっているため、
// 読み込み時に一度だけ移送する。

import { DIR_ASSETS_FONTS } from "../core/paths";
import type { Project } from "../core/schema";

export interface FontAssetMove {
  id: string;
  from: string;
  to: string;
}

function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "ttf";
}

/** 移送が必要な font asset を列挙する純関数。 */
export function planFontAssetMigration(project: Project): FontAssetMove[] {
  const moves: FontAssetMove[] = [];
  for (const a of project.assets) {
    if (a.kind !== "font") continue;
    if (a.path.startsWith(`${DIR_ASSETS_FONTS}/`)) continue;
    moves.push({ id: a.id, from: a.path, to: `${DIR_ASSETS_FONTS}/${a.id}.${extensionOf(a.path)}` });
  }
  return moves;
}

/** 移送後の project（純関数）。path 以外は変更しない。 */
export function applyFontAssetMigration(project: Project, moves: FontAssetMove[]): Project {
  if (moves.length === 0) return project;
  const byId = new Map(moves.map((m) => [m.id, m.to]));
  return {
    ...project,
    assets: project.assets.map((a) => {
      const to = byId.get(a.id);
      return to === undefined ? a : { ...a, path: to };
    }),
  };
}
