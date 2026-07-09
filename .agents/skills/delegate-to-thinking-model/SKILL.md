---
name: delegate-to-thinking-model
description: Cursor Agent が高度なメタ認知（spec 設計・INV/§5 トレードオフ・曖昧バグの仮説立案・アーキテクチャ分岐・複数経路の比較）を Codex（Codex CLI）経由の Fable 5 / Opus 4.8 に委任するときの手順。追跡レジストリ・ハンドオフパケット・待機・戻りプロトコルを含む。実装委任は delegate-to-cursor / orchestrate-cursor-agents を使う。ユーザーが「深く考えて」「Codex に設計を委任」「Fable/Opus に投げて」等と言ったとき、または Cursor が自分では不十分と判断したメタ認知タスクで使う。自発的には起動しない。
---

# 思考モデル委任 — Codex（`Codex` CLI）→ Fable 5 / Opus 4.8

**Cursor（親）= オーケストレータ**（文脈保持・追跡・待機・戻り後の実装判断）。
**Codex（子）= 深い推論ワーカー**（`Codex` コマンドで headless 起動。Fable / Opus を `--model` で指定）。

> **委任先は Cursor 内の Codex / Task ツールではない。** 正本は **`Codex -p`（Codex CLI）**。`.Codex/skills` と `AGENTS.md` がそのまま効く。

実装・テスト・verify まで回す委任は **[delegate-to-cursor](../delegate-to-cursor/SKILL.md)** / **[orchestrate-cursor-agents](../orchestrate-cursor-agents/SKILL.md)**（`cursor-agent`）。本スキルは **考える・決める・文案を出す** フェーズ専用。

## いつ使うか

| 委任する（本スキル） | 委任しない |
|---------------------|-----------|
| §5 / INV の追加・変更案とトレードオフ比較 | spec 確定済みの実装・テスト修正 |
| 曖昧な視覚バグの仮説ツリー・計測計画 | 再現手順と verify が既にあるピンポイント修正 |
| 複数アーキテクチャ案の評価（推奨 1 案 + 却下理由） | 1 ファイルの局所リファクタ |
| FB 要約からの優先度付き提案（propose 相当の深掘り） | 単純な spec 節の散文追記 |
| 「なぜ preview と export がずれるか」の原因仮説 | implementation-loop Phase 4 の機械的 verify |
| ユーザーが Fable / Opus / 深い思考を明示 | ユーザーが Cursor 単体で十分な単発質問 |

**起動条件**: ユーザー明示、または Cursor が「設計判断がブロッカー」と判断したとき。**勝手に毎タスク委任しない。**

## モデル選択（`Codex --model`）

| モデル | `--model` 値（推奨） | 向き |
|--------|---------------------|------|
| **Fable 5**（優先） | `fable` | 最大のメタ認知・分岐探索・長文 spec 草案 |
| **Opus 4.8**（代替） | `opus` | Fable 利用不可・安定した長推論・INV 整合チェック |

- Fable が利用不可 → **`--model opus`** または `--fallback-model opus`（ユーザーに 1 行通知）。
- 深さを上げる: `--effort high` または `xhigh`（コスト増）。
- 起動前: `Codex doctor` または対話不要の `Codex -p --version` で CLI が使えることを確認。

## 核心: ハンドオフパケット（戻りやすさの正本）

委任**前**に必ずレジストリ + ハンドオフ MD を書く。親 Cursor はこのファイルだけ読めば文脈を復元できる。

```powershell
node .Codex/skills/delegate-to-thinking-model/scripts/reasoning-delegation.mjs new --task "..." --model Codex-fable-5-thinking-high [--spec §16.1] [--readonly]
```

生成物:

- レジストリ: `.cursor/delegations/reasoning-registry.json`（`RG-YYYYMMDD-NN`）
- ハンドオフ: `.cursor/delegations/handoffs/RG-YYYYMMDD-NN.md`

ハンドオフ MD に埋めるテンプレ（`new` 後に Cursor が追記）:

```markdown
# RG-20260703-01 — <短いタイトル>

## 親の目的（1–3 文）
<ユーザーが最終的に何を得たいか>

## 確定事項
- ...

## 未決・委任したい問い
1. ...

## 制約（触ってはいけないもの）
- §5 / INV / project.json 形式: 変更案は **提案のみ**。実装・マージは親がユーザー確認後。
- ...

## 親が既に試したこと
- ...

## 戻り後に親がやること
- [ ] ユーザーに選択肢提示（推奨案 first）
- [ ] spec 更新なら先に spec → 実装
- [ ] 実装が必要なら delegate-to-cursor へ DG 起票

## 委任先へのプロンプト（コピー用）
<下記「プロンプト骨格」を埋めた全文>
```

## 追跡と待機

### 1. 起票（親・委任前）

```powershell
node .Codex/skills/delegate-to-thinking-model/scripts/reasoning-delegation.mjs new --task "preview/export parity 仮説" --model Codex-fable-5-thinking-high --readonly
# → { id, handoffPath, registryPath }
```

ハンドオフ MD を埋める → `update --status running` で起動記録。

### 2. 起動 — **`Codex` CLI（正本）**

リポジトリルートを cwd にする（`AGENTS.md` / `.Codex/skills` が読まれる）。

#### A. 同期（短〜中程度の設計推論）

```powershell
node .Codex/skills/delegate-to-thinking-model/scripts/reasoning-delegation.mjs launch RG-20260703-01
# → 推奨コマンドを表示。または下記をそのまま実行:

Codex -p --permission-mode plan --model fable --effort high --output-format json -n "RG-20260703-01" `
  "RG-20260703-01: Read .cursor/delegations/handoffs/RG-20260703-01.md. Execute the block under ## 委任先へのプロンプト. Append ## Handback to that file using the template in delegate-to-thinking-model SKILL. Do not edit source code." `
  | Tee-Object -FilePath .cursor/delegations/logs/RG-20260703-01.json

node .Codex/skills/delegate-to-thinking-model/scripts/reasoning-delegation.mjs parse-json < .cursor/delegations/logs/RG-20260703-01.json
node .Codex/skills/delegate-to-thinking-model/scripts/reasoning-delegation.mjs update RG-20260703-01 --status running --session-id <uuid>
```

| フラグ | 理由 |
|--------|------|
| `-p` / `--print` | headless。Cursor の shell から完結 |
| `--permission-mode plan` | 設計・調査のみ（実装 edit を抑止） |
| `--model fable` / `opus` | 思考モデル指定 |
| `--output-format json` | `session_id` を抜いて resume 用に保存 |
| `-n RG-*` | `/resume` ピッカーで RG-id が見える |

完了後: ハンドオフ MD の `## Handback` を読む → [戻り後プロトコル](#戻り後プロトコル親必須)。

#### B. バックグラウンド（長い推論・親は待たない）

```powershell
Codex --bg -p --permission-mode plan --model fable --effort high -n "RG-20260703-01" `
  "RG-20260703-01: (same prompt as A)"
# 戻り値の session id を --session-id で登録
# 完了確認: Codex agents （またはログ・handoff の Handback 節の出現）
```

- 親 Cursor は **手動ポーリングしない**。`list --active` と handoff MD の Handback の有無で完了判定。
- 長時間はユーザーに「RG-* を Codex バックグラウンド実行中」と 1 行。

#### C. フォールバック — Cursor Task ツール（`Codex` CLI 不可時のみ）

`Codex` が未インストール・未ログイン・doctor 失敗のときだけ:

```
Task: model Codex-fable-5-thinking-high, readonly: true, prompt = ハンドオフ全文
```

`cursor-agent` は **本スキルでは使わない**（実装委任は orchestrate-cursor-agents 側）。

### 3. 待機ルール（親）

| 状況 | 親の振る舞い |
|------|----------------|
| `run_in_background: true` | **手動ポーリングしない**。システム通知で完了を受け取る → ハンドバック処理へ |
| 同セッションで他作業可能 | 委任中は `list --active` で RG を把握。完了 RG は必ず閉じる |
| ユーザーが割込み | `show RG-*` で状態を読み、未完了なら `resume` か abandon を選択 |
| 3 分以上かかる想定 | ユーザーに「RG-* 委任中。完了後に Handback を要約します」と 1 行 |

```powershell
node .Codex/skills/delegate-to-thinking-model/scripts/reasoning-delegation.mjs list --active
node .Codex/skills/delegate-to-thinking-model/scripts/reasoning-delegation.mjs show RG-20260703-01
```

### 4. 再開（Codex への追記）

```powershell
Codex -p --resume <sessionId> --permission-mode plan --model fable --output-format json `
  "RG-20260703-01 follow-up: handoff の未決 #2 を深掘り。Handback を同ファイルに上書き更新。"
```

- `--fork-session` は通常不要（分岐調査が必要なときのみ）。
- 追記前にハンドオフ MD の「未決」を更新する。

## プロンプト骨格（委任先に毎回渡す）

```
<role>: Mafter Effect の設計・仕様推論担当。AGENTS.md と doc/mafter-effect-spec.md を正とする。

<task>: （RG-id・何を考えてほしいか）

<context>:
- 親の目的: ...
- 確定事項: ...
- 未決の問い: ...

<deliverable>:
1. 結論（推奨 1 案を最初に）
2. 却下した案と理由
3. spec 変更が必要なら §節単位の diff 文案（§5 型変更は別枠で INV 影響を明記）
4. 実装に委ねる場合の受け入れ条件・verify 案
5. 残リスク・親がユーザーに確認すべき質問

<constraints>:
- コードは書かない（--plan / readonly 前提）
- §5 スキーマ・INV・project.json 直列化の変更は「提案」に留め、勝手に確定しない
- 散文を根拠にスキーマを拡張する提案は、型案まで落とす

<handback>: 返答末尾に必ず次のテンプレで「## Handback」節を付ける（親の復帰用）
```

## 戻りテンプレ（委任先が必ず付ける）

委任先プロンプトに含め、親はこの節だけ読んでも復帰できるようにする。

```markdown
## Handback

### 一行結論
...

### 推奨案
...

### 却下案
- 案 A: 理由

### spec / INV への影響
- 変更不要 | 散文のみ | §5 変更案（要ユーザー確認）| INV 変更案（要ユーザー確認）

### 親への次アクション（チェックリスト）
- [ ] ...

### 実装委任用ドラフト（delegate-to-cursor に渡す 1 段落）
...

### 不確実性・要ユーザー確認
- ...
```

## 戻り後プロトコル（親・必須）

1. Handback をハンドオフ MD 末尾に貼り、`update --status pending_parent --note "handback received"`  
2. レジストリを閉じる前に **ユーザー向け要約**（推奨案 first、確認質問は箇条書き）  
3. §5 / INV 変更案がある → **実装前に** [AskQuestion](mdc:) 相当でユーザー確認（ルール準拠）  
4. 実装フェーズへ → 新規 `delegation.mjs new` で **DG-*** を起票（RG-id を `--note` か FB 欄にリンク）  
5. 完了: `update --status closed --note "parent summarized"`  
6. `progress.md` 末尾に 1 行: `(思考委任 RG-*) <一行結論>`

```powershell
node .Codex/skills/delegate-to-thinking-model/scripts/reasoning-delegation.mjs update RG-20260703-01 --status closed --note "ユーザー承認待ち: §5 案"
```

## パターン一覧

| パターン | 手順 |
|---------|------|
| **単発深掘り** | new → handoff → `Codex -p` 同期 → handback → 親要約 |
| **長時間調査** | new → handoff → `Codex --bg -p` → handback 出現後 → 親要約 |
| **仮説 → 実装** | RG 完了・ユーザー承認 → DG 起票 → orchestrate パターン A/C |
| **対話続き** | `resume` + handoff の「未決」更新 |
| **打ち切り** | `update --status abandoned --note "理由"` |

## レビューゲート（思考委任の成果物）

親がマージ・spec 編集前に確認:

- [ ] 推奨案が 1 つに絞られている（併記だけで終わっていない）
- [ ] §5 / INV 変更は「提案」ラベル付きで、勝手に確定していない
- [ ] 実装タスクに落とす場合、acceptance / verify が測定可能
- [ ] Handback の次アクションがチェックリストになっている
- [ ] RG が `closed` または `abandoned` で残っていない（`list --active` が空）

## アンチパターン

| やってはいけない | 理由 |
|----------------|------|
| ハンドオフ無しで `Codex` 起動 | 戻ったとき親の文脈が消える |
| `--permission-mode plan` なしで長文設計委任 | 意図しないコード edit。plan 固定 |
| Cursor Task に直行（`Codex` 使えるのに） | `.Codex/skills` が効かない・委任経路が二重化 |
| 思考モデルに実装・大量 edit をさせる | コスト・差分レビュー・SSoT 破壊。DG + cursor-agent へ |
| 完了通知を無視して RG を放置 | `list --active` が汚れ、二重委任の原因 |
| Handback なしで「考えました」と要約だけ | 監査・resume 不能 |
| Fable 不可時に諦める | Opus 4.8 へフォールバック |
| メタ認知タスクを毎回委任 | 単純作業のオーバーヘッド |

## 関連スキル

| フェーズ | スキル |
|---------|--------|
| 実装委任 | [delegate-to-cursor](../delegate-to-cursor/SKILL.md) |
| 並列・verify-fix | [orchestrate-cursor-agents](../orchestrate-cursor-agents/SKILL.md) |
| 実装品質 | [implementation-loop](../implementation-loop/SKILL.md) |
| 視覚バグ（計測フェーズ） | [debug-visual-render-bug](../debug-visual-render-bug/SKILL.md) |
| FB 入口 | [run-feedback-loop](../run-feedback-loop/SKILL.md) |

## ユーザー向けトリガー例

- `delegate-to-thinking-model で §27 の previewBake 設計を Fable に考えさせて`
- `Opus 4.8 に委任して preview/export ずれの仮説だけ出して（実装はまだ）`
- `RG の active 一覧を見せて`
