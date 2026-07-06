# プレビューキャッシュ（RAM Preview オーバーレイ）ON 時の見え方 — 疑わしい点の記録（未調査）

> **対象**: Preview パネルの Cache 設定（§28 RAM Preview / Auto Cache）が **ON** の間の見え方全般。
> **状態**: 2026-07-06 **未調査**（下記「再生時にライブで再生されている印象が多い理由」のみコードレビューで機構を特定済み。それ以外の「疑わしい点」は引き続き未調査）。**実機（Playwright/実 Chrome）でのピクセル差分・待ち時間の実測は未実施** — 下記の「理由」はコードの制御フローから導いた**強い仮説**であり、wall-clock での確定はこれから。
> **非対象**: Subject Extract split-alpha WebM 固有の再生不安定さ（[別issue](./subject-extract-split-alpha-webm-preview-instability.md)を参照。holdTimeline 起因の凍結は本 issue と別系統）。

---

## 再生時に「ライブで再生されている」印象が多い理由（2026-07-06 追記・コードレビューで機構を特定）

> ユーザー報告: 「実際に再生したとき、live で再生されている印象があることが多い」。調査の結果、**これは気のせいではなく、実装が意図的にそう作られている**ことが分かった。Cache が ON でも、**Play を押した瞬間に「ワークエリア全域が100% bake 済みか」という all-or-nothing の判定を1回行うだけ**で、その判定に通らなければ**その再生セッションは最初から最後まで一切キャッシュを使わない**（享受はスクラブ時とは別ロジック）。

### 主因: 再生中の cache overlay 使用は「ワークエリア全域 bake 完了」の all-or-nothing ゲート

[ramPreview.ts](../../src/editor/ramPreview.ts) `shouldPreferCacheOverlay()`（L179–183）:

```ts
shouldPreferCacheOverlay(isPlaying: boolean): boolean {
  if (!this.shouldPreferCacheDisplay()) return false;
  if (!isPlaying) return true;                 // scrub: 毎フレーム独立に判定
  return this.isWorkAreaBuildComplete();        // 再生中: ワークエリア全域の bake 完了が必須
}
```

`isWorkAreaBuildComplete()`（L186–188）は `buildProgress >= buildTotal`（ワークエリア = in/out point 内の**全フレーム**）を見ている。つまり:

- **スクラブ中**は1フレームごとに独立してキャッシュ有無を判定する（一部だけ bake 済みでも、bake 済みフレームだけキャッシュ表示される）。
- **再生中**は「今から再生する範囲が1フレームでも未 bake なら、その再生は最初のフレームから最後のフレームまで丸ごとキャッシュを使わない」という厳格な判定。1フレームでも欠けていれば実質**再生全体がライブ描画**になる。

### 副因1: 再生中は cache の書き込み自体が止まる（read-only）

`setPlaybackActive(true)` は `frameQueue.setPaused(true)` を呼び、**再生中は新規 bake を一切行わない**（§28.4、CPU をレンダリングと奪い合わせない設計）。つまり `isWorkAreaBuildComplete()` は **Play を押した瞬間の状態で固定**され、再生中に追いつく余地がない。「途中から追いついてキャッシュに切り替わる」ことは構造上起こらない。

### 副因2: bake は「再生していない間」だけ、1フレームずつ idle-callback を挟んで進む

[frameCacheQueue.ts](../../src/cache/frameCacheQueue.ts) `runPump()` は1フレーム処理するたびに `yieldToMain()`（`requestIdleCallback(..., { timeout: 16 })` またはフォールバックの `setTimeout(0)`）を挟む。**既にキャッシュ済みのフレームでも `store.get(key)` の確認だけで1ティック消費する**ため、100〜150フレームのコンプでは「全フレームが既にキャッシュ済みであることを再確認するだけ」でも数十〜数百ティック＝実時間で1秒以上かかりうる。ブラウザが他の作業で忙しいとさらに伸びる。

### 副因3: ほぼ全ての「編集 → すぐ Play」操作が bake 進捗を 0 に巻き戻す

[ramPreview.ts](../../src/editor/ramPreview.ts) `updateConfig()`（L81–121）は次のいずれかで `abortBuild()`（buildProgress/buildTotal を 0 にリセット）を呼ぶ:

- コンプ切替（`compChanged`）
- **プロジェクトの編集**（`revisionChanged`。プロジェクト内のどこを編集しても対象コンプの `projectRevision` が変わる）
- **quality 切替**（`qualityChanged`）— Inspector で数値をドラッグ/フォーカス編集している間だけ `previewQualityEditing=true` になり `effectiveTextQuality` が `draft` に落ちる（[PreviewPanel.tsx](../../src/editor/panels/PreviewPanel.tsx) L317, [InspectorPanel.tsx](../../src/editor/panels/InspectorPanel.tsx) の `onEditFocus`/`onEditBlur`）。編集開始・終了のたびに draft⇄precise が切り替わり `abortBuild()` が呼ばれる
- 解像度プロキシ切替・ワークエリア変更

**「何かパラメータを触って確認のため Play を押す」という最も典型的な操作パターンそのものが、直前に `abortBuild()` を発火させる**。ここで注意すべきは、`abortBuild()` は**既にキャッシュ済みの PNG 自体は消さない**（`store` はそのまま）が、`buildProgress`/`buildTotal` という**進捗カウンタだけ**を 0 に戻す。そのため `isWorkAreaBuildComplete()` は即座に false へ戻り、たとえ全フレームが実際にはまだ store 内に残っていても、**副因2の「1フレームずつ再確認」を最初からやり直さないと「完了」とは認識されない**。編集直後にすぐ Play を押せば、この再確認が終わる前に再生が始まり、上記主因により**その回の再生は丸ごとライブ描画**になる。

### 副因4: スクラブでは「効いてるように見える」のに Play では効かない、という体感の齟齬

`shouldPreferCacheOverlay(false)`（スクラブ）は bake 完了を問わないため、キャッシュが部分的にしか出来ていなくても**触った箇所からキャッシュのオーバーレイが表示される**（ユーザーは「あ、キャッシュ効いてる」と体感できる）。ところが同じ状態で Play を押すと `shouldPreferCacheOverlay(true)` は全域完了を要求するため**キャッシュは使われずライブ描画一色になる**。スクラブ時とキャッシュバッジ（`Cached` 表示）で「効いている」と見えていたのに、いざ再生すると「なんとなくライブっぽい」と感じるのは、**この2つの判定基準の非対称性**が原因として非常に筋が通る。

### 副因5: デフォルトのワークエリアはコンプ全体（トリムしない限り全フレーム bake が必要）

[workAreaStorage.ts](../../src/editor/workAreaStorage.ts) `loadWorkArea()` は保存済みワークエリアが無ければ `{ inPoint: 0, outPoint: duration }` を返す。つまりユーザーがワークエリアを明示的にトリムしていない限り、「全域 bake 完了」は**コンプ全長ぶんのフレームを1枚残らずキャッシュし終える**ことを意味する。尺が長いコンプほど、副因2の実時間コストが積み上がり、副因3の「編集→即Play」で振り出しに戻る確率も相まって、**現実的にはほぼ完了しないまま再生が繰り返される**構図になりやすい。

### 現状の badge 表示との整合性（バッジは嘘をついていない）

`getDisplayStatus()`（[ramPreview.ts](../../src/editor/ramPreview.ts) L258–276）の `"cached"` 状態は `playbackAttempts > 0` を条件にしており、`playbackAttempts` は [PreviewPanel.tsx](../../src/editor/panels/PreviewPanel.tsx) の `performPreviewRender()` 内で **`preferCache`（= `shouldPreferCacheOverlay`）が true の分岐でしか加算されない**。つまり上記主因によりオーバーレイが使われない再生中は `playbackAttempts` が 0 のままなので、バッジは `"cached"` を名乗らず `"building"` か `"realtime"` を表示する。**バッジは正直だが、多くのユーザーは「Cache 設定を ON にした」こと自体を覚えていて、バッジの `Building`/`Realtime` 表示までは注視していない**ため、体感としては「キャッシュ ON にしたのにライブっぽい」という違和感だけが残りやすい。

### まとめ

「再生時に live っぽい」という印象は、少なくとも次の一本の因果関係でかなりの部分が説明できる:

**Cache ON でも、Play 直前に対象範囲が1フレームも欠けず bake 済みでなければ、その再生は最初から最後までキャッシュを一切使わない（読み込みも書き込みも）** → **典型的な「編集して確認のため即 Play」という操作は、直前の編集で bake 進捗を 0 に戻してしまうため、ほぼ毎回この「未完了」状態で Play を押すことになる** → **結果として「Cache ON なのに再生はほぼ常にライブ描画」という状態が常態化しやすい**。

これは個々のキャッシュ機構が壊れているのではなく、**「再生中は完了保証がない限りキャッシュに切り替えない」という安全側の設計判断**（§28.4 のコメント通り、再生中の hit/miss チラつきを避けるため）が、**現実の操作パターン（頻繁な編集→即確認）とかみ合っていない**ために起きている。

### 次に検証すべきこと（このセクション固有）

1. 代表的な尺（150フレーム程度・実プロジェクト規模）のコンプで、無編集のまま何秒アイドル待機すれば `isWorkAreaBuildComplete()` が true になるかを実測する。
2. 「数値を1つ編集 → 即 Play」を実機で繰り返し、`getDisplayStatus()` が実際に毎回 `"building"`/`"realtime"` のままで `"cached"` に到達しないことを確認する。
3. ワークエリアを短く明示トリムした場合に、同じ操作パターンでも「Cached」に到達しやすくなるか（副因5の裏付け）を比較する。
4. 改善案の検討: 例えば「未完了でも、その時点までに実際に bake 済みのフレームだけは再生中もオーバーレイを使う」という**部分キャッシュ再生**へ緩和する設計は、hit/miss チラつきとのトレードオフになるため、変更の要否も含めユーザーと要相談（§28 は INV に直接触れないが、`ramPreview.ts` の中核ロジックの挙動変更になるため、着手前に方針確認を推奨）。

---

**関連 spec**: §28（Preview Cache / RAM Preview）
**関連実装**: [ramPreview.ts](../../src/editor/ramPreview.ts) / [previewCacheService.ts](../../src/editor/previewCacheService.ts) / [precompRasterService.ts](../../src/editor/precompRasterService.ts) / [tieredFrameRenderCache.ts](../../src/runtime/tieredFrameRenderCache.ts) / [tieredCacheStore.ts](../../src/cache/tieredCacheStore.ts) / [realtimeDetector.ts](../../src/editor/realtimeDetector.ts) / [PreviewPanel.tsx](../../src/editor/panels/PreviewPanel.tsx)（`performPreviewRender` L217–278 が分岐の実体）

---

## 背景 — 現状は「2つの独立したキャッシュ」が同じストレージを共有している

1. **①全画面 PNG（RAM Preview）** — コンポ全体を `compFrameCapture.ts` の foreignObject キャプチャ経路で1枚の PNG に焼き、ヒットすると Preview の DOM 描画を止めて `<img>` オーバーレイに丸ごと差し替える（`PreviewPanel.tsx` の `useCachedFrame` 切替）。
2. **②per-layer / precomp raster** — `DomRenderer` がライブ描画する**途中で**内部的に参照する部品キャッシュ（オブジェクト単体 or ラスター化対象のネスト comp 単体）。①のオーバーレイが出ていなくても独立に効く。

両方とも同じ `TieredCacheStore`（L1メモリ + L2 IndexedDB）に書き込むが、失効条件・書き込みタイミング・レンダリング経路がそれぞれ別。

---

## 疑わしい点（コードレビューのみ・実機未検証）

### 1. ①のキャッシュ PNG は「ライブ DOM 描画」とは別経路で焼かれている

`RamPreviewController.ensureCaptureCtx()` はキャッシュ書き込み用に `createCompFrameCaptureContext` を使い、**foreignObject インライン化 + オフスクリーン rasterize** という、通常の Preview（実 DOM + `DomRenderer`）とは別のレンダリングパイプラインで PNG を焼く。両者は「一致するはず」という前提の上に立っているが、実測で一致を保証する自動テストは見当たらない。フォント・フィルタ・blend mode 等の扱いが両経路でわずかにズレると、**cache-hit フレームとその前後の live-render フレームの間で見た目が「ポン」と変わる**可能性がある（[Subject Extract issue](./subject-extract-split-alpha-webm-preview-instability.md) や [MP4 adjustment layer parity issue](./mp4-live-adjustment-layer-parity.md) と同じ「共有キャプチャ経路の片側だけ挙動が違う」という構造的リスク）。

### 2. キャッシュ PNG は常に `textQuality: "precise"` で焼かれるが、ライブ描画はスクラブ中 `"draft"` になりうる

`ensureCaptureCtx()` のコメント通り「キャッシュ PNG は live preview との parity を優先し、常に precise テキストで焼く」という**意図的な設計**だが、`PreviewPanel.tsx` の `effectiveTextQuality` はスクラブ中（`previewQualityEditing`）に `"draft"` へ落ちる。つまり:

- スクラブ中: ライブ描画 = draft品質 / キャッシュヒット時のオーバーレイ = precise品質で焼かれた PNG。
- **同じスクラブ操作の中で、cache-hit したフレームだけ他のフレームよりテキストの見た目が変わる**（滑らかさ・アンチエイリアスの質が変わる）可能性がある。意図的な parity 優先の判断だが、体感としては「キャッシュが効いた瞬間だけ何か違う」と映りうる。

### 3. `RealtimeDetector` はサンプル数が非常に少ない（直近8件・中央値）

`isRealtimeCapable()` は直近最大8サンプルの中央値と fps 予算（85%）を比べるだけ。1コンプ内で「軽いフレーム」と「重いエフェクトが乗るフレーム」が混在すると、再生セッション中に realtime 判定が true/false を行き来し、**同じ再生の中でキャッシュ表示が付いたり消えたりを繰り返す**構造になっている。`shouldPreferCacheOverlay` は再生中はワークエリア全体の bake 完了を条件にしているため頻繁な切替は抑制されるはずだが、**bake が完了した直後・その日最初の再生など「完了判定の境界」でどう振る舞うかは実機検証していない**。

### 4. Auto Cache（§28.9）は session 限定 ON — OFF に戻すタイミングでの表示ズレ未検証

重い comp（displacement / processPixels / previewBake 必須）で再生を始めると `autoCacheSession` が自動的に true になりキャッシュが有効化されるが、これは「再生を始めた瞬間」にトリガーされる（`activateAutoCacheIfNeeded`）。**まだ何もキャッシュされていない1回目の再生の冒頭数フレーム**は必然的に live 描画 → 徐々に bake が進み、いつの間にかオーバーレイに切り替わる。この切替の瞬間に③と同種の「見た目が変わる」体感が起きていないか未検証。

### 5. ①の失効は `projectRevision` 単位（コンプ全体）、②の失効は `propsHash` / `contentHash` 単位（部分）

同じコンプ内で何か1つ編集しただけで①は**全フレーム**作り直しになる一方、②（layer/precomp）は変更箇所だけが失効する。理屈の上では独立していて問題ないはずだが、**①が全滅して再 bake 中の間、②の生き残ったキャッシュとライブ描画がどう混ざるか**（＝bake 中の途中経過が正しいか）は実機で確認していない。

### 6. 表示中の hit-rate バッジ（`Cached NN%`）が「実際に正しい絵を出せているか」を検証していない

`notePlaybackFrame(hit)` は「PNG が見つかったかどうか」だけを見ており、**そのPNGが今の見た目（projectRevision・quality・proxy）と一致しているか」はキー自体の一致でしか保証されない**。上記1・2のような「キーは一致するが実描画結果が微妙にズレている」ケースはこの hit-rate には一切反映されない。つまり**バッジが「Cached 100%」でも見た目のズレが起きうる**（バッジは書き込み/読み出しの成否を見ているだけで、視覚的な parity を保証する指標ではない）。

---

## 次にやるべきこと

1. 実機 Playwright（[subject-extract issue の検証手法](./subject-extract-split-alpha-webm-preview-instability.md#実機-playwright-検証2026-07-06-追記他セッションからのフィードバック反映)と同様に `window.__mafterEditorStore` 直接操作）で、キャッシュ ON/OFF を切り替えながら同一フレームのスクリーンショットを比較し、①のライブ描画とキャッシュ PNG の**ピクセル差分**を実測する。
2. スクラブ中の draft/precise 切替（疑わしい点2）が実際に視認できる差になっているかを、テキストを含む comp で確認する。
3. Auto Cache 起動直後（疑わしい点4）とワークエリア bake 完了の境界（疑わしい点3）で、再生を数回繰り返し「表示が変わる瞬間」が実際に見えるかを目視確認する。
4. 上記で実差が確認できた項目のみ、原因ごとに個別の issue へ格上げして修正設計に進む（本 doc はあくまで「疑わしい点の一覧」であり、着手前の棚卸し）。
