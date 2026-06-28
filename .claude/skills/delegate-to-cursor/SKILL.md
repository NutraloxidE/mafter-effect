---
name: delegate-to-cursor
description: Delegate a spec-confirmed implementation task to Cursor's Composer 2.5 agent via the `cursor-agent` CLI, running headlessly (--print --force) in an isolated git worktree, then review the diff before merging. Use only when the design/spec decision is already finalized (per the Claude Code=design / Cursor=implementation split in .cursor/rules/mafter-effect-agent.mdc) and the remaining work is pure implementation (code/tests/build to green). Do not use while spec is still ambiguous, and do not invoke unprompted — only when the user asks to delegate/hand off to Cursor.
---

# Cursor (Composer 2.5) への実装委任

`cursor-agent` CLI を使い、確定済み spec の実装作業を Cursor の Composer 2.5 に委任する。
このリポジトリの分業ルール（[.cursor/rules/mafter-effect-agent.mdc](mdc:.cursor/rules/mafter-effect-agent.mdc)）を
CLI 経由で実行する手段。**ユーザーから明示的に委任を頼まれたときのみ使う**（自発的に呼ばない）。

## 前提条件（委任前に必ず確認）

- 対象タスクの spec が確定している（[doc/mafter-effect-spec.md](mdc:doc/mafter-effect-spec.md) に曖昧な点がない）。
  曖昧なら委任せず、先にユーザーと spec を確定する。
- `cursor-agent` がインストール・ログイン済みであること（`cursor-agent status` で確認可。失敗したらユーザーに `cursor-agent login` を依頼）。
- 委任は **1 タスク = 1 起動**。大きすぎる依頼は分割する。

## 手順

### 1. プロンプトを組み立てる

タスクを具体的に書く。spec の該当セクション番号・受け入れ条件・「spec/CLAUDE.md は変更しない、曖昧な点は実装せず止めて報告する」という制約を明示する（`.cursor/rules` は worktree にも引き継がれて自動適用されるが、重要な制約は明示的に繰り返す）。

```
<task>: 何を実装するか（spec の節番号を含める）
<acceptance>: 受け入れ条件（npm run typecheck / npm test / npm run build を緑にする等。expression ランタイム変更時は npm run build:player 済みで public/player.js 更新）
<constraints>: spec/CLAUDE.md のスキーマ・不変条件は変更しない。曖昧・未確定の挙動を見つけたら実装で「事実上の仕様」にせず、変更せずに報告して止める。
```

### 2. 隔離 worktree で非対話実行する

```powershell
cursor-agent agent "<上記プロンプト>" -p --force --model composer-2.5 -w <worktree-name> --output-format text
```

- `-w <name>`: `~/.cursor/worktrees/<reponame>/<name>` に現在の HEAD から新規 worktree を作成して実行。メインの作業ツリーとは競合しない。
- `-p --force`: 非対話（スクリプト用）モード。`--force` は非対話実行がコマンド承認待ちでハングするのを防ぐために実質必須（= Cursor agent に shell/write の自律権限を与える）。
- `--model composer-2.5`: このプロジェクトの分業ルールで指定されているモデル。
- 出力から worktree のパス／ブランチ名を控える（完了報告に含まれる）。

### 3. 結果をレビューする（マージ前に必須）

worktree 内で:

```powershell
cd <worktree-path>
npm run typecheck; npm test; npm run build
git diff <base-branch>..HEAD --stat
```

- 緑が確認できない場合はマージしない。差分の内容（spec/CLAUDE.md が変更されていないか、INV-1〜6 を破っていないか）を確認する。
- **expression ランタイム / `src/player` / player が import する `src/runtime` を触った差分**では、`public/player.js` が `npm run build:player` で更新されていること（[test/playerBuildFreshness.test.ts](mdc:test/playerBuildFreshness.test.ts) 緑）をレビュー必須項目に含める。未実行ならマージ前に worktree で実行させる。
- UI/レンダリングに触る変更なら、`.claude/skills/implementation-loop/SKILL.md` の Playwright 実機検証が Cursor 側で行われたか diff・ログから確認する。

### 4. マージはユーザーに確認してから

差分とテスト結果をユーザーに要約報告し、メインブランチへの取り込み方法（`git merge` / cherry-pick など）を確認してから実行する。無断でメインに取り込まない。

### 5. 後始末

マージ後、不要になった worktree を削除する: `git worktree remove <worktree-path>`。

### 6. 記録

完了後、[progress.md](mdc:progress.md) に「(Cursor 委任)」を付けて 1 行追記する。
