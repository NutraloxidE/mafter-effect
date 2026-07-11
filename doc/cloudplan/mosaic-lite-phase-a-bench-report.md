# mosaicLite（Mosaic Live）軽量化 Phase A — 実測ベンチマークレポート

> **ステータス**: 実装済み・検証済み（`perf/mosaic-lite-lightweight` ブランチ、未マージ）。
> 本ファイルは [mosaic-live-effect.md](mosaic-live-effect.md)（設計 PLAN）・
> [mosaic-live-effect-for-codex.md](mosaic-live-effect-for-codex.md) の続報。
> §5 スキーマ・INVARIANT・`project.json` 直列化形式への変更は無し。
> 作成日: 2026-07-11。生データは [mosaic-lite-phase-a-bench/](mosaic-lite-phase-a-bench/) 配下。

---

## 0. TL;DR

- **Phase A（`DomRenderer.applyFilterTokens`/`syncSvgFilters` の無条件毎フレーム `<defs>` 再構築を signature 比較でスキップする実装）は正しく機能している** — `<defs>`/`<filter>`（feImage 埋め込み SVG 含む）の再構築回数を実測で **144/150 フレーム → 40/150 フレーム**（scrub）、**60/60 回 → 0/60 回**（同一フレーム再描画）まで削減した。
- **しかし、実際のユーザープロジェクト（最新 `mafter-project` zip の Comp 10 + `mosaicLite` 追加）での壁時計時間には有意な改善が見られなかった**。3 回ずつの計測は同一コードの run 間ブレ（±800〜900ms、約10%）の中に埋もれており、before/after の差はそのブレより小さい。
- **CPU プロファイリングで確認したところ、`DomRenderer` の effect 関連処理（`applyEffects`/`renderNestedComp`/`applyObject` 含む）は全体 CPU 時間の 2.5〜5% 程度に過ぎず**、defs 再構築コストを完全にゼロにしても理論上の上限がその範囲に収まる。今回の実プロジェクト（カメラ・ネスト precomp・動画・音声を含む 22 オブジェクトの Comp）では、feImage 再デコードはそもそも支配的コストではなかった。
- **結論**: Phase A の実装自体は「無駄な再構築をなくす」という設計として正しく、より単純な構成（動画なし・レイヤー少・エフェクト多数）では効いてくる可能性はあるが、**このクラスの実プロジェクトに対しては追加の軽量化（PLAN 選択肢B: feImage→事前計算PNGタイル化）を急いで実装する優先度は低い**。CPU プロファイルは代わりに `waveform.ts`（音声波形計算、5〜12%）という mosaicLite とは無関係の別コストを浮かび上がらせた（§4 参照、本 PLAN の対象外）。

---

## 1. ベンチマーク対象

- プロジェクト: `C:\Users\resis\Downloads\mafter-project (11).zip`（更新日時最新・219MB）。
- 対象 comp: **Comp 10**（`01KVV05RE10X4E9H1AR77JPCH7`、1920×1080・30fps・150フレーム・22オブジェクト）。
- **Comp 10 には `mosaicLite` が付いていなかった**ため、以下の手順でベンチ専用複製を作成:
  1. Comp 10 と、そのオブジェクトが参照するネスト precomp「camera wiggle expression」（`01KVWRD2CMEV5J4T7BCXVS7ST9`）以外の comp・未使用 asset を刈り込んだ最小 zip（35.7MB、`bundleCollect.ts` の到達可能性と同型のロジックで手動抽出）を作成。
  2. Playwright 経由で実アプリに import（`importZip`/`loadFromFs`）→ Comp 10 を `structuredClone` で複製（id・`parent`・`mergeInputs.objectId` を再採番）→ 複製 comp の `square frame`（precomp レイヤー、表示区間 frame 7–112）に `mosaicLite`（既定 `blockSize=16`）を追加。
- 比較対象コード: 本セッションで実装した Phase A の `git stash`/`pop` による on/off 切り替え（同一 dev server・同一ブラウザプロセス構成、`npm run dev` の React DEV ビルド）。

---

## 2. ベンチ1: 全150フレーム scrub（実動画のデコード/シークあり）

`store.setFrame(f)` を `f=0..149` まで進め、各フレームで 1 rAF 待って `performance.now()` 差分を計測。

| run | before totalMs | after totalMs |
|---|---:|---:|
| 1 | 7885 | 8532 |
| 2 | 8409 | 9324 |
| 3 | 9258 | 8799 |
| （static ベンチ内の scrub phase） | 8382 | 8027 |
| **中央値（run1-3）** | **8409** | **8799** |
| **平均（run1-3）** | **8517** | **8885** |

| | before | after |
|---|---:|---:|
| `<defs>`/`<filter>` 再構築回数（150フレーム中） | 144 | **40** |

→ **再構築回数は 72% 削減**されたが、**合計時間は before の方がわずかに速い**（差は同一コード内の run間ブレ幅より小さく、有意差なし）。

---

## 3. ベンチ2: 同一フレームを60回再描画（動画シークなし・「別プロパティ編集で再描画」を模擬）

`setFrame` は固定（frame 50、`square frame` の表示区間内）のまま、`store.setState({ project: { ...project } })` で project 参照だけを更新し、1 rAF 待つ、を60回繰り返す。動画 seek を伴わないため scrub より低ノイズ。

| | before | after |
|---|---:|---:|
| 合計時間 | 3356ms | 3653ms |
| 平均 / 回 | 55.9ms | 60.9ms |
| `<defs>`/`<filter>` 再構築回数（60回中） | 60（毎回） | **0（完全にゼロ）** |

→ **再構築の完全排除には成功**（60→0）。しかし**壁時計時間はむしろ約9%遅い**という結果になった。1サンプルのみのため測定誤差の可能性はあるが、少なくとも「大幅に速くなった」と言える差ではない。

---

## 4. CPU プロファイル（Chrome DevTools Protocol `Profiler`、100µs サンプリング）

再構築ゼロ化に成功したにもかかわらず壁時計が縮まらなかった理由を推測せず、実測で特定した。ベンチ2（static replay・60回）・ベンチ1相当（実 scrub・60フレーム）の両方を Phase A 実装済みコードでプロファイリング（生データ: [mosaic-comp10.cpuprofile](mosaic-lite-phase-a-bench/mosaic-comp10.cpuprofile) / [mosaic-comp10-scrub.cpuprofile](mosaic-lite-phase-a-bench/mosaic-comp10-scrub.cpuprofile)）。

### self-time 上位（static replay、対サンプル比）

| 関数 | self-time |
|---|---:|
| (idle) | 25.7% |
| (program) | 11.0% |
| `jsxDEV`（React DEV ビルド） | 11.0% |
| `diffProperties`（React DOM DEV） | 6.7% |
| `mixToMono`（**waveform.ts**） | 5.4% |
| `applyTransient`（**waveform.ts**） | 2.7% |
| `processMode`（**waveform.ts**） | 2.4% |
| `prepareUpdate`（React DOM DEV） | 2.3% |
| **`applyEffects`（DomRenderer.ts）** | **2.1%** |
| `validateProperty$1`（React DOM DEV） | 1.7% |
| `bucketPeaks`（**waveform.ts**） | 1.5% |

### self-time 上位（実 scrub・60フレーム、対サンプル比）

| 関数 | self-time |
|---|---:|
| (idle) | 40.5% |
| (program) | 12.3% |
| `jsxDEV`（React DEV ビルド） | 6.7% |
| **`applyEffects`（DomRenderer.ts）** | **4.4%** |
| `diffProperties`（React DOM DEV） | 3.9% |
| `mixToMono`（**waveform.ts**） | 3.7% |
| `applyTransient`（**waveform.ts**） | 3.4% |
| `bucketPeaks`（**waveform.ts**） | 1.2% |

### 読み取れること

1. **`applyEffects`（＋ `renderNestedComp`/`applyObject` 等 DomRenderer 全体）は総 CPU 時間の 2.5〜5% 程度**。defs 再構築を理論上完全にゼロコスト化できたとしても、上限はこの範囲。今回の実プロジェクトでは feImage 再デコードは「支配的コスト」ではなく「多数ある小さいコストの一つ」だった。
2. **`waveform.ts`（`mixToMono`/`applyTransient`/`processMode`/`bucketPeaks`）が合計 5〜12% を占め、mosaicLite とは完全に無関係の別コスト**として両方のシナリオで一貫して上位に出た。static replay（frame 固定・`project` 参照だけ更新）でも scrub（`setFrame` のみ）でも同様に出現するため、静的トリガーの人工物ではなく実際のスクラブ操作でも発生する実コストと確認できた。オーディオ波形（"meluQKawaiiBangerFast_2"）のピーク/トランジェント計算が、フレームや無関係な project 更新のたびに再計算されている可能性がある — **本 PLAN の対象外だが、体感速度への影響は mosaicLite より大きい可能性がある**。
3. **`jsxDEV`/`diffProperties`/`prepareUpdate`/`validateProperty$1` 等の React DEV ビルド専用コストが合計 15〜22%** を占める。これは `npm run dev`（開発ビルド）特有のオーバーヘッドで、`npm run build` の本番ビルドでは大部分が消える。今回の壁時計比較（§2/§3）は開発ビルド同士の比較であり相対的な傾向は有効だが、**絶対的な ms 値は本番ビルドとは一致しない**点に注意。

---

## 5. 結論・推奨（改善余地の検討）

### 5.1 Phase A（既存実装）の評価

- **設計として正しい**: 無駄な DOM 再構築（feImage 再デコード契機）を排除できており、他の全 live SVG filter effect（`fastWave`/`fastRipple`/`fastTurbulentDisplace`/`blur` 等）にも同様に効く汎用改善。
- **この実プロジェクトでは体感できる速度改善には直結しなかった**。理由はデータで裏付け済み: defs 再構築コスト自体が全体の数% に過ぎないため。
- 退行はない（`npm test`・実機 Playwright 済み）ため、**現状のまま維持して問題ない**。「効果が薄かったから元に戻す」必要はない — 副作用ゼロで無駄を無くした改善であり、より重いケース（後述 5.2）で効いてくる可能性を残す。

### 5.2 PLAN 選択肢B（feImage→事前計算PNGタイル化）への判断

- **優先度を下げることを推奨**。defs 再構築自体が支配的コストでない以上、feImage の中身をどう軽くしても（gradient/pattern/blend-mode → PNG タイル化）実プロジェクトでの体感効果は限定的と予想される。
- 着手する価値があるとすれば、**「動画・音声を含まない、エフェクトを大量に重ねた軽量なコンポジション」**（例: モーショングラフィックス用テンプレートで `mosaicLite` を含む複数の live effect を10個以上重ねる等）での再測定が前提。そのようなワークロードでは相対的に `applyEffects`/defs 再構築の比重が上がり、Phase A・選択肢B の効果がより明確に出る可能性がある。**現時点では未検証**。
- 選択肢C（feTurbulence ノイズ近似への置換）は従来通り却下（モザイクの視覚的アイデンティティ＝矩形グリッドを壊すため）。

### 5.3 本 PLAN 範囲外だが記録しておく発見

- `waveform.ts` の波形計算（`mixToMono`/`applyTransient`/`processMode`/`bucketPeaks`）が、frame 変更時・project 参照変更時の双方で CPU 時間の 5〜12% を占めている。キャッシュ（asset id・表示範囲キー等での memo）が効いていない、または存在しない可能性がある。**mosaicLite より高い ROI が見込める別の軽量化候補**として次回セッションで調査対象にすることを推奨する（本 PLAN・本ブランチのスコープ外につき今回は未着手）。
- 開発ビルドの React DEV オーバーヘッド（15〜22%）は本番ビルドでは消えるため、**今後同種のベンチを行う際は `npm run build` 後の本番バンドルでの再測定も検討**すると、実ユーザー体感によりが近い数字が得られる（今回は `npm run dev` の HMR による前後切り替えの速さを優先し未実施）。

---

## 6. 検証データ・再現方法

- ベンチ結果 JSON: [mosaic-lite-phase-a-bench/](mosaic-lite-phase-a-bench/) 配下 `bench-result-*.json`（before/after × 3run + static variant）。
- CPU プロファイル（Chrome DevTools 形式・`chrome://inspect` や VS Code の JS Profile Visualizer 等で読み込み可）: 同フォルダの `.cpuprofile` 2件。
- ベンチ・プロファイリングスクリプト自体は使い捨て（Playwright + CDP `Profiler` ドメイン、`store.setState`/`importZip` を直接操作）で本コミットには含めていない。再実行する場合は次の手順を踏む:
  1. `npm run dev` で dev server を起動。
  2. 対象プロジェクト zip を `page.route` で `/__bench_zip__` に応答させ、ページ内 `fetch` → `importZip(fs, bytes)` → `loadFromFs()` で実プロジェクトを読み込む（219MB を `page.evaluate` の引数として渡すと `RangeError` になるため、route 経由の fetch が必須）。
  3. `structuredClone` で対象 comp を複製し `parent`/`mergeInputs.objectId` を再採番、`store.setState({ project, currentCompId })` で直接差し替える（`duplicateComposition` 相当の store アクションは未実装 — 本レポート時点）。
  4. `git stash`/`pop`（`src/runtime/DomRenderer.ts` + `public/player.js`）で Phase A on/off を切り替え、Vite HMR 後に同一シナリオを再実行して比較する。
