# 2026-7-14-JST-06-33-PM 人間からのフィードバック
発見したのだが、これの根本的な問題はLengthが長いと実体がズレる事にあり、バイアスは無くてもいい可能性がある、これが真である場合"どれだけズラして直すか"ではなく、"ピンポイントで実体のドリフトを修正"すればすべてが解決する、e2916aacf0285b0153015f1314698939a747513bからこれまでの変更をspike or failedとしてブランチを切って、その地点から、"ピンポイントで実体のドリフトを修正"する事で解決する事を試みるのはどうだろうか？


# Pixel Stretch 起点ズレ調査 — 作業ノート

対象: `pixelStretch`（Directional Line Stretch）エフェクト
症状（ユーザー報告）: エフェクト自体は大体良いが、**ストレッチが始まる場所が少しズレていて、
指定した位置より「少し奥すぎる」ところからピクセルストレッチしているように見える**。
「just の場所（＝linePos の位置）」から始まるようにしたい。

関連コード:
- 変位マップ生成: [`src/runtime/effectSvg.ts`](../../src/runtime/effectSvg.ts) `pixelStretchDisplaceMaps` / `pixelStretchPrimitives`
- EffectDef: [`src/runtime/fastEffects.ts`](../../src/runtime/fastEffects.ts) `PIXEL_STRETCH_EFFECT_DEF`
- live filter 配線: [`src/runtime/DomRenderer.ts`](../../src/runtime/DomRenderer.ts) `applyEffects` / `createSvgFilterElement`
- 設計票: [`doc/cloudplan/pixel-stretch-directional-line-stretch.md`](../../doc/cloudplan/pixel-stretch-directional-line-stretch.md)

---

## 検証スクリプト（この作業フォルダ）

| ファイル | 目的 |
|---|---|
| `measure-origin.mjs` | right 方向で length を振り、帯が引いた列(bandSrc)と seam を計測 |
| `measure-directions.mjs` | right/left/down/up 4 方向で bandSrc と seam を計測 |
| `render-annotated.mjs` | ダイヤ型ソースに right ストレッチ＋linePos の赤ガイド線を重ねて目視 |

実行方法: dev サーバ（https）を起動 → `VERIFY_PORT=<port> node measure-directions.mjs`
（列/行を色に符号化したソースを使い、出力画素をデコードして「その画素がどの列/行を引いたか」を厳密に読む。）

---

## 計測結果（実 Chrome・feDisplacementMap 実画素）

### 帯が引いたソース列/行 = `line` に厳密一致

`linePos=0.5` → `line = round(0.5 * n)` に対し、4 方向すべてで **bandSrcMinusLine = 0**。
帯内の全ピクセルは狙い通り厳密に `line`（列 or 行）を引いている。

### seam（smear が始まる位置）= `line` に厳密一致

- right: 列 `line` 以降が smear（`[line, line+len]`）、列 `< line` は原画のまま。seam = line。
- left : 列 `line` 以前が smear（`[line-len, line]`）、列 `> line` は原画のまま。seam = line。
- down/up: 同様に行 `line` で対称。

### 目視（`annotated-right.png`）

`linePos=0.45`（line=216/W=480）の赤ガイド線に、smear ブロックの左端が**ぴったり一致**する。
ガイド左はダイヤの左半分（原画）、ガイド右は一様ブロック（smear）。

---

## 結論（暫定）

**レイヤーローカル座標での pixelStretch の起点は 1px 精度で正しい。**
変位マップの数学（`ch = 0.5 + (line − i)/scale`, `scale = 2·length`, 2 段残差補正）にも、
live filter の filter region 配線（`n = round(ctx.width)` と `fxLayerW` が一致）にも
系統的なズレは無い。よって「少し奥すぎる」は **変位マップ math そのものではない**。

### 残る仮説（ユーザー確認が必要）

1. **3D/パースペクティブ変換との相互作用（最有力）**
   報告のスクショは 3D Extrude テキスト等、transform（回転・パース）を持つオブジェクト。
   CSS filter は要素の**ローカル 2D ボックスに適用された後**に 3D transform で射影される。
   パースの foreshortening で、ローカル `linePos=0.45` の線が画面上では 45% より「奥」に見える。
   → pixelStretch 単体のバグではなく、2D エフェクト×3D transform の構造的な見え方。

2. **Preview の Fit ズーム（`transform: scale(<1)`）による map の sub-pixel サンプリング**
   1px 厚のマップ軸が縮小表示されると GPU サンプリングで数 px ずれる可能性
   （[[svg-fetile-1px-source-vanishes-under-css-scale]] 近縁）。native scale の本計測では出ない。

3. **`linePos` の基準枠の認識差**
   `line = linePos * layerW`（`layerW = child.offsetWidth` = レイヤーのボックス幅）。
   オブジェクトの塗り（ダイヤ・文字）がボックス内で余白を持つ場合、ユーザーが「見た目の中央」に
   合わせた linePos と、ボックス基準の line がズレる。ただし通常これは数 px〜。

---

## 追加計測（2026-07-14・ユーザー clue 反映）

ユーザー報告: **「サンプル位置が左右なら左すぎ・上下なら上すぎ」= 常に原点(左/上)方向へ寄る**。
2D レイヤーでも起きる。ズレ量は数px〜数十px。

### ライブ CSS filter 経路（`measure-live-path.mjs`・実プレビューと同一 DOM 経路）

`transform: scale(s)`（Preview Fit ズーム相当）を 1 / 0.63 / 0.5 / 0.37 で振っても:

| scale | bandSrcMinusLine |
|---|---|
| 1.0 | 0 |
| 0.63 | 0 |
| 0.5 | 0 |
| 0.37 | +1 |

→ **ライブ経路も表示スケールも「原点方向バイアス」を再現しない**（むしろ極端縮小で +1＝右寄り）。
INV-2（raster vs live）も一致。

## 結論（改定）

**pixelStretch のコア（変位マップ math・ライブ filter 配線・Fit ズーム）は健全。**
数十px の「原点方向バイアス」は、これら isolated 経路には存在しない。

### 最有力の残仮説 = 基準枠のズレ（要実エディタ再現）

`line = round(linePos * layerW)`、`layerW = max(child.offsetWidth)`（[`DomRenderer.ts:1324-1341`](../../src/runtime/DomRenderer.ts)）。
- `linePos` は**レイヤーのボックス（offsetWidth/Height）基準**で測られる。
- ところが実際の塗り（グリフ・シェイプ・3D Extrude のビットマップ）は、**ボックス内で左/上に
  透明パディングを持って内側に描かれる**ことが多い（テキストのサイドベアリング/リーディング、
  中央寄せされた 3D ビットマップ等）。
- するとフィルタ原点(x=0,y=0)から測った `line` は、ユーザーが見ている「塗りの中の linePos」より
  **左/上（原点方向）に着地**する。左と上の両方にパディングがある → **両軸で原点方向バイアス**。
  これは 2D でも 3D でも起き、パディング量に応じて数px〜数十px。ユーザー報告と符合する。

### 実測（`measure-editor-bbox.mjs`・実エディタ / 2D text sans-serif 160px "Tp"）— 原因確定

| 軸 | box（linePos 基準枠 = offsetWidth/H） | ink（実塗り・font metrics） | パディング |
|---|---|---|---|
| 縦 | boxH = 192 | inkH = 147, inkTop = 46 | 上 46px |
| 横 | boxW = 187 | inkW = 178 | 左 side-bearing ≈ 4–5px |

`biasY_at_linePos0_5 = -23`：縦ストレッチで `line = 0.5·192 = 96` は ink 中央(≈119)より **23px 上（原点方向）**。
→ **「上下なら上すぎ・左右なら左すぎ・数十px・2D でも発生」= 全部この box-vs-ink パディングで説明できる。原因確定。**

- 縦: フォントの ascent + leading gap（`(lineHeight−fontSize)/2 + fontAscent − actualAscent`）が上パディング（数十px）。
- 横: グリフの left side-bearing（数px）。align/box 設定でさらに増える。
- solid のように塗りが box を完全に満たす型はパディング 0 → バイアス無し（control）。
- 3D Extrude は生成ビットマップが box 内で中央寄せ＋余白を持つため、パディングはさらに大きい。

### 型ごとの差（ユーザー確認「全型同じズレ?」への回答・改定）

**統一原則: `linePos` は layer box [0,W] にマップされるが、本来は ink bbox [inkLeft, inkLeft+inkW] に
マップすべき。** 任意の linePos でのバイアス:

```
bias(px) = linePos·W − (inkLeft + linePos·inkW)
         = inkLeft − linePos·(leftPad + rightPad)
```

`measure-tilted.mjs`（alpha から ink 直接計算・信頼できる）の linePos sweep:

| type | ink(left,w) | lp=0.15 | 0.25 | 0.5 | 0.75 | 0.85 |
|---|---|---|---|---|---|---|
| full solid | 0, 400 | 0 | 0 | 0 | 0 | 0 |
| **centered diamond（斜め solid）** | 30, 340 | **−21** | −15 | **0** | +15 | **+21** |
| off-center diamond | 13, 254 | +9 | +24 | +60 | +97 | +111 |
| text-like（上/左偏り） | 40, 210 | −11 | +8 | +55 | +103 | +122 |

**結論（ユーザー指摘で改定）:**
- **box を完全に満たす full solid だけが全 linePos で真に 0。**
- **斜め solid（ダイヤ）は linePos=0.5 でこそ 0 だが、中央から外すと ±21px ズレる**
  （対称 inset なので中央で 0・両端で ±inkLeft）。→ ユーザーの「斜めにすれば観測できる」は正しい。
- text / off-center / 3D Extrude は inset が非対称なので広い linePos 域でズレる（原点方向へ偏りやすい）。
- 以前の「solid はズレ 0」は **full-box solid かつ linePos=0.5 限定**の話で、一般には誤り。**訂正。**

→ 「一律オフセット」でも「型で固定」でもなく、**`linePos` を box に取っているのが唯一の原因**で、
全型・全 linePos を ink 基準に直せば一括で解消する。

### 調整レイヤー（adjustment layer）の場合 — ユーザー報告の実ケース

ユーザーの報告は**調整レイヤー上の pixelStretch**。調整レイヤーは ctx が別:

- 通常レイヤー: `ctx = { width: layerW, height: layerH }`（自分の子 box。[`DomRenderer.ts:1331-1336`](../../src/runtime/DomRenderer.ts)）
- **調整レイヤー: `ctx = { width: compW, height: compH }`**（コンプ全体。[`DomRenderer.ts:1329-1330`](../../src/runtime/DomRenderer.ts)）。
  SourceGraphic は**下の全レイヤーを合成した backdrop**（comp サイズ・`fxUseBackdropDisplace` / `compFixed` 経路）。

→ 調整レイヤーでは `line = linePos · compW`（**コンプ全体基準**、既定 1920×1080）。ところが見えている
内容（ダイヤ・文字）はコンプ内の一部に inset されている。よって同じ box-vs-ink ズレが、
**「box = コンプ全体」対「ink = backdrop の非透明合成 bbox」**として、通常レイヤーより**大きく**出る。

例（comp 1920 幅・内容が中央 600px 幅 = ink[660,1260]）:
`linePos=0.5`→ line=960=内容中央（bias 0）だが、`linePos=0.25`→ line=480、望ましい=660+0.25·600=810 → **bias 330px**。
内容がコンプをほぼ満たすなら数px〜数十px、小さいほど大きくなる。**メカニズムは通常レイヤーと同一。**

## 修正方針（要ユーザー確認・§5/INV 非該当だが ctx 拡張と INV-2 整合を伴う）

**(A) linePos を実塗り ink bbox 基準にマッピング**（＝「just の場所」）
`line = inkBox.min + linePos·inkBox.size`（軸別）。実装点:
1. `EffectRenderCtx` に `contentBox?: {x,y,w,h}` を追加（§5 SceneObject schema には非該当だが ctx interface 拡張）。
2. `DomRenderer.applyEffects` で SourceGraphic の ink bbox を計測して ctx に渡す。**レイヤー種別で ink 元が違う**:
   - **通常レイヤー**: 自分の子コンテンツ（entry.children）の非透明 bbox。
   - **調整レイヤー（ユーザー報告ケース）**: **下の合成 backdrop の非透明 bbox**（自前コンテンツが無く
     ctx=comp サイズのため。`fxUseBackdropDisplace` 経路で backdrop ラスタから測る）。
   - コスト: 毎フレーム bbox スキャンは重い → content 署名でキャッシュ。
   - **INV-2 の要**: preview（DOM）と headless export（rasterCapture / compFrameCapture）で
     **同一 contentBox** を出す必要。両経路が同じラスタから測る設計にしないと preview≠export で割れる。
     調整レイヤーは backdrop ラスタが両経路で一致することが前提（既存の backdrop displace が満たしているはず・要確認）。
3. `pixelStretchDisplaceMaps` は `contentBox` があればそれ基準で `line` を計算（無ければ従来の box 基準にフォールバック）。

> **調整レイヤーの注意**: ink 元は「下の全レイヤー合成」。複数の別内容が離れて置かれている場合、
> その union bbox 基準になる（意図と違う可能性）。UI で「ストレッチ基準＝下の内容 bbox」を明示するか、
> 基準の取り方（union / 最前面内容 / コンプ全体）を選べるようにするか要検討。

**(A-lite) text 型のみ font metrics で純粋計算**（縦の主要因＝ascent/leading は決定論的に算出可能）。
安価・INV-2 安全だが shape/3D/image には効かない（横 side-bearing や 3D 余白は別途）。

**(B) 現状維持（box 基準）** — UI に「レイヤーボックス基準」と明示。安価・決定論だが「just」感は出ない。

推奨: まず (A) の contentBox 方式（全型で効く）。ただし INV-2 整合の実装コストが要検討。
軽く済ませたいなら (A-lite) を text に先行導入。

---

## 追加調査（2026-07-14・「Length が長いと実体がズレる」仮説の検証）— コード変更なし

### 仮説
ユーザー提起: 根本原因は `lineBias` の要不要ではなく、**`length`（帯の長さ）が大きいほど、
帯が実際にサンプルする列/行（実体）が期待位置からズレていく**のではないか。真であれば
「バイアスで帳尻を合わせる」のではなく「ドリフトそのものを直す」べき。

### 計測1: 生の変位マップ math を `length` で広く振る（`measure-length-sweep2.mjs`）
`pixelStretchPrimitives` を直接呼び、実 Chrome の `feDisplacementMap` 実画素を頑健な
3byte 符号化（`R=x>>16, G=(x>>8)&255, B=x&255`、256 境界での誤読を排除済み）でデコード。
`length ∈ {20, 60, 100, 127, 128, 150, 200, 250, 300, 350, 400, 500, 700, 900, 1200}` で
帯の先頭・中央・末尾が引いたソース列 `− line` を計測:

**全 length・全計測点で `0`（誤差なし）。** stage2 補正が有効化される `length>127`（`scale1>255`）
の範囲を含め、量子化補正の残差も検出限界（1px 未満）。

> 補足: 最初の簡易スクリプト（`measure-length-sweep.mjs`, 2-flag 符号化）では `length≥350` で
> 一律 `-256` という「いかにも length 起因」に見える値が出たが、`measure-length-debug.mjs` で
> 生ピクセル（R,G,B 個別）を直接ダンプして検証した結果、**符号化スキームの閾値バグ**（256 の倍数を
> 誤デコード）と判明。実際の feDisplacementMap 出力は `538` を正しく引いていた（期待値と一致）。
> これは計測スクリプト側の誤りであり、pixelStretch 本体の挙動ではない。

### 計測2: 理論式（`measure-tilted.mjs` の bias 式）に `length` 項が無いことの再確認
既存の実測式 `bias(px) = linePos·W − (inkLeft + linePos·inkW)` は **`length` を含まない**。
ink/box の非対称パディングと `linePos` だけで決まる。よって「ズレが `length` に依存して増える」なら
この式のどこかに length 依存の残差があるはずだが、計測1で示した通り変位 math 自体に
length 依存の残差は無い。

### 結論: 仮説は棄却（否定）

**「Length が長いと実体（サンプル元）がズレる」は、pixelStretch のコア変位 math・ライブ filter
配線には存在しない。** 1px 精度で `length=20`〜`1200` まで一貫してサンプル元は `line` に厳密一致する。

ユーザーが体感した「length を伸ばすと実体がズレて見える」は、以下のいずれかで説明可能:
1. **既存確定済みの box-vs-ink バイアス**（本ファイル前半の結論）は `length` に依存しない**定数**
   だが、帯（smear 領域）自体は `length` に比例して伸びるため、**同じ px バイアスでも
   帯が長いほど「ズレた起点からズレた分だけ更に伸びた見た目」が画面上で占める面積・時間が増え、
   体感上の違和感が強くなる**（バイアスの絶対量は変わらないが、知覚的な目立ちやすさが増す）。
2. 調整レイヤー（ISSUE.md 既出）で `ctx=compサイズ` かつ `length` が大きいと、帯が
   コンテンツの ink bbox を大きく越えてコンプ全体に伸びるため、「意図した内容の外側まで
   ストレッチされている」ことが「起点がズレている」ように誤認される可能性。

→ **ピンポイントで直すべき「ドリフト」は存在しない**（計測上、変位 math に length 起因の系統誤差なし）。
根本原因は既存結論どおり **box 基準 vs ink 基準の linePos** であり、`e2916aa` 以前の
コミットへブランチを切って「実体のドリフト」を探索的に修正する作業は**行わない**（ゴールが見つからないため）。
`lineBias`（PLAN-ALT-1, default=8）は暫定近似のまま。根治する場合は ISSUE.md 案(A) の
contentBox 化（ink bbox 基準へ切替）が引き続き唯一の筋。

**Status: 本仮説は close。ブランチ作成・実装は未実施（指示通り、仮説否定のため）。**

---

## 追加計測（2026-07-14・fix/pixelstretch-length-drift ブランチ・Opus）— length ドリフト独立検証

ユーザー指摘（drift は真, bias≈len/255: 8@2000, 4@1000）を前提に、Sonnet の harness とは
**独立な計測**（符号化バイト直読 / 緩い輝度ランプ源で補間・256境界の罠を回避）で4経路を検証。

### root cause は特定できた（ユーザーの直感は正しい）
`measure-drift-encoding.mjs`: **stage1 単独の帯先頭ドリフト = len/255 に厳密一致**
（len1000→3.922, len2000→7.843）。原因は feDisplacementMap の 8bit 中立 128/255 が真の
中立 0.5=127.5/255 を表せず、`round(127.5)=128` の +0.5code バイアスが変位量 scale1=2·len に
比例（= 初期の「amount↑で実体ズレ」バグと同型）。**bias≈len/255 の正体はこれ。**

### だが stage2 が全経路で打ち消している（再現せず）
| 経路 | scale=1 | scale=0.5 |
|---|---|---|
| encoding 合成後 head | <0.2px | — |
| raster export (`measure-drift-render.mjs`) | 0 | — |
| live 通常レイヤー (`measure-drift-live.mjs`) | 0 | ±0.5px(読取量子化) |
| live 調整レイヤー backdrop (`measure-drift-backdrop.mjs`) | 0 | −1.5px **定数**(len非依存) |

`measure-stage2-dropcheck.mjs`: density 0〜1 × length 300〜2000 全てで stage2 は生成され drop されない。
→ stage1 単独（len/255）が露出する条件は現行コードに見当たらない。

### 現状の判断
出荷コードは私が測れる全経路でドリフトを打ち消しており、「直すべきドリフト」を計測上再現できない。
ユーザーの bias 値は stage1 単独と厳密一致するため、**ユーザー環境は何らかの理由で stage2 補正が
効いていない経路を通っている**と推測されるが、その経路を未特定。次アクション: ユーザーに正確な
再現条件（preview/export・レイヤー種別・オブジェクト種別・ズーム・density・スクショ or project）を確認。

---

## 解決（2026-07-14・fix/pixelstretch-length-drift・Opus）— length ドリフト根治

### 再現成功（ユーザー実シナリオ）
`measure-tilted-lengthsweep.mjs`: 45°斜めソリッド + pixelStretch(right,lp0.5) を length 0→2000 で振ると、
インク左上端 `minX/minY` が **42→34（−8px＝−len/255）**、centroid cy も −8 ドリフト（=スクショの
「左上に角が埋まる」）。raster 経路（=export）で再現。**ユーザーの観測は正しかった。**
以前の ramp 計測が 0 と出たのは帯**内**の相対位置しか見ず、帯外（レイヤーの大半）の一様シフトを
見落としていたため。

### root cause
`pixelStretchDisplaceMaps` の encode で、帯外ピクセルおよび未使用チャネル（horiz の G / vert の R）が
中立コード **128** に固定される。feDisplacementMap の真の中立は C=0.5=127.5/255 だが 8bit で表せず、
`scale·(128/255 − 0.5) = scale/510` の一様変位が**全ピクセルの両軸**にかかる。合計 (scale1+scale2)/510
= **len/255** のドリフトがレイヤー全体を原点方向へずらす。stage2 は帯内のみ補正し帯外バイアスは残存。
= 初期の「amount↑で実体ズレ」バグと同型。

### 修正（`pixelStretchPrimitives`）
変位チェーン末尾に `<feOffset dx dy>` を追加し、`neutralBiasPx = (scale1+scale2)·(128/255−0.5)` を
両軸に足して一様中立バイアスを打ち消す。帯内は一様 smear のため見た目不変。

### 検証
`measure-tilted-lengthsweep.mjs`（修正後）: minX/minY = **42 固定（全 length）**、cyDrift=0。
ドリフト消滅。cxDrift≈65 は length 非依存の正当な smear。unit test（pixelStretch 19 / effectSvg 67）PASS。
INV-2: preview(live) と export は同一 `pixelStretchPrimitives` を通るため feOffset 補正は両経路に一貫適用。

### 破棄したアプローチ
lineBias 手動ノブ（PLAN-ALT-1, default=8）は length 非依存の定数補正で、length 比例ドリフトを
根治できない近似。ブランチ `spike/pixelstretch-linebias-failed` に保全し本 fix では不採用。
