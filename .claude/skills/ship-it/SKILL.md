---
name: ship-it
description: 現在の作業ツリーを論理的なコミットに分割し、push して PR を作るまでを一気に行う。分割とコミットメッセージ・PR 文面の生成は Sonnet 5 low の commit-planner subagent に任せ、git 操作はスクリプトが実行する（親コンテキストは diff を読まない＝最小トークン）。ユーザーが「コミットして」「push して PR 作って」「ship して」等と言ったときに使う。
---

# ship-it — commit 分割 → push → PR

親（あなた）は **diff を読まない**。読むのは Sonnet 5 low の subagent だけ。git 操作は全部スクリプト。

## 手順

### 1. context を書き出す

```powershell
node .claude/skills/ship-it/scripts/ship.mjs context $env:TEMP\ship-context.md
```

変更ファイルが 0 なら終了（「コミットする変更がない」と伝える）。

### 2. commit-planner に投げる（同期）

Agent tool: `subagent_type: "commit-planner"`, `run_in_background: false`。プロンプトは context / 出力先パスだけ:

```
Context: <context path>
Write the plan JSON to: <plan path>
Reply with only that path.
```

戻り値は JSON ではなくパス。**親は plan を読まない**（読むと分割のトークンを二重に払う）。

### 3. 適用する

```powershell
node .claude/skills/ship-it/scripts/ship.mjs apply $env:TEMP\ship-plan.json
```

`--dry-run` でコミットせず内容表示、`--no-pr` で push まで。スクリプトは:

- plan のファイル集合が `git status` と完全一致するか検証（漏れ・重複・幽霊は fail）
- main/master 上では拒否
- 1 コミットずつ `add` → `commit`（`Co-Authored-By` 付与）
- `git push -u origin <branch>`
- PR が既存なら push だけして URL を報告、なければ `gh pr create --base main`

### 4. 報告

PR URL とコミット件名だけ。diff の解説はしない。

## 失敗したら

| エラー | 対処 |
|--------|------|
| `plan does not match working tree` | context 生成後に作業ツリーが変わった。1 からやり直す |
| `refusing to commit on main` | ブランチを切ってから再実行 |
| pre-commit hook 失敗 | 直して再実行（`--no-verify` は使わない）。既にコミット済みの分は残るので、plan を残りのファイルだけに直すか手で続ける |

## やらないこと

- ランタイム変更時の `npm run build:player`（CLAUDE.md 参照）はこのスキルの範囲外。**先に済ませてから** ship する
- spec / progress.md の更新も事前に済ませる（implementation-loop の責務）
