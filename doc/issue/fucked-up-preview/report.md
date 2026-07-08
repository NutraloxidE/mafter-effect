# packed alpha preview「もたつき / ズレ」実ピクセル計測レポート

- 日付: 2026-07-08
- 対象コード: `main` 作業ツリー（Codex Phase 2-6 = packed alpha preview の `VideoDecoder` 明示デコード移行 ＋ Sonnet 5 の混在ケース同期修正 (A)(B)(C)、いずれも未コミット）
- 計測機: **i7-11xxx / オンボード GPU（この開発機）** — ユーザーが「人物が先走る」と報告した環境そのもの
- 被験: `verify-comp32-mini-project.zip` の Comp32（背景 `<video>` レイヤー ＋ Person レイヤーを split→packed 変換＝**混在ケース**）
- スクリプト: [`capture-comp32-preview.mjs`](capture-comp32-preview.mjs)
- 生成物: [`out/comp32-preview-capture.mp4`](out/comp32-preview-capture.mp4)（診断オーバーレイ焼き込み）、[`out/metrics.json`](out/metrics.json)、`out/raf-log.json`、`out/frames/`

---

## 結論（TL;DR）

**現行の packed VideoDecoder preview は、この環境で再生時間の約 85% がフリーズ（もたつき）している。** ズレ（人物 vs 背景）は同期修正で中央値 ~1 frame まで縮んだが、その代償として**タイムライン全体が頻繁に長時間 hold し、視覚的には「スキップ・カクつき」になった**。根本は透過動画が **decode 律速**（[[alpha-video-perf-decode-bound]]）で、VideoDecoder 移行はそのコストを解消しておらず、同期修正 (B)(C) が「デコード待ち」をタイムライン全体の停止に変換しているため。

> **これまでの検証（`verify-packed-mixed-sync.mjs`）がこの問題を見逃した理由 = 測定妥当性の欠陥。** 旧検証は `mafterTargetSec` / `mafterPackedComposedSec` / `bg.currentTime` という**内部カウンタ**を読んで frame 差を測っていた。だが (A) ロールバックは「subject の内部 target を背景 currentTime に一致させる」処理そのもので、その差はコードが定義上ゼロに保つ値。**実際に画面へ present されたピクセルとフレーム pacing を一切見ていなかった。** 本レポートは CDP screencast で実ピクセルを高FPS録画し、ffmpeg `freezedetect` で客観的にフリーズを抽出した。ユーザーの仮説（「サンプルするフレームレートが低くて現象を確認できなかった」）は正しかった。

---

## 計測手法

1. 実 Chrome（`channel:"chrome"`・headed）で `https://localhost:5173`（secure context = VideoDecoder 有効）を開く。
2. Comp32 mini-project を import → Person の split alpha を本番と同じ `convertSplitAssetToPacked()` で packed 化（`newAsset` container=`webm`／VP9 フォールバック）。
3. Person レイヤーの `<video>` が `dataset.mafterPackedDecoder==="1"` かつ `src` 無し = **VideoDecoder 経路 ACTIVE** を確認。
4. 画面隅に診断オーバーレイ（timeline F / bg frame / subj frame / desync / HOLD）を注入。
5. `Page.startScreencast`（jpeg・everyNthFrame:1）で実ピクセルを timestamp 付き録画（**実測 avg 46.7fps・要件の15FPS超**）。並行して rAF 全速で内部クロックを記録。
6. 8 秒再生（`setPlaying(true)`、start frame 20）。
7. ffmpeg で実 timestamp 保持の mp4 を生成 → `freezedetect=n=0.002:d=0.15` で視覚フリーズ区間を抽出。

---

## 結果

### 1. 視覚フリーズ（実ピクセル・ffmpeg freezedetect）
- **フリーズ区間 21 個 / 総フリーズ 6.70 秒 / 再生 7.9 秒 = 約 85%**
- 最長: **1.13 秒**（t≈1.63s）、**1.00 秒**（t≈3.23s）の巨大フリーズを含む
- → 実際に描かれているピクセルが、再生中のほとんどの時間で更新されていない＝**もたつきの客観証拠**

### 2. タイムライン hold（内部 rAF クロック・独立計測）
- **18 回の hold（>1.5 frame 固着 while playing）**。代表値: 503ms / 1055ms / 1013ms / 216ms …
- freezedetect（実ピクセル）と hold（内部クロック）が**二重に一致** → 計測アーティファクトではなく本物。

### 3. ズレ（実表示フレーム: subject − background）
- median |desync| = **1.14 frame**、p95 = 3.42、max = **4.79 frame**
- meanSigned = **−1.33 frame**（負 = subject が背景に対して**遅れ**気味）、lag 322 / lead 24 サンプル
- 同期修正で「先走り」は解消され数フレーム以内に収まったが、**代わりに hold（もたつき）が支配的**になった。

### 4. screencast pacing
- avg 46.7fps・median dt 16.9ms・**max dt 105ms**（描画ヒッチ）。

（生値: [`out/metrics.json`](out/metrics.json)）

---

## 解釈（根本原因）

1. **透過動画は decode 律速**（[[alpha-video-perf-decode-bound]]）。VP9/webm フォールバックの packed 1 本を `VideoDecoder` で明示デコードしても、この環境では実時間再生を維持できない。
2. 同期修正 (B)（subject の未デコードを hold サンプルとして寄与）+ (C)（hold 中は背景も pause）は、**「デコードが間に合わない」を「タイムライン全体を止めて待つ」に変換**する。ズレは減るが、体感は**カクつき・スキップ**になる。
3. つまり VideoDecoder 移行＋同期修正は、**症状（ズレ）を別の症状（もたつき）に付け替えただけ**で、decode コストという本丸を解決していない。これは v1（THREE シーンに動画を入れる）失敗時の教訓と同型。

---

## ベースライン比較（perf の影響切り分け・同一機・同一手法）

同じ Comp32・同じ計測を、`git stash` + `checkout`（非破壊）で3状態撮り比べた:

| 状態 | packed 経路 | perf 系 | timeline hold | **視覚フリーズ%** | desync 中央値 |
|---|---|---|---|---|---|
| `7c888f7`（WebGL Phase3 直後） | native `<video>` | **なし** | 2 回（起動時のみ） | **10%** | 0.75f（微先行） |
| `3bd1f3c`（perf Phase4 直後） | native `<video>` | **あり** | 2 回（起動時のみ） | **5%** | 0.37f（微先行） |
| 現状（未コミット） | **VideoDecoder+sync** | あり | **18 回** | **85%** | 1.14f（遅れ） |

（各 mp4: `out/baseline-noperf-7c888f7/capture.mp4`, `out/baseline-perf-3bd1f3c/capture.mp4`, `out/comp32-preview-capture.mp4`）

**判明したこと:**
1. **もたつき（85%フリーズ）の原因は packed VideoDecoder 移行＋同期修正で確定。** native `<video>` の packed 経路（両ベースライン）はどちらも起動時以外は円滑（5〜10%＝起動 hold のみ）。
2. **perf 系6コミットは無害。むしろ僅かに良い**（3bd1f3c=5% < 7c888f7=10%、desync も 0.37 < 0.75）。preview 起動最適化を捨てる理由はデータ上ない。
3. 両ベースラインとも subject は背景を <1 frame 微先行するが、**フリーズが無いため体感は円滑**。ユーザー報告の「先走り」は、この微先行が VideoDecoder 版で hold/drift により増幅・可視化されたもの。

→ **go-forward 基準点は `7c888f7` より `3bd1f3c` が合理的**（perf を保持し、packed VideoDecoder 系だけを捨てる）。

## 環境依存の方向について

ユーザー報告では機種で症状の方向が逆（速い機=先走り / 遅い機=遅れ）。本計測は**同期修正 "後"** の状態のため、この機でも steady-state のズレは小さく（±1〜1.3f）、支配的な症状は**hold（もたつき）**に置き換わっている。修正 "前"（Codex Phase 2-6 単独）の「先走り」を同手法で撮るには、同期修正差分を外した状態での再撮が必要（本ブランチ運用で別途取得可）。

---

## 推奨

- **go-forward 基準は `3bd1f3c`**（perf 保持・packed VideoDecoder 系のみ破棄）を推奨。データ上 perf は無害〜有益で、`7c888f7` まで戻すと preview 起動最適化を無駄に失う。純粋な「起点の綺麗さ」を優先するなら `7c888f7` も可（フリーズ差は僅少）。
- 現在の作業ツリー状態（packed VideoDecoder + sync 修正）は **failure example ブランチ**として保存する。decode 律速に対し sync 帳尻合わせで戦う設計で、この機では実用にならない（85%フリーズ）。
- 本 issue 一式（スクリプト・3状態の mp4・metrics）を go-forward ブランチへ持ち越す。
- 今後 preview 軽量化に再挑戦する場合の**受け入れ計測は本スクリプト方式（実ピクセル freezedetect + pacing）を正**とし、内部カウンタ差だけで緑判定しない（それが今回の見逃しの原因）。
