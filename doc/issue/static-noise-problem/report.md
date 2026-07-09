# Bundle ループ境界の静的ノイズ

- 状態: 調査済み。まだこの issue ディレクトリ内に本番修正はない。
- 対象範囲: 埋め込み音声を含む動画フッテージの HTML bundle 再生。Downloads `mafter-project (25).zip` / `Comp 10` と `Comp_10_bundle (4).zip` を使用。
- 日付: 2026-07-10

## 結論

主因は、ループする bundle が作業範囲の末尾から先頭へ native `<video>` を seek したときに生じる可聴な不連続です。既存の declick 機構は `HTMLVideoElement.volume` を使っていますが、これは scene が描画されたときにしか更新されません。サンプル精度のフェードはできず、適応的な描画スキップによって最後のフェード更新自体が抜け落ちることもあります。その結果、各ループ境界でクリックやノイズが発生します。

これはソース資産の AAC デコード失敗ではありません。bundle のループ境界における再生制御の問題です。

## 再現条件と計測

`Comp 10` には、埋め込み音声を持つ動画レイヤが 1 つあります。

| 項目 | 値 |
| --- | --- |
| Comp | `Comp 10` (`01KVV05RE10X4E9H1AR77JPCH7`) |
| タイムライン範囲 | `[0, 112)`、30 fps |
| ループ切り位置 | 3.733333 s |
| フッテージ | `assets/01KWA0CRAPAJAKW4TP82JPDAWQ.mp4` |
| ソース音声 | AAC-LC、48 kHz ステレオ |
| 生の境界差分、左 | -0.0316361 |
| 生の境界差分、右 | -0.0197550 |

このソースはたまたま 3.733333 s でループ安全ではありません。切断位置の直前サンプルは非ゼロで、最初のサンプルはゼロです。そのため、出力がすでに実質的に無音でない限り、`currentTime = 0` を直接行うと不連続が発生します。

現行の 120 ms `autoFade` を 30 fps で評価すると、解決される video gain は次のとおりです。

| タイムラインフレーム | 乗数 |
| --- | ---: |
| 108 | 0.999976 |
| 109 | 0.969979 |
| 110 | 0.798842 |
| 111 (最終フレーム) | 0.362285 |

全フレームを描画していても、frame 111 はフレーム中央で gain を解決しますが、`volume` の反映は描画 cadence に縛られます。そのため、seek 時点では依然として非ゼロ出力が残ります。適応スキップが入ると、renderer は 108〜110 frame で最後に volume を更新したままになる可能性があり、生の不連続の約 80〜100% が残ります。

## コード経路

1. [`BundlePlayer.ts`](../../../src/player/BundlePlayer.ts) は、composition に standalone な `audio` layer がない場合に `runPreviewPlaybackLoop` を使います。`Comp 10` はこの経路です。
2. [`previewPlaybackLoop.ts`](../../../src/runtime/previewPlaybackLoop.ts) は、`renderGate` に `renderFrame` 呼び出しをスキップさせながらタイムラインを進めます。
3. [`resolve.ts`](../../../src/runtime/resolve.ts) は、描画された timeline frame に対してのみ、フッテージの auto-fade を解決済み video `gain` に適用します。
4. [`DomRenderer.ts`](../../../src/runtime/DomRenderer.ts) はその gain を `video.volume` に書き込み、[`videoElementSync.ts`](../../../src/runtime/videoElementSync.ts) は loop wrap 時に再生中の video を seek します。

音声マスターの clock に対して visual frame skip 自体は正しい挙動です。欠けているのは、描画をスキップしている間も連続性を保つ音声制御経路です。

## 副次的な発見

`BundleAudioClock` には standalone `audio` layer 向けの別の正当性ギャップがあります。各 `HTMLAudioElement` を `(fromFrame - rangeStart) / fps` で開始しているものの、layer の `inPoint` や `trimStart` を適用しておらず、`outPoint` で停止もしていません。これは観測された Comp 10 のノイズ原因ではありません（Comp 10 には `audio` layer がないため）が、同じ修正で footage audio のタイミングを集約し、2 つの HTML element 経路が乖離しないようにすべきです。

## 証拠の限界

数値的な境界計測は実際のソースに不連続があることを示しており、コード経路はその不連続が非無音のまま直接 seek されていることを示しています。ただし、この調査ではブラウザのスピーカー出力は記録していないため、校正済みの音量測定ができたとは主張しません。検証スクリプトは同じ fixture 事実を記録し、修正後の回帰ゲートになることを意図しています。

## 診断の実行

```powershell
node doc/issue/static-noise-problem/verify-loop-audio-seam.mjs
```

別の project zip や composition 名を使う場合は `--help` を参照してください。現在の Comp 10 fixture は、既知の安全でない境界を示すため、意図的に非 0 で終了します。
