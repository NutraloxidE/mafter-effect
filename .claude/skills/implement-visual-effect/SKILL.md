---
name: implement-visual-effect
description: 視覚エフェクト（displacement / noise / filter / 合成系）を新規実装・チューニング・ドリフト修正するときの計測駆動フレームワーク。Amount/Amplitude を上げると中身がずれる・歪みの強さで重心が動く・preview と export が一致しない・パラメータをいくら振っても収束しない、といった「効くが正しくない」エフェクト挙動を直すときに使う。正しい計測プロキシの選択、パラメータ vs 経路（アーキテクチャ）の分岐判定、CSS filter とラスタ経路の選択、プロシージャルノイズのゼロ平均性、残差の閉じ方を扱う。debug-visual-render-bug を土台に、エフェクト特有の罠を上乗せする。
---

# 視覚エフェクトの実装・チューニング

エフェクトは「歪みの**強さ**を変えても、コンテンツの**論理位置・重心は不変**」が原則。
強さに比例して中身がずれる／重心が動くのは、ほぼ常に **(a) 計測量を間違えている** か
**(b) レンダリング経路が座標を歪めている** か **(c) プロシージャル素材の平均が中心からずれている**。
このスキルはこの 3 つを順に潰すための判断フレームワーク。前提として
[debug-visual-render-bug](../debug-visual-render-bug/SKILL.md) の「measure-don't-theorize ループ」に従う。

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

## チェックリスト（コピーして進捗管理）
```
- [ ] 計測量を ink centroid（comp 座標）にした。host rect は併記のみ
- [ ] 強さ 5/20/50/100 をスイープし、誤差の縮み方を記録した
- [ ] パラメータで収束しない → 経路を疑った（沼回避）
- [ ] 複数経路の共通ドリフト → 共通項（CSS filter/capture 座標系）を特定
- [ ] 決定論が要る合成を raster + SVG image filter に移した
- [ ] displacement filter region = userSpaceOnUse + 明示 (x,y,w,h)
- [ ] noise を fractalNoise 化し、残差軸だけ intercept で中心化
- [ ] 1 変数ずつ・毎段再計測。centroid delta ≤ 2px で収束
- [ ] 定数/region を純関数 export し unit test で固定
- [ ] 一時 Playwright スクリプト・console.log を削除。doc/progress 更新
```

## アンチパターン
- host/container rect の不変を「解決」の根拠にする（中身は動いている）。
- 経路が原因なのに intercept/offset を延々スイープする（収束しないスイープは経路を疑え）。
- 各経路を個別パッチする（共通原因は共通項を 1 箇所直す）。
- 位置の決定性が要る合成を CSS filter/backdrop の合成器に委ねる。
- noise の平均を確認せず scale だけ調整する（平均≠0.5 なら強さ比例で必ずずれる）。
- 一時計測スクリプトや log をコミットに残す。

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

## ハーネス注意（Mafter Effect）
[mafter-effect-agent.mdc](../../../.cursor/rules/mafter-effect-agent.mdc) の Playwright 実機検証に従う。追加で:
- 計測スクリプトは `import()` だと Zustand が別インスタンスになりがち。`window.__mafterEditorStore`
  経由で実ストアに触る（store.ts が dev で公開）。
- 空 IDB 起動が flaky なら `loadFromFs()` を明示呼び出し → `project && currentCompId` を待つ。
- 多数編集後に store が null 化したら **dev サーバを再起動**（HMR 蓄積ノイズ除去）。
- INV-1/INV-2 を守る: 経路を変えても `resolve()` は純関数のまま。raster 化は同一 `ResolvedScene` の
  別ラスタライズであり、解決値は変えない。
