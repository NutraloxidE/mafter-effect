---
name: goal-cursor
description: Cursor Agent が完了条件を満たすまで自律的に作業を続ける（Codex の /goal 相当）。ユーザーが /goal-cursor <条件>、/goal-cursor（状態確認）、/goal-cursor clear を入力したときに使う。検証可能な終了状態（テスト緑・verify PASS 等）がある実装・修正・移行タスク向け。自発的には起動しない。
disable-model-invocation: true
---

# /goal-cursor — 完了条件まで自律作業（Cursor 版 /goal）

Codex の [`/goal`](https://code.Codex.com/docs/en/goal) に相当。**Cursor IDE 内の Agent が、ユーザーが毎ターン指示しなくても完了条件まで作業を続ける**。

> Cursor には Stop hook + 別 evaluator がないため、**Agent 自身が検証コマンドを実行し自己判定**する。条件は「会話に出た結果で判定できる」ものに書く。

## いつ使うか

| 向いている | 向いていない |
|-----------|-------------|
| `npm test` が緑になるまで修正 | 仕様・設計判断が未確定 |
| verify スクリプトが PASS するまで | ユーザー確認が毎ステップ必要（§5 / INV 変更等） |
| ラベル付きタスクキューを空にする | 曖昧な「きれいにして」だけの条件 |
| 設計確定済みの実装を最後まで | 1 手で終わる単発質問 |

**併用**: 実装品質は [implementation-loop](../implementation-loop/SKILL.md)。Codex から headless で Cursor を回すのは [orchestrate-cursor-agents](../orchestrate-cursor-agents/SKILL.md)（別物）。

## コマンド構文

ユーザーの入力を次のように解釈する（`/goal-cursor` の後ろが引数）。

| 入力 | 動作 |
|------|------|
| `/goal-cursor <条件>` | 目標を設定し**即座に作業開始**（別プロンプト不要）。既存目標は置き換え |
| `/goal-cursor` | 状態表示（条件・経過・ターン数・直近の判定理由） |
| `/goal-cursor clear` | 目標を解除（`stop` / `off` / `reset` / `none` / `cancel` も同義） |

## 状態ファイル

セッション内の正本: **`.cursor/goal-state.json`**（git 追跡しない）。

```json
{
  "status": "active",
  "condition": "npm test が 0 exit かつ typecheck 緑",
  "startedAt": "2026-07-02T12:00:00.000Z",
  "turnCount": 3,
  "maxTurns": 20,
  "lastEvaluation": {
    "met": false,
    "reason": "videoElementSync.test.ts が 2 件失敗",
    "at": "2026-07-02T12:15:00.000Z"
  },
  "achieved": []
}
```

- `status`: `active` | `idle`（達成 or clear 後）
- 達成時: `achieved` に `{ condition, achievedAt, turnCount, summary }` を追記し `status` を `idle` に
- ファイルが無い / 壊れている → `idle` として扱う

## 自律ループ（核心）

目標が `active` の間、**ユーザーに制御を返す前に**次を繰り返す。

```
作業 → 検証コマンド実行 → 自己判定
  ├─ 条件を満たす → achieved 記録 → 完了報告して停止
  ├─ 未達 & turn < maxTurns → 理由を state に書き、続行（同セッション内で次の作業へ）
  └─ 未達 & turn >= maxTurns → 部分進捗を報告して停止（エスカレーション）
```

### 自己判定のルール

1. **条件に書いた検証を実際に実行する**（推測で「たぶん緑」としない）
2. 判定理由は **コマンド出力の要約**（失敗テスト名・exit code・verify の PASS/FAIL）
3. 同じ失敗が **2 ターン連続** → アーキテクチャ / spec 問題の疑い。**無闇に続行せず**ブロッカーを箇条書きで報告して停止
4. **§5 スキーマ・INV・project.json 直列化形式の変更は目標達成の手段にしない**（必要なら停止してユーザー確認）

### デフォルト安全弁

条件に上限が無い場合、state の `maxTurns` は **20**。

条件文に `20 ターン後に停止` / `stop after 20 turns` 等を含めればそれを優先。

## 効果的な条件の書き方

Codex `/goal` と同様、**会話とコマンド出力で証明できる終了状態**にする。

**良い例**

```text
/goal-cursor npm run typecheck と npm test が exit 0。§5/INV は変更しない。20 ターン後に停止。

/goal-cursor verify-video-warmup.mjs が PASS し、npm test の video 関連がすべて緑。runtime 変更時は build:player 済み。

/goal-cursor progress.md の Next steps #0c が [x] になり、対応する verify が PASS。
```

**悪い例**

- 「コードをきれいにして」（測定不能）
- 「バグを直して」（再現手順・検証なし）
- 「spec を決めてから実装して」（設計判断が必要 → 先にユーザーと spec 確定）

推奨する条件の要素:

1. **測定可能な終了状態**（exit 0、PASS、ファイル数、キュー空）
2. **検証方法の明示**（どのコマンド・どの verify）
3. **守る制約**（§5 不変更、無関係ファイルを触らない等）
4. **任意のターン上限**

## 作業開始時（`/goal-cursor <条件>`）

1. 引数をパース（clear / 状態のみ / 新条件）
2. 新条件なら `.cursor/goal-state.json` を `active` で書き、`turnCount: 0`
3. [progress.md](mdc:progress.md) を読み、条件と矛盾する既知制約がないか確認
4. 実装・レンダリング変更なら [implementation-loop](../implementation-loop/SKILL.md) Phase 0–2 を頭に置く
5. **直ちに作業**（「これからやります」で止めない）

## 完了時

1. state を `achieved` 記録 + `idle` に更新
2. チャットに短い完了報告（条件・ターン数・実行した検証・主要 diff）
3. [progress.md](mdc:progress.md) 末尾に 1 行追記: `(goal-cursor) <要約>`

## 中断・クリア（`/goal-cursor clear`）

1. state を `idle` に（`condition` は `achieved` 履歴に残さない — 未達のため）
2. 進捗と未達理由を報告
3. 以降の自律ループを行わない

## 状態確認（`/goal-cursor` のみ）

state を読み、次を表示:

- 条件（active 時）または直近の achieved 1 件
- 経過時間・`turnCount` / `maxTurns`
- `lastEvaluation.reason`

## Mafter Effect 向けデフォルト検証（該当時）

条件に書かれていなくても、コード変更を伴う目標では達成判定前に可能な範囲で実行:

```powershell
npm run typecheck
npm test
```

触った領域に応じて追加:

- `src/runtime` / `src/player` / expression → `npm run build:player`
- 視覚・レンダリング → 該当 `verify-*.mjs` または implementation-loop Phase 4
- export 経路 → 既存 verify の無回帰

## アンチパターン

| やってはいけない | 理由 |
|----------------|------|
| 検証せず「完了」と報告 | /goal の意味がない |
| 毎ターンユーザーに「続けますか？」 | 自律ループの中断 |
| spec 未確定のまま目標設定 | 事実上の仕様がコードに固定される |
| 20 ターン超の黙々リトライ | ループ地獄。clear 相当で停止し報告 |
| 無関係な大規模リファクタ | 目標の範囲外 |

## ユーザー向けトリガー例

- `/goal-cursor npm test がすべて緑になるまで video warm-up 回帰を直して。20 ターンで停止`
- `/goal-cursor`
- `/goal-cursor clear`

## Codex /goal との差分

| | Codex `/goal` | Cursor `/goal-cursor` |
|--|---------------------|------------------------|
| 評価者 | 別の fast model（Stop hook） | Agent 自身（検証コマンド + 自己判定） |
| ターン継続 | 自動で次ターン開始 | **同一セッション内で自律継続**（Cursor は Stop hook なし） |
| 状態 | セッション内蔵 | `.cursor/goal-state.json` |
| headless | `Codex -p "/goal ..."` | Cursor IDE / Agent セッション内 |
