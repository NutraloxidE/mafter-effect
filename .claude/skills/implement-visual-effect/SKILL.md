---
name: implement-visual-effect
description: 視覚エフェクト（displacement / noise / filter / 合成系）を新規実装・チューニング・ドリフト修正・軽量化するときの計測駆動フレームワーク。Amount/Amplitude を上げると中身がずれる・歪みの強さで重心が動く・preview と export が一致しない・パラメータをいくら振っても収束しない、といった「効くが正しくない」挙動に加え、「効くが重い」＝ live エフェクトで scrub/再生の preview FPS が落ちる問題も扱う。正しい計測プロキシの選択、パラメータ vs 経路（アーキテクチャ）の分岐判定、CSS filter とラスタ経路の選択、プロシージャルノイズのゼロ平均性、残差の閉じ方、および live effect の重さ切り分け（実 Chrome + 実操作 + CDP screencast/Tracing、feImage ネスト文書 → feTile 化）を扱う。debug-visual-render-bug を土台に、エフェクト特有の罠を上乗せする。
---

# 視覚エフェクトの実装・チューニング

エフェクトは「歪みの**強さ**を変えても、コンテンツの**論理位置・重心は不変**」が原則。
強さに比例して中身がずれる／重心が動くのは、ほぼ常に **(a) 計測量を間違えている** か
**(b) レンダリング経路が座標を歪めている** か **(c) プロシージャル素材の平均が中心からずれている**。
このスキルはこの 3 つを順に潰すための判断フレームワーク。前提として
[debug-visual-render-bug](../debug-visual-render-bug/SKILL.md) の「measure-don't-theorize ループ」に従う。
**親ループ**: [implementation-loop](../implementation-loop/SKILL.md) Phase 2–4（エフェクト系）。

## 使うとき
- 新エフェクト追加後、または `Amount`/`Amplitude`/`Scale` を上げると中身が片方向へドリフトする。
- パラメータ（強さ・intercept・offset 等）を振っても収束しない／別軸が壊れる。
- preview と export、通常レイヤーと調整レイヤーで見た目が一致しない。
- `npm test`/`typecheck` は緑だが目視でずれている（**緑 ≠ 視覚的正しさ**）。

## 中核フレームワーク（順に判断する）

### 1. 計測量を「知覚プロキシ」にする — コンテナ metric を信じない
最頻出の罠。エフェクトはコンテナ div を動かさず**中身**を変位させるので、
`getBoundingClientRect`（host/container）が不変でもユーザーの見る重心は動く。
- **測るのは合成後ピクセルの重心（ink centroid）**。stage をスクショ → 対象色をしきい値スキャン →
  重心を **comp 座標**に正規化。host rect は**併記**するが収束判定に使わない。
- host rect delta=0 を根拠に「解決」と判定したら、それは偽陽性を疑う。
- 判定式：`計測量はユーザーが見ているものと一致しているか？` 否なら計測量を変える。

### 2. パラメータ vs 経路（アーキテクチャ）を分岐する
1 変数（強さ・intercept 等）を 3〜4 点スイープし、誤差の縮み方を見る。
- 誤差が**単調に 0 へ縮む** → パラメータ問題。スイープで詰めて良い。
- 振っても**収束しない／別軸が悪化する／頭打ち** → **経路（実装）問題**。
  チューニングを止め、原因の層を上げる。ここで沼に入らないことが速さを決める。

### 3. 誤差の共通性で原因を局在化する
複数経路（通常レイヤー `filter:` と調整レイヤー `backdrop-filter`、preview と export）で
**同じ振る舞い**のずれが出るなら、原因は各経路ではなく**共通項**にある。
- 例: 両経路が等しく強さ比例ドリフト → 共通項は CSS filter + foreignObject キャプチャの座標系。
- 片方だけずれる → その経路固有の合成・サンプリング範囲を疑う。

### 4. 決定論が要る合成は CSS filter ではなくラスタ経路で握る
このコードベースの確定知見：**CSS `filter:` / `backdrop-filter:` + foreignObject キャプチャは
座標系がずれ、displacement 等で強さ比例ドリフトを生む。** 位置の決定性・座標掌握が要るなら、
ブラックボックス合成に頼らず**自前ラスタライズ**する。
- パターン: `要素/背面を canvas にキャプチャ → SVG <image filter="url(#…)"> でフィルタ適用`
  （[rasterCapture.ts](../../../src/runtime/rasterCapture.ts) `rasterizeFilteredImage`）。
- displacement の filter region は **`userSpaceOnUse` + 明示 `(x,y,w,h)`**
  （[effectSvg.ts](../../../src/runtime/effectSvg.ts) `svgDisplaceFilterMarkup`）。region を拡張すると
  comp 外サンプリングや原点ずれで定数バイアスが出る。
- `feImage`/map はレイヤー実寸 `(0,0,w,h)` に固定（filter region に引き伸ばされない）。

### 5. プロシージャル素材はゼロ平均（中心 0.5）にする
`feDisplacementMap` の変位は `scale·(channel − 0.5)`。チャンネル平均が 0.5 でないと
**scale（=強さ）比例の全画面シフト**になる。
- `feTurbulence type="turbulence"` は R/G が 0.5 から正へ偏る → 強さ比例ドリフトの主因。
- まず **`type="fractalNoise"`**（より中心化されている）に替える。これで大半が消える。
- 残差は `feComponentTransfer`（`feFuncR/G` の `intercept`）で軸ごとに中心へ寄せる。
  R=X 変位 / G=Y 変位。**残差が出た軸だけ**触る。

### 6. 残差を 1 変数ずつ閉じ、定量条件で収束、純関数でロック
- 経路を直してから（最大要因）→ 素材の中心化 → 軸別 intercept 微調整、の順で**毎段再計測**。
- **収束条件を数値で固定**：強さ 5/20/50/100 で `centroid delta ≤ 2px`（preview/直接/調整すべて）。
  「違って見える」ではなく数値で閉じる。
- 効いた定数・region 生成を**純関数として export** し、DOM 不要の unit test で固定
  （SVG 文字列に `intercept`/`userSpaceOnUse`/`width` が乗ることを検証）。罠を再導入させない。

## 7. ライブエフェクトの「重さ」— 正しさとは別軸（preview FPS）

§1〜6 は**正しさ**（ドリフト・parity）の軸。エフェクトが正しくても **live プレビューが重い**
（scrub / 再生で FPS が落ちる）のは別問題で、計測方法も原因も違う。「効くが遅い」を直すときの型:

### 7a. 重さは実 Chrome + 実操作 + コンポジタ信号で測る（rAF は当てにならない）
`requestAnimationFrame` の間隔や `setFrame` の合成フレーム送りは **JS スレッドしか見ない**。
GPU ペイント / コンポジット段の遅延はここに現れず、headless では 60fps の非再現になる。
- 実 Chrome（`chromium.launch({ channel:"chrome", headless:false })`）＋ **実マウスドラッグ scrub**
  （`page.mouse.down/move/up` でルーラーを連続ドラッグ）で駆動する。
- 出力の真の更新レートは **CDP `Page.startScreencast`**（Chrome が実際にペイント変化を検知したときだけ
  フレームを送る内部信号）で測る。`page.screenshot()` は同期ペイントを強制し停滞を隠すので不可。
- 詳細な前提は memory [[perf-testing-real-chrome-not-headless]]。

### 7b. 支配コストは CDP Tracing のイベント名で切り分ける（CPU プロファイラでは見えない）
`client.send("Tracing.start", { categories:"devtools.timeline,toplevel,gpu,cc,viz,...", transferMode:"ReportEvents" })`
→ `Tracing.dataCollected` 蓄積 → `Tracing.end` → **イベント名ごとに `dur` 合算**。見るべき名前:
- `MainFrame.Draw` / `ProxyImpl::ScheduledActionDraw` — compositor のフレーム構築主処理。
- `SkiaOutputSurfaceImplOnGpu::SwapBuffers` / `DXGISwapChainImageBacking::Present` — GPU 提示。
- `Paint` / `RasterDecoderImpl::DoEndRasterCHROMIUM` — ラスタライズ実行。
- 対照として **エフェクト無しのベースライン**を必ず並べて撮る（差分がエフェクト由来コスト）。
- CPU プロファイラ（`Profiler` ドメイン）に `DomRenderer` が数%しか出なくても、GPU/compositor 側の
  重さは別。**壁時計が縮まない理由の切り分けは Tracing、CPU profile ではない。**

### 7c. `feImage`(ネスト SVG 文書) は `filter`/`backdrop-filter` 下で毎フレーム再ラスタされる — `feTile` へ
このコードベースの確定知見（2026-07-12・mosaicLite）：**`feImage` の参照先が `<pattern>` /
`<linearGradient>` / `mix-blend-mode` 等を含むネスト SVG 文書だと、backdrop-filter の下で
Chrome がそのネスト文書を毎フレーム再ラスタライズし、`MainFrame.Draw` が桁で膨らむ**
（実測 21ms/frame vs baseline 0.17ms、約120倍）。map の中身が静的でもフレーム単位で再解決される。
- **直し方**: map を **フラットなラスタ（`rgbaToPngDataUri` の生 PNG）に焼き**、全域タイリングは
  ネスト `<pattern>` ではなく **SVG フィルタ native の `feTile`** で行う。タイリングがフィルタグラフ内
  （GPU/raster パイプライン）で閉じ、文書パース/ラスタが消える → `MainFrame.Draw` はベースライン同等へ。
  ```
  <feImage href="{block×block の生PNG}" x="0" y="0" width="{block}" height="{block}" result="t"/>
  <feTile in="t" x="0" y="0" width="{w}" height="{h}" result="map"/>
  <feDisplacementMap in="SourceGraphic" in2="map" .../>
  ```
- **全域を 1 枚の PNG に焼くのは不可**（1920×1080 で生成 1s 級・data URI 11MB でエディタが固まる）。
  タイル 1 個だけ焼いて `feTile` で敷くのが正解。
- 歴史的経緯: fastWave/fastRipple は `feImage` を捨て `feTurbulence` 直結に移行済み（改定4）。
  mosaic はグリッドの視覚的アイデンティティ上ノイズ化できないが、**feTile なら feImage を保ったまま
  同等に軽くできる**。「feImage=重い」ではなく「feImage(**ネスト文書**)=重い」が正確な教訓。

## チェックリスト（コピーして進捗管理）
```
正しさ（§1–6）
- [ ] 計測量を ink centroid（comp 座標）にした。host rect は併記のみ
- [ ] 強さ 5/20/50/100 をスイープし、誤差の縮み方を記録した
- [ ] パラメータで収束しない → 経路を疑った（沼回避）
- [ ] 複数経路の共通ドリフト → 共通項（CSS filter/capture 座標系）を特定
- [ ] 決定論が要る合成を raster + SVG image filter に移した
- [ ] displacement filter region = userSpaceOnUse + 明示 (x,y,w,h)
- [ ] noise を fractalNoise 化し、残差軸だけ intercept で中心化
- [ ] 1 変数ずつ・毎段再計測。centroid delta ≤ 2px で収束
- [ ] 定数/region を純関数 export し unit test で固定
重さ（§7・live effect の FPS が問題のとき）
- [ ] 実 Chrome + 実マウスドラッグ + CDP screencast で重さを再現（rAF/headless で終えない）
- [ ] CDP Tracing で MainFrame.Draw 等をベースライン対照付きで切り分けた
- [ ] feImage がネスト SVG 文書を参照していないか確認 → feTile + 生 PNG に置換
- [ ] 修正後、実操作 scrub で MainFrame.Draw がベースライン同等まで下がったか再計測
共通
- [ ] 一時 Playwright スクリプト・console.log を削除。doc/progress 更新
```

## アンチパターン
- host/container rect の不変を「解決」の根拠にする（中身は動いている）。
- 経路が原因なのに intercept/offset を延々スイープする（収束しないスイープは経路を疑え）。
- 各経路を個別パッチする（共通原因は共通項を 1 箇所直す）。
- 位置の決定性が要る合成を CSS filter/backdrop の合成器に委ねる。
- noise の平均を確認せず scale だけ調整する（平均≠0.5 なら強さ比例で必ずずれる）。
- 一時計測スクリプトや log をコミットに残す。
- **preview の重さを rAF / headless / `setFrame` 合成送りで「測って」非再現だと結論する**（§7a：実操作 + screencast でしか出ない）。
- **壁時計が縮まない理由を CPU プロファイルだけで判断する**（§7b：GPU/compositor コストは Tracing でしか見えない）。
- **`feImage` を見て「重いから全部 feTurbulence 化」と早合点する**（§7c：重いのは feImage(**ネスト文書**)。feTile + 生 PNG なら feImage のまま軽い）。

## この repo の worked example（Turbulent Displace ドリフト Phase 2）
症状: 調整/通常レイヤーとも Amount を上げると右下へドリフト。Phase 1 は host rect=0 で誤って解決判定。
1. 計測を host rect → **ink centroid** に変更 → amount100 で 36px の隠れドリフトが可視化（罠 1）。
2. `feComponentTransfer` intercept を -0.15〜-0.40 スイープ → 収束せず。**経路問題**と判断（分岐 2）。
3. direct も adjustment も等しく比例ドリフト → 共通項 = **CSS/backdrop filter の座標系**（局在化 3）。
4. CSS/backdrop filter を捨て **raster capture + `rasterizeFilteredImage`** に統一 → direct 一発 PASS、
   adjustment は残差のみ（経路 4）。
5. `turbulence → fractalNoise`（中心化 5）→ Y 軸残差を `FRACTAL_NOISE_G_BIAS_INTERCEPT` で
   -0.025→-0.032 と詰め、**全条件 centroid ≤ 2px**（収束 6）。
6. `svgDisplaceFilterMarkup` / 各 intercept 定数を export し `test/effectSvg.test.ts` で固定。

## worked example 2（mosaicLite の live プレビュー重さ・§7）
症状: mosaicLite があるとテキスト単体のシンプルなコンプでも scrub/再生の FPS が激落ち。
1. rAF / headless / `setFrame` 合成送りでの repro は全て非再現（60fps）→ **実 Chrome + 実マウスドラッグ scrub
   + CDP screencast** で再現（canvas 更新 8fps・600ms 超の停滞）。ユーザー提供の画面録画も ffmpeg
   `mpdecimate` で canvas 領域だけ切り出すと同じ低更新レートを確認（§7a）。
2. CDP Tracing で切り分け → **`MainFrame.Draw` が mosaic 有効時 60ms/回・無効時 0.29ms（208倍）**。
   `Paint`/`RasterDecoderImpl` は差なし＝ラスタ実行ではなく compositor 主描画が支配的（§7b）。
3. 第1手: `<pattern>` 内 gradient+`mix-blend-mode` → 事前計算 PNG タイル化。GPU 側（SwapBuffers/Present）は
   17〜25倍改善したが `MainFrame.Draw` は 54ms で残存（部分改善）。
4. 隔離シーン（動く背景 + backdrop-filter オーバーレイ）で A/B 実測 → 残 54ms の実体は
   **`feImage` が参照するネスト SVG 文書（PNG を敷く `<pattern>`）の毎フレーム再ラスタ**と確定。
5. `feImage`(生 PNG タイル) + **native `feTile`** に置換（§7c）→ `MainFrame.Draw` 54ms→**0.39ms**
   （ベースライン 0.29ms 同等・97%減）。視覚出力は PNG タイル版と ink 数完全一致・回帰なし。
6. `mosaicGridSnapFilter` を `test/effectSvg.test.ts` で「feTile + 生 PNG・ネスト文書/pattern なし」で固定。

## ハーネス注意（Mafter Effect）
[implementation-loop](../implementation-loop/SKILL.md) Phase 4b（Playwright 実機検証）に従う。追加で:
- 計測スクリプトは `import()` だと Zustand が別インスタンスになりがち。`window.__mafterEditorStore`
  経由で実ストアに触る（store.ts が dev で公開）。
- 空 IDB 起動が flaky なら `loadFromFs()` を明示呼び出し → `project && currentCompId` を待つ。
- 多数編集後に store が null 化したら **dev サーバを再起動**（HMR 蓄積ノイズ除去）。
- INV-1/INV-2 を守る: 経路を変えても `resolve()` は純関数のまま。raster 化は同一 `ResolvedScene` の
  別ラスタライズであり、解決値は変えない。
