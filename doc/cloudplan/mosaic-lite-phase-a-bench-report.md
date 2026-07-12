# mosaicLite（Mosaic Live）軽量化 Phase A — 実測ベンチマークレポート

> **ステータス**: 実装済み・検証済み（`perf/mosaic-lite-lightweight` ブランチ、未マージ）。
> 本ファイルは [mosaic-live-effect.md](mosaic-live-effect.md)（設計 PLAN）・
> [mosaic-live-effect-for-codex.md](mosaic-live-effect-for-codex.md) の続報。
> §5 スキーマ・INVARIANT・`project.json` 直列化形式への変更は無し。
> 作成日: 2026-07-11。生データは [mosaic-lite-phase-a-bench/](mosaic-lite-phase-a-bench/) 配下。
>
> **⚠️ 2026-07-12 追記で §5.2 の結論を訂正 + PLAN 選択肢B 実装済み**: 本レポートの §5.2
> 「PLAN 選択肢B の優先度を下げる」は**動画・音声・precomp を含む重量級コンプ（Comp 10）に
> 限った結論**であり、シンプルなコンプでの実マウスドラッグ scrub には当てはまらないことが判明した。
> root-cause pass（CDP Tracing）により **compositor の `MainFrame.Draw` が mosaicLite 有効時に
> 平均60.32ms/回（無効時0.29ms/回・208倍）**であることを特定し、2段階で最適化した:
> **改定6** = gradient+blend-mode → 事前計算PNGタイル化（GPU側 SwapBuffers/Present を17〜25倍改善したが
> `MainFrame.Draw` は54msで残存）。**改定7** = PNGタイルを敷く手段を `feImage`(ネスト SVG `<pattern>`) から
> native `feTile` に置換 → **`MainFrame.Draw` が 54ms→0.39ms（97%減・ベースライン0.29ms同等）**。
> mosaicLite の live プレビュー重さは改定7で**実質解決**（視覚回帰なし）。詳細は §6.6/§6.7 を参照。

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

## 6. 追記（2026-07-12）— シンプルなコンプでの scrub 重さを実 Chrome で再現・§5.2 の訂正

ユーザーから「mosaicLite があるとテキスト単体等のシンプルなコンプでも scrub/再生プレビューの
フレームレートが著しく落ちる」という報告を受け、再調査した。

### 6.1 それまでの非再現の原因

`headless`/実 Chrome を問わず、`setPlaying(true)` や合成フレームステップ＋
`requestAnimationFrame` タイミング計測による repro はすべて非再現（常に 60fps）だった。
原因は2つ: (a) 合成的なフレーム送りは実際のドラッグ scrub と異なるレンダリング経路を通る可能性、
(b) `requestAnimationFrame` は JS スレッドのスケジューリングしか見ておらず、GPU ペイント/
コンポジット段階の遅延を検知できない。

### 6.2 ユーザー提供の実キャプチャ解析

ユーザーが `Adjustment`+`mosaicLite` ON でのスクラブ/再生を画面録画（2本、24.7s/9.5s）。
ffmpeg (`mpdecimate`/`freezedetect`) で解析。**プレビュー canvas 領域のみ**
（タイムライン UI・カーソルを除外したクロップ）でユニークフレームを数えると:

| capture | 区間 | canvas ユニーク更新レート | 最大停滞 |
|---|---|---|---|
| capture1 | mosaicLite OFF（0–10s） | 10.42fps | — |
| capture1 | mosaicLite ON（10–24.6s、同一セッション内） | 6.87fps（-34%） | 2.18s |
| capture2 | mosaicLite ON（全編） | 4.23fps | 4.12s |

フルフレーム比較（UI含む）では重複率31〜43%程度にしか見えなかった —
タイムラインの再生位置表示やカーソルが動き続けるため、canvas 自体の停止が
「別フレーム」判定に埋もれて過小評価されていた。

### 6.3 プログラムでの再現に成功

**実際のマウスドラッグでのタイムライン scrub**（`page.mouse.down/move/up` でルーラー上を継続ドラッグ）
＋ **CDP `Page.startScreencast`**（Chrome がペイント内容の変化を検知した時だけフレームを送出する、
外部ヒューリスティックでない内部シグナル）を組み合わせることで、実 Chrome 上で明確に再現した:

| シナリオ | screencast フレーム排出レート | 500ms超の停滞 |
|---|---|---|
| Text レイヤーのみ（mosaicLite なし） | 平均 18.52fps | ほぼ無し |
| Adjustment+mosaicLite（blockSize 16）+ Text | 平均 8.27fps（-55%） | 頻発（600ms超×複数） |

同一ブランチ（**Phase A の defs 再構築スキップ適用済み・未コミット**）で計測しており、
**Phase A 適用後もこの重さは解消されない**ことを確認した。ボトルネックは DOM `<defs>` 再構築
ではなく、GPU 側のフィルタ適用（`backdrop-filter` + `feImage`/`mix-blend-mode:screen` の
ラスタライズ）自体である可能性が高い。§4 の CPU プロファイルで `DomRenderer` の寄与が
CPU 全体の 2.5〜5% だったことと矛盾しない — GPU/コンポジタ側のコストは CPU プロファイラには
現れない。

### 6.4 §5.2 の訂正

「PLAN 選択肢B（feImage→事前計算PNGタイル化）の優先度を下げる」という結論は
**動画・音声・precomp を含む重量級コンプ（Comp 10）に限った話**であり、シンプルな
コンプでの実ドラッグ scrub には当てはまらない。ユーザー報告は実測で裏付けられた実在のバグであり、
選択肢B（またはC: blend-mode 自体のコスト切り分け）の優先度を上げるべきである。

### 6.5 root-cause pass（CDP Tracing）— 結論: compositor の `MainFrame.Draw` が支配的コスト

同じ実ドラッグ scrub シナリオ（mosaicLite あり/なし、各6秒間）を CDP `Tracing.start`
（`devtools.timeline`/`toplevel`/`gpu`/`cc`/`viz` カテゴリ）で計測し、イベント名ごとに
合計 duration を比較した。

| イベント | 意味 | mosaic あり | mosaic なし | 倍率 |
|---|---|---:|---:|---:|
| `MainFrame.Draw` / `ProxyImpl::ScheduledActionDraw` | compositor がフレームを描画する主処理 | 115回・合計6937ms・**平均60.32ms/回** | 115回・合計32.8ms・平均0.29ms/回 | **208倍** |
| `Graphics.Pipeline`（viz） | GPU パイプライン全体 | 8403回・合計17013ms・平均2.02ms | 5255回・合計1711ms・平均0.33ms | 約6倍（平均） |
| `SkiaOutputSurfaceImplOnGpu::SwapBuffers` | GPU バッファのスワップ | 116回・平均25.17ms | 116回・平均13.76ms | 1.8倍 |
| `DXGISwapChainImageBacking::Present` | 画面への提示 | 116回・平均24.84ms | 116回・平均13.68ms | 1.8倍 |
| `Paint` / `RasterDecoderImpl::DoEndRasterCHROMIUM` | ペイント/ラスタデコード | ほぼ同等 | ほぼ同等 | 差なし |

**`MainFrame.Draw` 1回あたり平均 60.32ms**（mosaic あり）は、それだけで理論上のフレームレート上限を
**約16.6fps**に制限する（60fps どころか 30fps にも届かない）。同じ 115 回の draw が baseline では
平均 0.29ms しかかからないため、この 60ms は「タイムラインが重いから」ではなく**mosaicLite の
CSS filter（backdrop-filter + feImage/pattern/mix-blend-mode）自体が compositor の draw 処理を
208倍重くしている**ことを直接示す。`Paint`/`RasterDecoderImpl` はほぼ差がないため、原因は「ラスタライズの
実行時間」ではなく「compositor がフレームを構築・スケジュールする main draw 処理」側にある
（feImage 参照先の nested SVG document の解決コストが compositor スレッド側のフレーム構築を
ブロックしている可能性が高いが、これ以上の内訳分解は本調査のスコープ外）。

**結論**: PLAN 選択肢B（`mosaicGridSnapFilter` の pattern+gradient+mix-blend-mode を
事前計算 RGBA PNG タイル化、`rippleDisplaceMap`/opticsCompensation と同パターン）が
次の実装候補として最も筋が良い。`feImage` の参照先を「gradient/pattern/blend-mode を含む
nested SVG document」から「単純なフラット PNG」に変えることで、この compositor 側のコストが
下がるかを検証してから着手判断する。

再現スクリプトは使い捨て（Playwright + 実マウスドラッグ + CDP screencast/Tracing、本コミットには
含めていない）。生データ（`.png` フレーム列・trace JSON）も一時ディレクトリのみで保存していない
（集計後の数値のみ本レポートに記録）。再実行する場合は次の手順で最小コンプを構築する:
`addAdjustmentLayer`/`addEffect(id, "mosaicLite")`/`addText` で
最小コンプを構築し、タイムラインルーラー要素（`cursor:pointer` かつ `height:22px` の div、
`TimelinePanel.tsx` の `graphRef`）に対して `page.mouse.down/move/up` で実ドラッグを行う。
screencast は `client.send("Page.startScreencast", {...})`、trace は
`client.send("Tracing.start", { categories: "devtools.timeline,toplevel,gpu,cc,viz,...", transferMode: "ReportEvents" })`
→ `Tracing.dataCollected` イベントを蓄積 → `Tracing.end` → `name` ごとに `dur` を合算する。

### 6.6 PLAN 選択肢B 実装・実測（2026-07-12・同セッション）

`mosaicGridSnapFilter()`（[effectSvg.ts](../../src/runtime/effectSvg.ts)）を実装: `<pattern>` タイル内部の
2×`linearGradient` + `mix-blend-mode:screen` を、JS 側で block×block（16..256 に clamp）の RGBA を
事前計算し `rgbaToPngDataUri()` で焼いた `<image>` に置換。`<pattern>` によるレイヤー全域タイリングの
外枠は維持（§7.5 の全域フラット PNG 化は下記の理由で不採用）。

**同一手法（実ドラッグ scrub + CDP screencast/Tracing）で before/after を再計測**:

| 指標 | before（gradient+blend-mode） | after（PNG タイル） | 変化 |
|---|---:|---:|---:|
| `MainFrame.Draw` 平均 | 60.32ms/回 | 54.37ms/回 | -10%（**支配的コストのまま**） |
| `SkiaOutputSurfaceImplOnGpu::SwapBuffers` 平均 | 25.17ms | 1.45ms | **-94%（17倍）** |
| `DXGISwapChainImageBacking::Present` 平均 | 24.84ms | 0.98ms | **-96%（25倍）** |
| `Graphics.Pipeline` 平均 | 2.02ms | 1.54ms | -24% |
| screencast フレーム排出レート（平均） | 8.27fps | 10.43fps | **+26%** |
| screencast 停滞（最大ギャップ） | 600ms超が複数回 | **124ms が最大**（同条件のベースライン=mosaicLiteなしの572msより小さい） | 大幅改善 |

**評価**: GPU 側（SwapBuffers/Present）は劇的に改善し、体感上最も気になる「数百ms単位の完全停止」は
ほぼ解消された。一方 `MainFrame.Draw`（compositor の主描画処理）は約10%減にとどまり、
mosaicLite なしのベースライン（0.29ms/回）との差はまだ大きい（186倍）。**部分的な改善であり、
完全な解決ではない**。

**不採用にした案（全域フラット PNG 化）**: §6.5 の仮説（feImage が参照する“document”自体のコストが
dominant では）を検証するため、`<pattern>` を廃し layer 全域（1920×1080）を 1 枚のフラット PNG として
`feImage` に直接渡す案を試作・計測した。`MainFrame.Draw` への効果は未計測のまま**別の理由で却下**:
JS 側の PNG 生成自体が **1073ms**（無圧縮 zlib stored + base64 化）かかり、data URI サイズが
**11MB** に達した。`blockSize` 変更のたびに 1 秒級の同期処理でエディタが固まることになり、
たとえ compositor 側が速くなっても UX 上不採用。将来この方向を追うなら Web Worker 化・低解像度
ダウンサンプル + タイル境界の周期整合という別課題が必要になる（未着手）。

### 6.7 追加最適化（同セッション・改定7）— feTile 化で `MainFrame.Draw` の残コストも解消

§6.6 で残った `MainFrame.Draw` 54ms の実体を切り分けるため、隔離シーン（動く gradient 背景 +
静的オーバーレイに `backdrop-filter: url(#fx)`、rAF で背景を毎フレーム動かして再コンポジットを強制）で
displacement map 構築を 2 通り比較・実測した:

| 変種 | MainFrame.Draw 平均 | 5秒間の描画フレーム数 |
|---|---:|---:|
| A. 改定6（`feImage`(ネスト SVG 文書内 `<pattern>`) + `feDisplacementMap`） | **21.17ms** | 133〜148（≈30fps に律速） |
| B. `feImage`(block×block 生 PNG 1枚) + native `feTile` + `feDisplacementMap` | **0.58ms** | 302（60fps 完走） |
| C. ベースライン（フィルタ無し） | 0.17ms | 302 |

→ **B は A 比 97% 減、ほぼベースライン同等**。原因が確定した: `MainFrame.Draw` 54ms の実体は
**backdrop-filter 下で Chrome が `feImage` の参照先（`<pattern>` を含むネスト SVG 文書）を毎フレーム
再ラスタライズしていた**こと。ネスト SVG 文書を捨て、SVG フィルタ native の `feTile` プリミティブ
（フィルタグラフ内で block タイルを全域反復）に変えると、この再ラスタが消える。

**実装（改定7）**: `mosaicGridSnapFilter()` の primitives を
`feImage`(生 PNG タイル・block×block) → `feTile`(x/y/width/height = 0,0,w,h で全域反復) →
`feDisplacementMap` に変更。ネスト SVG 文書・`<pattern>`・`svgDataUri`・`displaceWithMap` 経由を廃止。
`<!--mafter:mosaicLite-->` マーカー（`effectRaster.ts` の `compFixed` 判定に使用）は維持。

**実アプリ実ドラッグ scrub での再計測**（Adjustment+mosaicLite blockSize16 + Text・実 Chrome + CDP Tracing）:

| 指標 | 改定5(gradient) | 改定6(PNG+pattern) | **改定7(feTile)** | ベースライン(no mosaic) |
|---|---:|---:|---:|---:|
| `MainFrame.Draw` 平均 | 60.32ms | 54.37ms | **0.39ms** | 0.29ms |
| `SwapBuffers` 平均 | 25.17ms | 1.45ms | **0.27ms** | — |
| `Present` 平均 | 24.84ms | 0.98ms | **0.18ms** | — |
| `Graphics.Pipeline` 平均 | 2.02ms | 1.54ms | **0.03ms** | 0.03ms |

**視覚回帰なし**: export-composite の ink 画素数は改定6 と完全一致（blockSize 4/16/64 = 14892/16242/8192）、
目視でも同一。`forceMosaicLiteExportCapture` 経路も 3 つの blockSize すべてで非空白を確認。

**結論**: mosaicLite の live プレビュー重さ（本レポートの主題）は改定7で**実質解決**した
（`MainFrame.Draw` がベースライン同等になった）。§6.5 で「compositor 主描画が支配的で下げ切れないかも」と
書いた懸念は、`feImage`(ネスト文書) → `feTile` の 1 点で解消できた。§7.5 で不採用にした「全域フラット PNG」
案（1秒級の生成停止・11MB data URI）も、feTile なら**そもそも全域 PNG を作る必要がない**ため不要。

---

## 7. 検証データ・再現方法

- ベンチ結果 JSON: [mosaic-lite-phase-a-bench/](mosaic-lite-phase-a-bench/) 配下 `bench-result-*.json`（before/after × 3run + static variant）。
- CPU プロファイル（Chrome DevTools 形式・`chrome://inspect` や VS Code の JS Profile Visualizer 等で読み込み可）: 同フォルダの `.cpuprofile` 2件。
- ベンチ・プロファイリングスクリプト自体は使い捨て（Playwright + CDP `Profiler` ドメイン、`store.setState`/`importZip` を直接操作）で本コミットには含めていない。再実行する場合は次の手順を踏む:
  1. `npm run dev` で dev server を起動。
  2. 対象プロジェクト zip を `page.route` で `/__bench_zip__` に応答させ、ページ内 `fetch` → `importZip(fs, bytes)` → `loadFromFs()` で実プロジェクトを読み込む（219MB を `page.evaluate` の引数として渡すと `RangeError` になるため、route 経由の fetch が必須）。
  3. `structuredClone` で対象 comp を複製し `parent`/`mergeInputs.objectId` を再採番、`store.setState({ project, currentCompId })` で直接差し替える（`duplicateComposition` 相当の store アクションは未実装 — 本レポート時点）。
  4. `git stash`/`pop`（`src/runtime/DomRenderer.ts` + `public/player.js`）で Phase A on/off を切り替え、Vite HMR 後に同一シナリオを再実行して比較する。
