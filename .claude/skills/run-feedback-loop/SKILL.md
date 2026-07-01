---
name: run-feedback-loop
description: フィードバック収穫→要約→提案を一気通貫で実行する薄いオーケストレータ（日常運用の入口）。Cursor / Claude Code / その他任意の coding Agent が「スキルに基づきフィードバック集めて実装提案して」等の一文プロンプトで呼び出せる（Agent 非依存。特定 Agent 専用ではない）。実装・spec変更・コミットは一切行わない。
---

# フィードバック収穫ループ — オーケストレータ

[summarize-user-feedback](../summarize-user-feedback/SKILL.md) と
[propose-from-user-feedback](../propose-from-user-feedback/SKILL.md) を順に実行するだけの薄いスキル。
手順の詳細はどちらも自分自身の SKILL.md に書いてあるので、ここでは重複させない。

**Agent 非依存・日常の入口**: Cursor / Claude Code / 他の coding Agent のいずれでも、次の一文プロンプトで
呼び出せる（Agent 名を含めない）:

> スキルに基づきフィードバック集めて実装提案して

（任意）Cursor Automation 等の定期ジョブから呼んでもよいが、Automation は呼び出し元の1つに過ぎない。
本スキル自体は Automation なしでも完結する。

## いつ使うか

- 上記のような一文依頼（「フィードバック集めて」「実装提案して」等の日本語トリガー）
- harvest → 要約 → 提案まで一気にやりたいとき

## 手順

0. 本 SKILL.md を読んだら、直ちに [summarize-user-feedback](../summarize-user-feedback/SKILL.md) の
   SKILL.md を **全文読んで、そこに書かれた手順を最後まで実行する**。
1. summarize が「フィードバックはまだありません」で **0 件終了**した場合は、ここで停止し
   ユーザーにその旨を報告する（`propose-from-user-feedback` には進まない）。
2. summary が生成されたら、[propose-from-user-feedback](../propose-from-user-feedback/SKILL.md) の
   SKILL.md を **全文読んで、そこに書かれた手順を最後まで実行する**。
3. 生成された `feedback/reports/proposals-*.md` のファイルパスと、含まれる FB-ID 一覧
   （タイトル・優先度）をチャットに提示する。
4. **コード変更・spec 変更・コミットは一切しない**。実装はユーザーの FB-ID 承認と
   [implementation-loop](../implementation-loop/SKILL.md) 呼び出し待ちとする。承認プロンプト例:
   > `FB-YYYYMMDD-01` を承認。implementation-loop で実装して。

## このスキルがやらないこと

- 下位スキル（summarize / propose）の手順を再定義・重複記載すること
- 実装ループへ自動的に入ること（必ずユーザーの明示承認を待つ）
