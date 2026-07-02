---
name: orchestrate-cursor-agents
description: Claude Code が cursor-agent CLI で Cursor Agent（--model auto）を headless 起動し、単発・並列・verify-fix ループ・resume で実装を回すためのオーケストレーション手順。ユーザーが「Cursor に委任」「並列で実装」「FB を一括実装」「verify まで回して」等を依頼したとき、または Claude が確定済みタスクを worktree 隔離で Cursor に渡すときに使う。単発委任の最小手順は delegate-to-cursor も参照可。
---

# Cursor Agent オーケストレーション（Claude Code 用）

**Claude Code = 指揮者**（spec 確定・タスク分割・プロンプト作成・差分レビュー・マージ判断）。
**Cursor Agent (auto) = 実装ワーカー**（`cursor-agent` CLI 経由、git worktree で隔離）。

このスキルは **Claude Code が Bash/PowerShell から `cursor-agent` を実行する** 前提。Cursor IDE 内の Agent ではない。

## いつ使うか

| トリガー | パターン |
|---------|---------|
| 「Cursor に実装を任せて」「Composer で回して」 | A 単発 |
| 独立タスクが複数（例: FB-01 / FB-02 / verify 追加） | B 並列 |
| テスト赤 → 修正 → 再テストを自動で数周 | C verify-fix ループ |
| 前回 Cursor の続き・追加指示 | D resume |
| 大きい変更の前に実装方針だけ Cursor に出す | E plan → implement |
| `feedback/reports/proposals-*.md` の FB-ID を順次/並列実装 | F バッチ |

**使わない**: spec / INV / §5 スキーマが未確定、ユーザーが委任を明示していない（自発的に Cursor を起動しない）。

## 前提（起動前に 1 回確認）

```powershell
cursor-agent status
cursor-agent models
```

- 未ログイン → ユーザーに `cursor-agent login` を依頼してから再開。
- 実装モデルは **`auto`**（Cursor がタスクに応じてモデルを選択）。**`--model` を省略しない**（CLI デフォルトは composer-2.5-fast 等になり得る）。
- リポジトリルートを cwd にする（`.cursor/rules` と `.claude/skills` が効く）。

## CLI 形式（headless 実行）

プロンプトは **positional 引数**（末尾）。`agent` サブコマンドは **付けない**（`cursor-agent agent ...` は冗長で混乱の元）。

```powershell
cursor-agent -p --force --trust --model auto -w <worktree-name> --output-format text "<prompt>"
```

| フラグ | 理由 |
|--------|------|
| `-p` / `--print` | 非対話。Claude の shell から完結させる |
| `--force` / `--yolo` | コマンド承認待ちでハングしない（実質必須） |
| `--trust` | workspace 信頼プロンプトをスキップ（headless 必須） |
| `-w <name>` | `~/.cursor/worktrees/<reponame>/<name>` に隔離 worktree。メイン作業ツリーと競合しない |
| `--worktree-base <ref>` | 必要ならベース ref を指定（省略時は現在 HEAD） |

**resume 用**（同一 worktree / 同一チャットに追記）:

```powershell
cursor-agent -p --force --trust --model auto --resume <chatId> --output-format text "<follow-up prompt>"
```

**plan のみ**（ファイル変更なし）:

```powershell
cursor-agent -p --force --trust --model auto --plan -w <name>-plan --output-format text "<prompt>"
```

**JSON で chatId を抜く**（resume 連鎖用）:

```powershell
cursor-agent -p --force --trust --model auto -w <name> --output-format json "<prompt>"
```

出力 JSON から `session_id` / chat ID を控え、C ループ・D フォローアップに使う。

## プロンプト骨格（毎回埋める）

Cursor 側にも `.cursor/rules` は効くが、**重要制約はプロンプトに繰り返す**。

```
<role>: Mafter Effect リポジトリの実装担当。CLAUDE.md と doc/mafter-effect-spec.md に従う。

<task>: （何をするか。spec 節番号・ファイルパス・FB-ID）

<acceptance>:
- npm run typecheck
- npm test（該当 verify-* があれば実行）
- npm run build
- expression ランタイム / src/player / player が import する src/runtime を触ったら npm run build:player と public/player.js 更新
- 視覚/レンダリング変更なら .claude/skills/implementation-loop/SKILL.md Phase 4 の Playwright 実機

<constraints>:
- INV-1〜6 を破らない
- §5 スキーマ・project.json 直列化形式・INV の変更はしない（曖昧なら止めて報告）
- spec/CLAUDE.md を勝手に改変しない（散文追記のみで済む場合はユーザー確認）
- 実装ループ: .claude/skills/implementation-loop/SKILL.md を読んでから着手
- progress.md 末尾に (Cursor 委任) で 1 行追記

<stop>: 仕様が曖昧・設計判断が必要・テストが通らない原因がアーキテクチャ変更 → 変更を最小に留め、ブロッカーを箇条書きで報告して止める。
```

## パターン A — 単発委任

1. タスクが spec 確定済みか確認（未確定なら Claude が先に spec を固める）。
2. worktree 名は **`cursor-<topic>-<YYYYMMDD>`**（例: `cursor-video-warmup-20260702`）。
3. 上記 CLI で起動。完了までブロック（長時間なら `block_until_ms` を十分に）。
4. worktree パスを出力から控える → **レビューゲート**（下記）→ ユーザーにマージ確認。

詳細の最小手順は [delegate-to-cursor](../delegate-to-cursor/SKILL.md) と同内容。

## パターン B — 並列 fan-out

**条件**: タスク間にファイル競合が少ない（別 verify 追加、別 FB-ID、別モジュール）。

1. Claude が依存関係を整理し、**独立タスク一覧**を作る（最大 2〜3 並列推奨。ディスク・API 制限に注意）。
2. 各タスクに **別 worktree 名**を付与:

```powershell
# 例: 2 本を順に起動（Claude の shell から。完全並列は Start-Job / 別ターミナルでも可）
cursor-agent -p --force --trust --model auto -w cursor-fb01-20260702 --output-format text "<prompt FB-01>"
cursor-agent -p --force --trust --model auto -w cursor-fb02-20260702 --output-format text "<prompt FB-02>"
```

3. 各 worktree で **独立にレビューゲート**。
4. ユーザー承認後、**1 本ずつ** cherry-pick / merge（競合が出たら Claude が解消。無理なら順次マージに降格）。

**競合しやすいタスク**（同一ファイル・store.ts・resolve.ts）は並列にしない → パターン A または C。

## パターン C — verify-fix ループ（ぶん回しの核心）

Claude が品質ゲートを握り、Cursor に修正だけ繰り返させる。

```
[Claude] プロンプト作成 → cursor-agent 起動
    ↓
[Claude] worktree で npm run typecheck && npm test && npm run build
    ↓ 失敗
[Claude] 失敗ログを要約 → cursor-agent -p --force --trust --model auto --resume <chatId> で「このエラーを直せ」
    ↓ 成功 or max_retries
[Claude] レビューゲート → ユーザーへ報告
```

**ルール**:

- **最大 3 回**まで自動リトライ（それ以上はユーザーに方針確認）。
- リトライプロンプトには **必ず** 失敗コマンド全文・stderr 先頭 80 行・関連ファイルパスを含める。
- 同じエラーが 2 回連続 → アーキテクチャ/spec 問題の疑い。Cursor を止め Claude が原因分析。

```powershell
# 2 周目以降の例
cursor-agent -p --force --trust --model auto --resume <chatId> --output-format text "typecheck failed: <paste>. Fix without changing spec schema. Run npm run typecheck && npm test again."
```

## パターン D — resume / continue

- **同一タスクの追記**: `--resume <chatId>`（JSON 出力で ID を保存）。
- **直前セッション続き**: `--continue`（Claude オーケストレーションでは chatId 明示の `--resume` を推奨）。
- resume 時も `-p --force --trust` を付ける。

## パターン E — plan → implement

大きい変更・触るファイルが多いとき:

1. `--plan -w <name>-plan` で Cursor に調査・手順だけ出させる（read-only）。
2. Claude が plan を読み、spec 整合・分割を決める。
3. 確定したサブタスクをパターン A/C で `--plan` なし実行。

plan 出力をそのままマージしない。あくまで Claude の分割入力。

## パターン F — FB-ID バッチ

[run-feedback-loop](../run-feedback-loop/SKILL.md) で `proposals-*.md` がある前提。

1. Claude が proposals から **承認済み FB-ID** だけ抽出（未承認は起動しない）。
2. 各 FB に implementation-loop の Phase 0–2 相当をプロンプトに圧縮。
3. 依存がなければ B（並列）、あれば順次 A/C。
4. 各完了後 `progress.md` に `(Cursor 委任) FB-YYYYMMDD-NN` を追記。

## レビューゲート（マージ前・Claude 必須）

worktree 内:

```powershell
cd <worktree-path>
npm run typecheck
npm test
npm run build
git diff <base-branch>..HEAD --stat
git diff <base-branch>..HEAD -- doc/mafter-effect-spec.md CLAUDE.md
```

チェックリスト:

- [ ] typecheck / test / build 緑
- [ ] `doc/mafter-effect-spec.md` §5 / INV の意図しない変更なし
- [ ] expression ランタイム変更時 `public/player.js` 更新済み
- [ ] 視覚変更時 verify スクリプト or Playwright 実施の痕跡（diff・ログ）
- [ ] 無関係な大規模リファクタが混ざっていない

**マージ・push・commit はユーザー確認後のみ。** Claude が無断で main に取り込まない。

## 後始末

```powershell
git worktree remove <worktree-path>
# 失敗時: git worktree remove --force <path>
```

マージ済み・不要 worktree は削除。未マージはユーザー判断まで残してよい。

## 記録

- 各委任完了: [progress.md](mdc:progress.md) 末尾に `(Cursor 委任) <要約>` 1 行。
- バッチ: FB-ID ごとに 1 行でも可。

## アンチパターン

| やってはいけない | 理由 |
|----------------|------|
| spec 未確定のまま Cursor 起動 | 事実上の仕様がコードに固定される |
| `-p` なし起動 | Claude セッションが対話待ちで止まる |
| `--force` なし | shell 承認でハング |
| `cursor-agent agent ...` | 冗長。プロンプトは positional で `-p` 等の後に渡す |
| `--model` 省略 | CLI デフォルトが auto にならない。必ず `--model auto` |
| メイン cwd で `-w` なし大量編集 | Claude の作業ツリーと競合 |
| テスト未確認でマージ | 委任の意味がない |
| 5 回以上黙ってリトライ | ループ地獄。ユーザーにエスカレーション |

## ユーザー向けトリガー例

Claude Code にそのまま渡せる一文:

- `orchestrate-cursor-agents で FB-20260702-01 を Cursor に実装させて`
- `verify-fix ループ付きで cursor-agent を回して video warm-up を直して`
- `独立してる FB を 2 本、worktree 並列で Cursor に投げて`

## 関連スキル

- 単発の短手順: [delegate-to-cursor](../delegate-to-cursor/SKILL.md)
- Cursor 側の実装品質: [implementation-loop](../implementation-loop/SKILL.md)
- FB 提案の入口: [run-feedback-loop](../run-feedback-loop/SKILL.md)
