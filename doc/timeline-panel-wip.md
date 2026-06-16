# Timeline パネル WIP — AE との差分・実用性優先度リスト

> 現状の [TimelinePanel.tsx](../src/editor/panels/TimelinePanel.tsx)（spec §21 Tier A 実装済み）と
> 本家 After Effects のタイムラインを、**実用性（=実際に映像を組むときの手数・到達不能な操作）**の観点で比較した差分。
>
> SSoT は [mafter-effect-spec.md](mafter-effect-spec.md)。本ファイルは **作業計画（WIP バックログ）**であり仕様ではない。
> 各項目を実装する際は **先に spec §5 スキーマ／§4 INV への影響を評価し、必要なら spec を更新してから**着手する
> （CLAUDE.md「機能追加ワークフロー」: 先に仕様、次に実装）。
>
> 重要な所見: **エンジン側スキーマ（`Easing` / component props の `AnimatedProp` / `zOrder` 等）は対応済みなのに、
> UI が機能を殺している**ものが多い。スキーマ拡張不要＝Tier A 範囲内で埋められる穴が最も費用対効果が高い。

---

## P0 — 実用に必須（これが無いと「触れない」）

| # | AE | 現状 | 影響 | スキーマ |
|---|---|---|---|---|
| 1 | **タイムラインの水平ズーム/スクロール** | `pxToFrame` が `duration` 全体を常に全幅へ線形マップ（[TimelinePanel.tsx:370](../src/editor/panels/TimelinePanel.tsx#L370)）。ズーム無し | 長尺で 1 フレーム単位の KF 操作・トリムが物理的に不可能。最大の実用ブロッカー | UI のみ（viewStart/viewEnd or px-per-frame 導入） |
| 2 | **再生（Space）/ RAM プレビュー** | タイムラインに再生コントロールが無い。プレイヘッドはドラッグ/クリックのみ（[startScrub](../src/editor/panels/TimelinePanel.tsx#L379)） | アニメを「動かして確認」できない（PreviewPanel 側に rAF 再生はあるが Timeline から操作不可） | UI のみ |
| 3 | **イージング編集（F9 / hold / bezier）** | 全 KF が `{ type: "linear" }` ハードコード（[L726](../src/editor/panels/TimelinePanel.tsx#L726), [L734](../src/editor/panels/TimelinePanel.tsx#L734)）。エンジンは `Easing` 対応なのに UI から指定不可 | 「ぬるっと」動かす基本表現ができない。スキーマ拡張不要なのに未実装＝もったいない | UI のみ（既存 `Easing` 利用） |
| 4 | **フレーム単位ナビゲーション** | ←→で 1 フレーム、Home/End、J/K で前後 KF へジャンプ、いずれも無し | キーボード前提の AE ワークフローが成立しない | UI のみ |

---

## P1 — 高（無いと手数が極端に増える）

| # | AE | 現状 | スキーマ |
|---|---|---|---|
| 5 | **レイヤーのドラッグ並べ替え（zOrder）** | レイヤー行を掴んで上下に並べ替え不可。描画順を timeline から変えられない | UI のみ（既存 `zOrder`） |
| 6 | **複数レイヤー選択** | `onSelect` は単一トグルのみ（[L449-452](../src/editor/panels/TimelinePanel.tsx#L449)）。Shift/Ctrl 範囲選択なし（KF は複数選択できるのにレイヤーは不可） | UI のみ |
| 7 | **component props の KF 行展開** | プロパティ行は transform＋opacity のみ（[L659-663](../src/editor/panels/TimelinePanel.tsx#L659)）。html/video/plugin の `AnimatedProp` パラメータが timeline で触れない | UI のみ（既存 component props） |
| 8 | **スナップ**（プレイヘッド/KF/レイヤー端） | ドラッグは全て生の frame 値。吸着なしで秒ぴったり合わせが困難 | UI のみ |
| 9 | **KF のコピー/ペースト** | 無し。複数選択・移動・削除はあるが複製・転写ができない | UI のみ |

---

## P2 — 中（効率が上がる / spec §21.0 Tier B 相当）

| # | 項目 | 補足 | スキーマ |
|---|---|---|---|
| 10 | **parent リンク / solo / lock / shy / ラベル色** | spec §21.0 Tier B。実務頻度が高い | additive（`SceneObject` にフラグ追加） |
| 11 | **数値のドラッグスクラブ** | `NumberField` は入力のみ（[L837](../src/editor/panels/TimelinePanel.tsx#L837)）。AE は数値を掴んで増減できる | UI のみ |
| 12 | **グラフエディタ（値カーブ）** | 速度/値の視覚編集。#3 イージングと対 | UI のみ |
| 13 | **マーカー（comp/layer）** | 同期ポイント管理 | additive（要 spec） |
| 14 | **ワークエリア・in/out ショートカット（B/N, `[` `]`）** | 部分プレビュー・トリム高速化 | 一部 additive（ワークエリア範囲） |
| 15 | **右クリックコンテキストメニュー** | KF 補間・レイヤー操作の集約 | UI のみ |

---

## P3 — 低（将来 / spec §21.0 Tier C・D・特殊）

- **ブレンドモード / トラックマット**（Tier C, renderer INV-3 ＋ export 経路拡張要）
- **モーションブラー / 3D レイヤー / 調整レイヤー / フレームブレンド**（Tier D, 決定論モデル評価要）
- **タイムストレッチ / 逆再生**
- **ドロップフレームタイムコード**（整数 fps では non-drop と一致＝MVP 不要、spec §21.1 既述）

---

## 着手順の推奨

費用対効果（スキーマ不変＝Tier A 範囲で即効）の高い順:

1. **P0-3 イージング編集** — 既存 `Easing` を使うだけ。表現力が最も上がる。
2. **P0-1 水平ズーム/スクロール** — `pxToFrame` / `Ruler` / 各バー位置計算が全て「`/duration` → %」前提なので、
   `viewStart/viewEnd`（or px-per-frame）導入の小リファクタで足回りが一気に良くなる。
3. **P1-7 component props の KF 行** — spec が「スキーマ影響なし／既存フィールド」と明記済みなのに未実装。

P2-10 以降（Tier B/C/D）は spec が段階導入を宣言済み＝スキーマ拡張＋INV 評価が前提なので、
Tier A の穴（P0/P1）を先に埋めること。
