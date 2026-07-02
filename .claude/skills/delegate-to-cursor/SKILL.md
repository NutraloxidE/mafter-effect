---
name: delegate-to-cursor
description: Delegate a spec-confirmed implementation task to Cursor Agent via the `cursor-agent` CLI (--model auto, headless with --print --force --trust) in an isolated git worktree, then review the diff before merging. Use only when the design/spec decision is already finalized and the remaining work is pure implementation (code/tests/build to green). For parallel runs, verify-fix loops, resume, and FB batching, use orchestrate-cursor-agents instead. Do not use while spec is still ambiguous, and do not invoke unprompted — only when the user asks to delegate/hand off to Cursor.
---

# Cursor Agent への実装委任 — 単発

**並列・リトライ・バッチ・resume で Cursor を回す**場合は正本 **[orchestrate-cursor-agents](../orchestrate-cursor-agents/SKILL.md)** を使う。本スキルは **1 タスク 1 起動**の最短手順のみ。

## 前提

- spec 確定（[doc/mafter-effect-spec.md](mdc:doc/mafter-effect-spec.md) に曖昧点なし）
- `cursor-agent status` がログイン済み
- ユーザーが委任を明示

## 手順

### 1. プロンプト

```
<task>: 何を実装するか（spec 節番号）
<acceptance>: typecheck / test / build 緑。runtime 変更時は build:player
<constraints>: §5・INV・project.json 形式は変更しない。曖昧なら止めて報告。
```

### 2. 起動

プロンプトは positional（末尾）。`agent` サブコマンドは付けない。

```powershell
cursor-agent -p --force --trust --model auto -w cursor-<topic>-<YYYYMMDD> --output-format text "<上記プロンプト>"
```

### 3. レビュー

worktree 内で `npm run typecheck; npm test; npm run build` と `git diff`。**詳細チェックリストは [orchestrate-cursor-agents §レビューゲート](../orchestrate-cursor-agents/SKILL.md#レビューゲートマージ前claude-必須)**。

### 4. マージ

ユーザー確認後のみ。完了後 `progress.md` に `(Cursor 委任)` 1 行、`git worktree remove` で後始末。
