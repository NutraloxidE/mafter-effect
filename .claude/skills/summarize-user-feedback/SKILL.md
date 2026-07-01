---
name: summarize-user-feedback
description: 収穫済みユーザーフィードバック（feedback/inbox/*.jsonl）を意味のあるテーマに要約し feedback/reports/summary-*.md を書く。Cursor / Claude Code / その他任意の coding Agent が本 SKILL.md を読めば同じ手順で実行できる（Agent 非依存）。npm run harvest:feedback 実行後、または「フィードバックを要約して」等の依頼時に使う。コード変更・spec 変更・修正提案は行わない（それは propose-from-user-feedback の仕事）。
---

# ユーザーフィードバック要約

デプロイ先エディタから収穫した「不便シグナル」＋任意コメントの生データを、人間が読める要約に変換する。
doc/feedback-loop.md が運用正本。本スキルは **要約のみ**を行い、コード変更・spec 変更・修正提案は行わない。

**Agent 非依存**: Cursor / Claude Code / 他の coding Agent のいずれでもよい。`npm` / `node` / ファイル
読み書きのみで完結する（Cursor 専用 API・MCP・Automation は不要）。

## いつ使うか

- `npm run harvest:feedback` の実行後、または [`feedback/inbox/`](../../../feedback/inbox/) に
  `*.jsonl` が増えたとき
- ユーザーが「フィードバックを要約して」と依頼したとき

## 入力

- [`feedback/inbox/*.jsonl`](../../../feedback/inbox/)（生データ。1行1イベント、スキーマは
  [doc/feedback-payload.md](../../../doc/feedback-payload.md)）
- 任意: 直近の `feedback/reports/summary-*.md`（差分把握・テーマの継続性確認用）

## 手順

1. [progress.md](../../../progress.md) を読み、既知バグ・進行中タスクと重複しそうな項目を頭に入れる。
2. `feedback/inbox/` が空、またはファイルが存在しない場合は `npm run harvest:feedback` を実行してリモートから収穫する。
3. `node scripts/summarize-feedback.mjs` を実行する（決定論の集計 JSON が stdout に出る:
   `rawEventCount` / `sessionCount` / `signalCounts` / `dailyCounts` / `quotes`）。
   - 特定日だけ見たい場合は `node scripts/summarize-feedback.mjs --date YYYY-MM-DD`。
   - **rawEventCount が 0 の場合はここで停止**し、ユーザーに「フィードバックはまだありません」と報告して終了する
     （空の summary ファイルは書かない。S2）。
4. スクリプト出力（signalCounts の頻度・quotes の文面）を読み、**意味のあるテーマ**に人手で再編する。
   単純な集計の丸写しではなく、例えば `export_error` + `zip_error` + 関連する quote が同じ根本原因を
   指していそうなら1テーマにまとめる。
5. [`feedback/reports/summary-YYYY-MM-DD.md`](../../../feedback/reports/) を、下記テンプレートに従って書く。
   - `YYYY-MM-DD` は実行日（今日の日付）。
   - **同日に複数回実行した場合は上書きする**（`-v2` 等のサフィックスは付けない。履歴は git に残る。S1）。
6. 完了報告: 件数・主要テーマ・生成したファイルパス・次スキル
   [propose-from-user-feedback](../propose-from-user-feedback/SKILL.md) へのポインタをチャットに提示する。

## summary 出力テンプレート

```markdown
# User feedback summary — YYYY-MM-DD

## Stats
- Raw events: N (sessions: M)
- Top signals: export_error (k), undo_burst (j), …

## Themes
### Theme: <short title>
- Evidence: signal counts + quoted user text (max 3)
- Suspected area: export | video | timeline | zip | inspector | …
- Overlap with known issues: progress.md §… or none

## Noise / low confidence
- Items to deprioritize and why
```

## このスキルがやらないこと

- コード変更・spec 変更
- 修正提案の作成（[propose-from-user-feedback](../propose-from-user-feedback/SKILL.md) の仕事）
- git commit
