---
name: propose-from-user-feedback
description: 最新の feedback/reports/summary-*.md を基に、次にやるべき実装タスクを FB-YYYYMMDD-NN 形式で feedback/reports/proposals-*.md に提案する（コード変更・実装は行わないトリアージ専用）。Cursor / Codex / その他任意の coding Agent が本 SKILL.md を読めば同じ手順で実行できる（Agent 非依存）。summary が存在するとき、または「フィードバックから次のタスクを提案して」等の依頼時に使う。
---

# ユーザーフィードバックからの提案

[summarize-user-feedback](../summarize-user-feedback/SKILL.md) が書いた要約を基に、
「次に何を直すか」をトリアージし、承認待ちの提案リストを作る。**本スキール単体ではコミットしない**
（実装は含まない）。

**Agent 非依存**: Cursor / Codex / 他の coding Agent のいずれでもよい。

## いつ使うか

- `feedback/reports/summary-*.md` が存在し、何を直すか整理したいとき
- ユーザーが「フィードバックから次のタスクを提案して」と依頼したとき
- **実装に入る前**のトリアージ専用

## 入力

- 最新の [`feedback/reports/summary-*.md`](../../../feedback/reports/)
- [doc/mafter-effect-spec.md](../../../doc/mafter-effect-spec.md) の該当節
- [progress.md](../../../progress.md) の既知バグ・進行中タスク

## 手順

1. `feedback/reports/` 内でファイル名の日付が最も新しい `summary-*.md` を特定し、全文読む。
   - summary ファイルが1つも無ければ、ユーザーに
     「先に summarize-user-feedback（または run-feedback-loop）を実行してください」と報告して停止する。
2. summary 内の各テーマを次のいずれかに分類する: `bug` / `ux-friction` / `feature-request` / `noise`。
3. `progress.md` の既知バグ・進行中タスクと突き合わせ、**重複はマージ**する（新規提案として重複させない）。
4. 1 テーマ = 1 提案 ID（`FB-YYYYMMDD-NN` 形式。`YYYY-MM-DD` は実行日、`NN` は当日01始まりの連番）。
5. 各提案に **spec 影響**を必ず付与する: `none`（散文にも触れない）/ `prose-only`（spec の散文のみ）/
   `needs-user-approval`（§5 データスキーマまたは INV に触れる。ユーザー確認必須）。
6. 優先度は次を目安にする（Annex 参照）:
   - **P0**: 同一テーマが summary をまたいで3回以上再発、または `export_error`/`zip_error` 等の高重みシグナルが中心
   - **P1**: 初回だが具体的なユーザー文言があり、影響範囲が明確
   - **P2**: 要望ベース（feature-request）で緊急性が低い
7. [`feedback/reports/proposals-YYYY-MM-DD.md`](../../../feedback/reports/) を下記テンプレートで書く。
   - **append-only**: 既存の `proposals-*.md` は書き換えない。新しい提案は新しい日付ファイルに書く（G18）。
8. ユーザーに提案一覧（ID・タイトル・優先度）を提示し、**承認された ID のみ**
   [implementation-loop](../implementation-loop/SKILL.md) へ進めることを伝える。

## proposals 出力テンプレート

```markdown
# Feedback proposals — YYYY-MM-DD
Source: summary-YYYY-MM-DD.md

## FB-YYYYMMDD-01 — <title>
- Type: bug | ux-friction | feature-request
- Priority: P0 | P1 | P2
- Area: export | video | timeline | zip | inspector | …
- User evidence: …
- Hypothesis: …
- Spec impact: none | prose-only | needs-user-approval (§5/INV)
- Suggested fix (1–3 bullets, no code yet)
- Verify plan: which verify-* / npm test area
- Status: proposed | approved | rejected | done

## Deferred / noise
- …
```

## このスキルがやらないこと

- 承認前の実装・コミット
- §5 / INV 変更が必要な提案を、ユーザー確認なしで実装に進めること

## 実装フェーズへの引き渡し

ユーザーが提案 ID を承認したら、[implementation-loop](../implementation-loop/SKILL.md) Phase 0 から実装を開始する。
`progress.md` には完了時に `（FB-YYYYMMDD-NN 由来）` と明記する（`proposals-*.md` 自体は不変のまま残す。G18）。
