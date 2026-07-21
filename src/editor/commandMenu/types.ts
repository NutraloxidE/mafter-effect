// §33 コマンドメニュー（キーボードリーダー） — メニューバーのドロップダウンと
// Ctrl ダブルタップ→キー列の両方が参照する共通データモデル。
// レンダラ・project.json 非依存（UI 層のみ）。

/** ルート→葉の 1 階層。key はその階層を選ぶ単一キー。 */
export interface CommandPathSegment {
  key: string; // 単一キー（小文字正規化して比較）
  label: string; // 表示名
}

/** 機能側が登録する「実行可能なコマンド」。path の末尾が葉。 */
export interface CommandLeaf {
  id: string; // 一意 ID（重複排除・登録解除に使用）
  path: CommandPathSegment[]; // 例: [{key:"m",label:"マクロ"},{key:"t",label:"テキスト一括置換"}]
  run: () => void;
  hint?: string; // 補足説明（任意・HUD に表示）
}

/** path 群から組み立てたナビゲーション用ツリーノード。 */
export interface CommandNode {
  key: string;
  label: string;
  hint?: string;
  children: CommandNode[];
  run?: () => void; // 葉のみ設定される
}
