---

name: make-plan-for-codex
description: Claude / Opus / Sonnet で作った大きな設計・Phase計画・実装Planを、Codex medium が燃えずに実行できる小さな Ticket 群へ分解するためのスキル。Codex に巨大Planを丸投げすると、関連ファイル探索・複数Phase実装・テスト・build・status更新まで一気に走って usage を焼きやすい。Phase / WP / Ticket の粒度を分離し、Codex medium は実装責任者、Codex small / 下位 subagent は調査専用として扱う。Claude型の仮説・設計・世界観を、Codex型の allowed files / forbidden files / tests / stop conditions 付き作業票へ変換する。
----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

# Codex 用実装Plan分解

Claude / Opus / Sonnet は **Phase・仮説・設計意図・リスク・検証方針**を扱うのが得意だが、
Codex は **ファイル・diff・test・build・commit** の単位で動かした方が安定する。

大きなPlanをそのままCodexに渡すと、Codexは「全部読め・全部守れ・全部実装しろ・全部テストしろ」と解釈しやすい。
その結果、30分級の重タスクになり、usage警告・途中停止・過剰変更・禁止ファイル編集が起きる。

このスキルでは、大きなPlanを以下の階層に分解する。

```
Project
└─ Phase        # Claude / Opus / Sonnet が扱う戦略単位
   └─ WP        # Work Package。実装責任単位
      └─ Ticket # Codex に投げる最小作業単位
         └─ Step
```

**Codex に Phase を投げない。**
Claude が Phase を理解し、WP を選び、WP をさらに 15〜30分の Ticket に砕いてから Codex に渡す。

## 使うとき

* Claude / Opus / Sonnet で作った大きな設計Planを **Codex実装用に分解**するとき。
* `Codex medium + 下位subagent` のオーケストレーションPlanを作るとき。
* Codex に投げたPlanが重すぎて usage / agentic limit にすぐ当たるとき。
* 「Phase単位では良いが、Codexに渡すにはデカすぎる」Planを扱うとき。
* `decision-record` / `status` / `progress` / `spec追記` / `typecheck` / `test` / `build` が絡む厳格PlanをCodex向けに整理するとき。
* Codex small / medium / Claude Code / Opus / Sonnet の役割分担を決めるとき。

## 中核原則：Claudeには世界観、Codexには作業票

Claude / Opus / Sonnet には以下を渡してよい。

```
目的
仮説
Phase
リスク
設計理由
検証方針
人間確認が必要な箇所
```

Codex には以下だけを渡す。

```
目的: 1つ
許可ファイル: 明示
禁止ファイル: 明示
実装範囲: 明示
非目標: 明示
テスト: 明示
停止条件: 明示
完了報告形式: 明示
次Ticketへ進むな: 明示
```

Codex に「いい感じに全部やって」と言わない。
Codex に渡すのは思想ではなく、**作業票**。

## モデル役割分担

### Claude / Opus / Sonnet

```
- [ ] 大きなPlan全体を読む
- [ ] Phase / WP / Ticket の階層に整理する
- [ ] hard gate / forbidden area / required command を抽出する
- [ ] ambiguous な箇所を escalation ticket 化する
- [ ] Codex prompt を短く・明確にする
- [ ] Codex完了後の差分レビューを行う
- [ ] 人間検証が必要な箇所を切り出す
```

### Codex medium

```
- [ ] 実装本体を担当する
- [ ] Ticket単位でコード変更する
- [ ] allowed files だけ触る
- [ ] forbidden files を触らない
- [ ] 指定されたテストだけ実行する
- [ ] 完了後に止まる
- [ ] 次Ticketへ勝手に進まない
```

### Codex small / 下位subagent

```
- [ ] grep / ファイル位置調査
- [ ] 既存テスト構造の要約
- [ ] 変更候補の列挙
- [ ] status / progress 文面の下書き
- [ ] 純関数の候補案
- [ ] 低リスクなread-only調査
```

### 下位subagentにやらせないこと

```
- [ ] runtime中枢の実装判断
- [ ] 既存テスト期待値の変更判断
- [ ] forbidden files の例外判断
- [ ] export / scrub / serialization 経路の変更
- [ ] ブラウザ実ピクセル受け入れの自己宣言
- [ ] 曖昧な仕様の推測補完
```

## 最初に必ず作る Plan intake summary

大きなPlanを受け取ったら、Codex Ticket を作る前に必ず以下を作る。

```
## Plan intake summary

- Source document:
- Goal:
- Known Phases:
- Known WPs:
- Required gate files:
- Required status files:
- Hard forbidden areas:
- Allowed file policy:
- Required commands:
- Required generated artifacts:
- Human verification required:
- Ambiguities:
- First safe action:
```

`decision-record` や `status: FINAL` のようなゲートがある場合、
それを満たすまで実装Ticketを作らない。
最初のTicketは **gate確認 / blocker記録** にする。

## 分解チェックリスト（コピーして進捗管理）

### A. Plan intake / gate抽出

```
- [ ] source plan の目的を1文で要約
- [ ] Phase / WP / Ticket に分けられる構造を抽出
- [ ] `FINAL` / `DRAFT` / `implemented-awaiting-capture` 等の状態ゲートを抽出
- [ ] required status file / progress file / questions file を列挙
- [ ] 実装前に読むべきファイルを列挙
- [ ] 人間検証・headed browser・実ピクセルcaptureが必要な箇所を分離
- [ ] Codex が自己宣言してはいけない完了条件を明記
```

### B. 禁止事項の抽出

```
- [ ] 変更禁止ファイルを列挙
- [ ] 変更禁止経路を列挙（例: export / scrub / serialization / schema）
- [ ] 既存テスト期待値変更の可否を明記
- [ ] allowed files 以外を触る必要が出た場合の stop condition を書く
- [ ] Plan外のリファクタ禁止を明記
- [ ] 曖昧な仕様を推測で埋めないよう escalation 条件を書く
```

### C. Ticketサイズ判定

```
- [ ] 1 Ticket = 目的1つ
- [ ] 1 Ticket = 原則 1〜3ファイル
- [ ] 1 Ticket = 15〜30分で終わるサイズ
- [ ] runtime中枢 + UI配線 + test + build + docs を1 Ticketに詰めない
- [ ] pure function がある場合は最初に分離
- [ ] wiring は pure function の後に分離
- [ ] behavior change は最後に分離
- [ ] status更新 / progress更新 / capture handoff は必要なら別Ticket化
```

### D. Ticketテンプレート

```
### Ticket <ID> — <name>

- Owner:
- Model:
- Size:
- Purpose:
- Allowed files:
- Forbidden files:
- Pre-read:
- Implementation scope:
- Explicit non-goals:
- Steps:
- Tests / commands:
- Generated artifacts:
- Stop conditions:
- Completion report:
- Prompt to Codex:
```

### E. Codex prompt 必須項目

```
- [ ] このTicketだけ実施する、と明記
- [ ] allowed files を明記
- [ ] forbidden files を明記
- [ ] 非目標を明記
- [ ] 既存テスト改変禁止を明記
- [ ] 実行するコマンドを明記
- [ ] stop condition を明記
- [ ] 完了報告フォーマットを明記
- [ ] 次Ticketへ進まない、と明記
```

### F. Subagent prompt 必須項目

```
- [ ] read-only と明記
- [ ] コード変更禁止と明記
- [ ] 調査対象を限定
- [ ] 出力形式を限定
- [ ] 判断・例外決定をさせない
- [ ] 実装したくなったら候補案だけ出させる
```

### G. Review / 次Ticket判断

```
- [ ] Codex が allowed files だけ触ったか
- [ ] forbidden files を触っていないか
- [ ] 無関係なリファクタがないか
- [ ] 既存テスト期待値を勝手に変えていないか
- [ ] required commands を実行したか
- [ ] generated artifacts の扱いがPlan通りか
- [ ] human-only acceptance を自己宣言していないか
- [ ] status / progress / questions file が必要どおり更新されたか
- [ ] 次Ticketへ進んでいないか
```

## Codex用Promptの型

### 良い例

```
Implement only Ticket WP1-02.

Allowed files:
- src/runtime/videoLookaheadWarmup.ts
- test/videoLookaheadWarmup.test.ts

Forbidden:
- Do not edit DomRenderer.ts
- Do not edit PreviewPanel.tsx
- Do not edit BundlePlayer.ts
- Do not edit exporter.ts
- Do not change existing test expectations

Goal:
Add loop warm-up target computation to the pure function only.

Non-goals:
- Do not implement video element swapping
- Do not wire renderer options
- Do not update bundle player behavior
- Do not perform visual acceptance

Run:
- npm test -- videoLookaheadWarmup
- npm run typecheck if type errors appear

Stop if:
- You need to edit files outside the allowed list
- Existing callers require a broader API change
- Existing tests fail for reasons unrelated to this ticket

Report:
- Changed files
- Tests run
- Typecheck result
- Remaining work
- Blockers

Do not continue to the next ticket.
```

### 悪い例

```
このPlanを読んでPhase 1〜3を実装してください。
```

### 悪い例

```
必要なファイルをいい感じに直してテストを通してください。
```

## Subagent用Promptの型

### 良い例

```
Subagent task: read-only reconnaissance.

Do not edit files.

Investigate WP-1 only:
1. Where computeVideoLookaheadWarmupTargets is defined
2. Where it is called
3. Existing tests for this module
4. Assumptions that loop warm-up might violate
5. Candidate risks

Output:
- File list
- Relevant functions
- Existing test patterns
- Risks
- Suggested implementation boundary

Do not write code.
Do not decide exceptions.
Do not modify tests.
```

### 悪い例

```
WP-1を実装してテストも直して。
```

## Ticket分解パターン

### 標準パターン

```
Ticket 00 — Gate and route check
Ticket 01 — Spec / status preparation
Ticket 02 — Pure function + unit tests
Ticket 03 — Config wiring
Ticket 04 — Runtime behavior
Ticket 05 — Full commands / build artifact
Ticket 06 — Capture handoff / verification notes
```

### 重いruntime系WPの分割例

```
WP1-00: decision-record / route確認のみ
WP1-01: spec追記のみ
WP1-02: pure function と unit test
WP1-03: renderer option wiring
WP1-04: player / panel wiring
WP1-05: runtime behavior change
WP1-06: typecheck / test / build:player / status更新
WP1-07: human capture handoff
```

### 新規module追加系WPの分割例

```
WP2-00: 既存同期ロジック調査
WP2-01: 新規module skeleton + unit-safe API
WP2-02: pure function compute* 実装 + test
WP2-03: 既存sample型へのoptional field追加
WP2-04: runtime attach/detach wiring
WP2-05: UI/player適用
WP2-06: reset/failsafe確認
WP2-07: full verification commands
```

## 関係する設計軸・懸念点

* **Phase と Ticket は違う**
  Phase は戦略単位。Codexにそのまま渡すと大きすぎる。Ticket は実行単位。

* **WP はまだ大きいことが多い**
  Work Package は実装責任単位であり、Codex投入単位ではない。WPをさらにTicketへ割る。

* **Claude型Planは情報量が多い**
  設計理由・仮説・背景はClaudeには有効だが、Codexには探索範囲を広げる原因になる。

* **Codex medium は統合担当**
  中枢実装・複数ファイル差分・最終判断はmedium。smallに任せない。

* **Codex small は偵察担当**
  grep、要約、テスト構造確認に使う。判断させない。

* **人間検証は分離**
  実ピクセル、headed browser、音声/動画同期などはCodexが自己完了宣言しない。

* **generated artifact は明記**
  `build:player` 等で生成物が変わる場合、commit対象かどうかをTicketに書く。

* **既存テストは保護**
  既存期待値変更は原則禁止。Planで明示許可されている場合のみ例外としてTicketに書く。

## アンチパターン

* Phase単位でCodexに投げる。
* 「Planを読んで必要な変更をしてください」と書く。
* allowed files / forbidden files を書かない。
* runtime実装・UI配線・test・build・status更新を1 Ticketに詰める。
* Codex small に実装判断をさせる。
* 下位subagentにコード変更させる。
* 既存テストの期待値変更を曖昧に許可する。
* human capture が必要な受け入れをCodexに自己宣言させる。
* forbidden file が必要そうなのに推測で進める。
* Codex完了後にレビューせず次Ticketへ進める。
* Plan本文をそのままCodex prompt として貼る。

## worked example（巨大Preview改善Planの分解）

症状: Codex medium に3 Phase相当のPreview改善Planを投げたら、30分程度でusage警告が来た。

原因:

1. Planに `decision-record FINAL` ゲートがある。
2. WPごとに spec追記、実装、typecheck、test、build、progress更新、status更新が必要。
3. WP-1だけでも pure function、renderer wiring、panel/player wiring、runtime video swap が混在。
4. WP-2は新規rVFC module、sync state machine、playbackRate servo、DomRenderer attach/detach、player配線が混在。
5. Codexから見ると「3 Phase」ではなく「20〜40判断ポイントの重作業」になっていた。

修正:

1. ClaudeがPlanをPhase / WP / Ticketへ再分解。
2. 最初のCodex promptは実装禁止のgate確認だけにする。
3. WP-1を以下へ分割:

   * pure function + unit test
   * renderer option wiring
   * PreviewPanel / BundlePlayer wiring
   * loop wrap swap behavior
   * full commands + status update
4. Codex small はgrep / test構造確認だけ。
5. Codex medium が各Ticketの実装本体を担当。
6. capture acceptance は人間 / headed browser 側に残す。

最初のCodex prompt:

```
Read the plan and perform only the gate check.

Do not edit source code.

Check:
1. Whether decision-record.md exists
2. Whether status is FINAL
3. route.order
4. First WP to execute
5. Required files for that WP
6. Blockers

Allowed files:
- status / questions files only if the gate is blocked

Forbidden:
- No implementation files
- No tests
- No spec edits yet

Report:
- Gate status
- First executable WP
- Whether implementation may begin
- Blockers

Do not continue into implementation.
```

## 完了条件

このスキルの出力は、以下を満たすこと。

```
- [ ] Phase / WP / Ticket の階層が明確
- [ ] 最初のCodex promptが安全
- [ ] 各Ticketが15〜30分程度
- [ ] allowed files / forbidden files が明示されている
- [ ] tests / commands が明示されている
- [ ] stop conditions が明示されている
- [ ] subagent はread-only中心
- [ ] human verification が必要なものをCodex完了条件にしていない
- [ ] Codexが次Ticketへ勝手に進まない
```
