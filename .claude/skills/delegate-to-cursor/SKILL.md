---
name: delegate-to-cursor
description: Delegate a spec-confirmed implementation task to Cursor Agent via the `cursor-agent` CLI (--model auto, headless with --print --force --trust) in an isolated git worktree, then review the diff before merging. Use only when the design/spec decision is already finalized and the remaining work is pure implementation (code/tests/build to green). Tracks each run in .cursor/delegations/registry.json (DG-ID) for cross-session Claude visibility. For parallel runs, verify-fix loops, resume, and FB batching, use orchestrate-cursor-agents instead. Do not use while spec is still ambiguous, and do not invoke unprompted — only when the user asks to delegate/hand off to Cursor.
---

# Cursor Agent への実装委任 — 単発

**並列・リトライ・バッチ・resume で Cursor を回す**場合は正本 **[orchestrate-cursor-agents](../orchestrate-cursor-agents/SKILL.md)** を使う。本スキルは **1 タスク 1 起動**の最短手順 + **追跡レジストリ**が正本。

## 追跡の正本（Claude が最初に読む）

| 何 | どこ |
|----|------|
| 委任一覧・状態 | [`.cursor/delegations/registry.json`](mdc:.cursor/delegations/registry.json) |
| CLI 操作 | [`scripts/delegation.mjs`](scripts/delegation.mjs) |
| 完了の散文記録 | [progress.md](mdc:progress.md) 末尾 1 行（DG-ID を必ず含める） |

**セッション開始時**（委任の有無を確認するとき）:

```powershell
node .claude/skills/delegate-to-cursor/scripts/delegation.mjs list --active
```

未マージ・レビュー待ちがあれば `show <DG-id>` で worktree パス / chatId / blockers を復元してから作業する。

## DG-ID とステータス

- **ID 形式**: `DG-YYYYMMDD-NN`（例: `DG-20260703-01`）。FB-ID とは独立。1 委任 = 1 DG-ID。
- **ステータス遷移**:

```
planned → running → pending_review → approved → merged
                  ↘ review_failed → running (resume) ↗
                  ↘ abandoned
```

| status | 意味 | Claude の次アクション |
|--------|------|----------------------|
| `planned` | ID 発行済み、未起動 | cursor-agent 起動 |
| `running` | Cursor 実行中 | 完了待ち |
| `pending_review` | Cursor 完了、レビュー待ち | レビューゲート実行 |
| `review_failed` | テスト等 NG | `--resume <chatId>` で修正依頼 |
| `approved` | ユーザーがマージ承認 | マージ実行 |
| `merged` | main 取り込み済み | worktree 後始末 |
| `abandoned` | 中止 | 理由を notes に残す |

## 前提

- spec 確定（[doc/mafter-effect-spec.md](mdc:doc/mafter-effect-spec.md) に曖昧点なし）
- `cursor-agent status` がログイン済み
- ユーザーが委任を明示

## 手順（追跡付き）

### 0. レジストリに登録（起動前・必須）

```powershell
node .claude/skills/delegate-to-cursor/scripts/delegation.mjs new `
  --task "何を実装するか（1 行）" `
  --spec "§16.1" `
  --worktree "cursor-<topic>-<YYYYMMDD>"
```

出力の `id`（DG-ID）と `worktreeName` を控える。FB 由来なら `--fb FB-20260703-01` も付ける。

### 1. プロンプト

プロンプト**先頭 1 行**に DG-ID を埋め込む（Cursor 側 progress 追記用）:

```
[DG-20260703-01] Mafter Effect 実装委任

<task>: 何を実装するか（spec 節番号）
<acceptance>: typecheck / test / build 緑。runtime 変更時は build:player
<constraints>: §5・INV・project.json 形式は変更しない。曖昧なら止めて報告。
<record>: progress.md 末尾に (Cursor 委任) DG-20260703-01 <要約> を 1 行追記
```

### 2. 起動

```powershell
# ステータス更新
node .claude/skills/delegate-to-cursor/scripts/delegation.mjs update DG-20260703-01 --status running

# 起動（JSON で chatId を取得 — resume 用）
cursor-agent -p --force --trust --model auto -w cursor-<topic>-<YYYYMMDD> --output-format json "<上記プロンプト>" | Tee-Object -FilePath .cursor/delegations/runs/DG-20260703-01.json
```

`runs/` は git 追跡外（生出力ログ）。chatId 抽出:

```powershell
Get-Content .cursor/delegations/runs/DG-20260703-01.json | node .claude/skills/delegate-to-cursor/scripts/delegation.mjs parse-json
```

```powershell
node .claude/skills/delegate-to-cursor/scripts/delegation.mjs update DG-20260703-01 `
  --status pending_review `
  --chat-id "<session_id>" `
  --worktree-path "C:\Users\...\cursor\<reponame>\cursor-<topic>-<YYYYMMDD>" `
  --note "cursor-agent 完了"
```

worktree パスは `git worktree list` から取得可。

### 3. レビュー

worktree 内で検証。**詳細チェックリストは [orchestrate-cursor-agents §レビューゲート](../orchestrate-cursor-agents/SKILL.md#レビューゲートマージ前claude-必須)**。

```powershell
cd <worktree-path>
npm run typecheck
npm test
npm run build
git diff <base-branch>..HEAD --stat
```

結果をレジストリに反映:

```powershell
node .claude/skills/delegate-to-cursor/scripts/delegation.mjs update DG-20260703-01 `
  --review-key typecheck --review-value pass `
  --review-key test --review-value "686 pass"
```

失敗時:

```powershell
node .claude/skills/delegate-to-cursor/scripts/delegation.mjs update DG-20260703-01 `
  --status review_failed `
  --blocker "typecheck: src/foo.ts(42) error TS..."
```

→ [orchestrate-cursor-agents §パターン C](../orchestrate-cursor-agents/SKILL.md#パターン-c--verify-fix-ループぶん回しの核心) で `--resume <chatId>` リトライ（最大 3 回）。

### 4. マージ

ユーザー確認後のみ。

```powershell
node .claude/skills/delegate-to-cursor/scripts/delegation.mjs update DG-20260703-01 --status approved
# マージ実行（cherry-pick / 手動 apply 等）
node .claude/skills/delegate-to-cursor/scripts/delegation.mjs update DG-20260703-01 --status merged --note "main へマージ済み"
git worktree remove <worktree-path>
```

`progress.md` 末尾（**DG-ID 必須**）:

```markdown
### YYYY-MM-DD（Cursor 委任）— <要約> ✅
- **DG-ID**: DG-20260703-01 | worktree: `cursor-<topic>-<YYYYMMDD>` | chatId: `<uuid>` | マージ: `<commit>` or 手動
```

## クイック参照（Claude 向け）

```powershell
# 未完了委任一覧
node .claude/skills/delegate-to-cursor/scripts/delegation.mjs list --active

# 1 件の全フィールド
node .claude/skills/delegate-to-cursor/scripts/delegation.mjs show DG-20260703-01

# 次に使う ID を確認だけ
node .claude/skills/delegate-to-cursor/scripts/delegation.mjs next-id
```

## アンチパターン

| やってはいけない | 理由 |
|----------------|------|
| DG-ID なしで cursor-agent 起動 | セッション跨ぎで worktree / chatId が失われる |
| registry 更新を progress.md だけに頼る | 構造化検索・resume 復元ができない |
| `pending_review` のまま放置 | マージ待ちが見えなくなる |
| chatId を保存しない | verify-fix / resume が不能 |

## 関連

- 並列・ループ: [orchestrate-cursor-agents](../orchestrate-cursor-agents/SKILL.md)
- Cursor 側品質: [implementation-loop](../implementation-loop/SKILL.md)
