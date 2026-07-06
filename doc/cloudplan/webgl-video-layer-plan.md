# WebGL 動画レイヤー（3D 空間共有トグル）設計・実現可能性プラン

> **ステータス**: ドラフト（未承認・実装未着手）。本ファイルは `doc/mafter-effect-spec.md`（SSoT）を置き換えない。
> **⚠️ 承認必須**: 本プランは **§5 データスキーマの追加**（`SceneObject` への新フィールド）と、**§5.4b/§6.5b の「comp 共有 WebGL シーンは 1 枚」制約の緩和**を含む。CLAUDE.md 運用体制により、これらは **ユーザー承認なしに実装してはならない**。§4 では承認が必要な項目に `[要承認]` を付す。
> 作成日: 2026-07-06 / 対象ブランチ: `claude/3d-alpha-video-performance-iz1o8i`

---

## 0. TL;DR（先に結論）

- **狙いは 2 つ**、優先度が違う:
  1. **【主目的・パフォーマンス】** アルファ動画の合成を、現行の **2D canvas 上での毎フレーム `getImageData`/`putImageData`**（`videoSplitAlpha.ts`・メインスレッド CPU 合成）から、**WebGL テクスチャ + シェーダのアルファ乗算（GPU）** に移す。これはグルーピングの有無に関係なく達成できる。
  2. **【副目的・表現力】** 連続する動画/3D レイヤーを **1 つの WebGL シーンにまとめ**、per-pixel の真の深度交差（相互貫通）を可能にする。UI は各レイヤーの fold-out に **「上の 3D オブジェクトと空間を共有する」トグル**を置く。
- **設計の核**: 「comp 全体で 1 枚の WebGL canvas」（現行 spec §6.5b の制約）を緩め、**zOrder 連続する“空間共有 ON”レイヤーの run（連続区間）ごとに 1 グループ**を作る。DOM レイヤー（text/shape）や共有 OFF のレイヤーが run を断ち切る。結果として画面は **「DOM ↔ WebGL グループ ↔ DOM …」のサンドイッチ**になる。
- **v1 スコープは動画レイヤーのみ**。text/shape/HTML comp はライブ DOM のまま（現行 `dom` 経路）。これにより「エフェクト適用後にラスタライズしてテクスチャ化」問題を、動画以外には持ち込まない。
- **グルーピング判定は `resolve()`（純関数）に置く**。レンダラはその結果を受け取るだけ（INV-1/INV-2/INV-3 を守る）。preview・browser export・headless export で必ず同一グルーピングになる。
- **【重要・ラスター化フリー】** spec §5.4b の `raster3d` が警告する「代償＝静止テクスチャ化（ライブ HTML 不可）」は、**text/shape/HTML のようなライブなベクター/DOM 内容を焼き込むときの話**。**本プランは破壊的ラスター化を一切伴わない**（§2.0 で詳述）:
  - **動画は元からピクセル**。`VideoTexture` に載せても焼き込みではなく、デコード中の動画から**毎フレーム更新されるライブテクスチャ**。失うべきライブ HTML/ベクターが無いので**ラスター化の代償が発生しない**。
  - **DOM レイヤー（text/shape）は WebGL シーンに入れず DOM バンドのまま**にするので、こちらも焼き込まれない。
  - 唯一残る制約は「DOM 層 ↔ WebGL 動画は per-pixel 相互貫通できず、バンド境界のペインター順」——これは現行 spec §6.5b が既に課す制約と同じで、**新たな損失ではない**。
- **最大の未確定点**は「WebGL レイヤーに既存エフェクトがどう効くか」と「WebGL コンテキスト数の上限」。§4・§5 で掘り下げる。**素の CSS filter 系エフェクトは単独 canvas 要素にそのまま効く**。**グループ内の per-layer エフェクトも GPU シェーダで“ライブ”実装可能**（焼き込みは必須ではない・§4.2）。

---

## 1. 現状アーキテクチャ（コード根拠）

### 1.1 動画レンダリング（現行）

- **通常（不透明）動画**: 素の `<video>` を DOM の兄弟として置き、`matrix3d(worldTransform)` で配置。デコード/描画はブラウザネイティブ経路 → 安い（`DomRenderer.ts`, `videoElementSync.ts`, `playbackVideoSync.ts`）。
- **アルファ動画**: ネイティブ VP9 `alpha:keep` が Chrome の `VideoEncoder` で使えない（progress.md: `No supported VideoEncoder config for vp09.00.10.08`）ため、**split-alpha 方式**を採用:
  - color 用と grayscale-mask（alpha）用の **2 枚の `<video>`** を同位置に置く。
  - 毎フレーム 2D `<canvas>` 上で `ctx.drawImage` → `ImageData` の alpha チャンネルを手書き（`videoSplitAlpha.ts`: `drawSplitAlphaComposite`, `applyGrayscaleMaskToAlphaChannel`）。
  - color/alpha の decode を再 seek せず揃えるため `alphaVideo.playbackRate` を ±8% 微調整する **genlock**（`computeAlphaGenlockRate`/`applyAlphaGenlock`）。ドリフト実測 平均 33–50ms・最大 147ms（progress.md §16.2）。
  - **⇒ これが本プランの主対象**。アルファ動画 1 枚ごとに毎フレーム 2 回の `getImageData`/`putImageData` がメインスレッドに乗る。複数枚同時再生でコストが線形に積み上がる。

### 1.2 3D は現状すべて CSS（WebGL 未導入）

- `src/` に `three` パッケージも WebGL コンテキスト生成も**存在しない**。
- 3D は純 CSS: `DomRenderer` が root に `perspective`/`perspective-origin`、各 3D レイヤーに `matrix3d(translate(cx,cy,P)·view·world)`、root に `preserve-3d`（spec §6.5, §6.5b）。カメラ数学は `mat4.ts`（`perspective`/`lookAt` は Three.js 互換に書いてある）。
- **spec は WebGL/Three.js を将来モードとして既に設計済み**（§5.4b, §6.5b）:
  - `SceneObject.threeD?`, `threeDMode?: "auto"|"dom"|"raster3d"`, `TimelineComposition.renderer3d?: "classic"|"advanced"`（**スキーマは既存・実装は未着手**）。
  - `raster3d` = レイヤーをラスタライズし **comp 共有の WebGL シーンにテクスチャ板として投入**、per-pixel 深度交差。代償＝静止テクスチャ化（ライブ HTML 不可）。「実装は §6.5 / Phase 2 / 将来」と明記。
  - §6.5b: 「**共有 WebGL シーンは 1 枚の `<canvas>`（= z スタック上の 1 要素）**。dom 層 ↔ GL 層の交差はペインター級」。← **本プランはこの「1 枚」を「run ごとに N 枚」に緩める**。

### 1.3 エフェクト適用（現行）

- `DomRenderer.applyEffects()`（`DomRenderer.ts:1148-`）が、各オブジェクト DOM 要素へエフェクトを適用:
  - `{kind:"css"}`（blur/tint/wipe 等）→ 要素の CSS `filter:`。
  - `{kind:"svg"}`（displacement 等・§27）→ `effectSvg.ts` の `<filter>` を CSS `filter:` として適用。
  - `{kind:"raster"}`（`processPixels`）→ DOM→canvas キャプチャして JS ピクセル処理。
  - **調整レイヤー**は `backdrop-filter` で「下の層」に到達（§23.3d）。export では `foreignObject` ラスタ化で `backdrop-filter` が消えるため特殊処理。
- **重要**: 現状エフェクトは **DOM 要素に対する CSS/SVG フィルタ**が基本。動画を WebGL に移すと、この前提が動画レイヤーについて変わる（§4 で詳述）。

### 1.4 ネスト（precomp）と合成

- `DomRenderer` は parent/child で **DOM をネストしない**。`resolve()` が world transform を焼き、全オブジェクトを root の兄弟として並べる（§5.4-note）。
- **ネスト comp（precomp）**: 専用 `isolation:isolate` コンテナ div を持ち（§23.3a）、`NestedCompRasterizer`（`compFrameCapture.ts`）でオンデマンド・ラスタライズ（RAM Preview / export bake）可能。ネストカメラはコンテナ単位の `perspective`（§23.3b）。
- **エフェクト（SVG filter）**: `effectSvg.ts` が `<filter>` primitive を組む。canvas/WebGL パイプラインではない。

---

## 2. 提案設計

### 2.0 ラスター化フリーの根拠（前向き採用の理由）

> ユーザー要望「ラスター化無しで 3D がいけるならそれを前向きに検討」への直接回答。**結論: この設計はどこも破壊的ラスター化しない**。

spec §5.4b の `raster3d` は「**任意のレイヤー（text/shape/HTML 含む）**を GL シーンに入れる」汎用モードなので、ライブ HTML/ベクターを**静止テクスチャに焼き込む代償**が避けられなかった。本プランは対象を絞ることでその代償を回避する:

| レイヤー種別 | 本プランでの扱い | ラスター化するか |
|---|---|---|
| **動画（通常/アルファ）** | WebGL `VideoTexture`（GPU 側で毎フレーム更新） | **しない**。動画は元からピクセル列＝失うライブ内容が無い。テクスチャは静止ではなく**ライブ**（再生し続ける） |
| **text / shape / HTML comp** | **DOM バンドのまま**（現行 dom 経路・CSS 3D） | **しない**。GL シーンに入れないので焼き込み不要 |
| **調整レイヤー / エフェクト** | §4.2（単独=CSS ライブ / グループ=GPU シェーダでライブ） | **原則しない**（焼き込みは最終手段） |

- **「ライブテクスチャ」と「静止テクスチャ化」は別物**。`VideoTexture` は decode の進行に追随してフレームごとに GPU テクスチャを更新する。したがって動画を GL に載せても、AE の raster3d が失う「編集可能なライブ内容」に相当するものは**そもそも動画に存在しない**。むしろ現行の 2D-canvas split-alpha 合成（`getImageData`/`putImageData`）の方が CPU ラスタ往復を含んでおり、**GL 化はラスタ往復を減らす方向**。
- **唯一の割り切り**は「DOM 層 ↔ WebGL 動画層の per-pixel 相互貫通は不可（バンド境界のペインター順）」。ただしこれは §6.5b が既存 dom 経路にも課している制約と同一で、**本プランで新たに失うものではない**。
- **⇒ 前向き採用の判断**: 「ラスター化フリーで動画の 3D 空間配置＋深度交差＋GPU アルファ合成」は、**対象を動画に限定する限り成立する**。汎用 raster3d（text 等の焼き込み）は本プランのスコープ外に置き、必要になったとき別途 opt-in する。

### 2.1 レイヤーモデル（v1 = 動画のみ WebGL 化）

画面の z スタックは、zOrder 昇順に走査して次の 3 種の**バンド**に動的分割される:

```
（例）zOrder 昇順
┌─────────────────────────────┐
│ DOM バンド   : 背景 solid / text        │  ← ライブ DOM（現行 dom 経路）
├─────────────────────────────┤
│ WebGL グループ A : 通常動画 + アルファ動画  │  ← 1 canvas / 1 GL シーン（空間共有 ON 連続）
├─────────────────────────────┤
│ DOM バンド   : キャプション text / shape   │  ← ライブ DOM
├─────────────────────────────┤
│ WebGL グループ B : オーバーレイ透過動画    │  ← 別 canvas / 別 GL シーン
└─────────────────────────────┘
```

- **WebGL グループ**の生成規則（`resolve()` で確定）:
  - あるレイヤーが WebGL 対象（動画かつ 3D 化）で、**「上と空間共有」ON** かつ **直上のレイヤーも同一 WebGL グループに属する**なら、そのグループへ join。
  - そうでなければ**新しいグループを開始**。
  - DOM レイヤー・共有 OFF レイヤー・非動画レイヤーが挟まると run が切れる。
- **カメラ共有**: どのグループも comp の active camera（§6.5）を参照。view は全経路一致、各グループの GL projection は `mat4.perspective`。これで DOM cube と GL video が画面上で整合（§6.5b の原則を維持）。

### 2.2 UI — WebGL レイヤーパネル（fold-out）

- 動画レイヤーのプロパティパネルに fold-out セクション「3D / WebGL」を追加。
- トグル **「上の 3D オブジェクトと空間を共有する」**（`threeDGroupWithPrev` 相当・§5 で確定）。
  - **直上のレイヤーが WebGL 対象でないとき**はトグルを **disabled + 説明**（共有相手がいない）。
  - 並べ替え（ドラッグ）でチェーンが変わったら、トグルの実効が変わる。UI は「実効グループ境界」を可視化（例: グループを縦線でくくる）。
- 「3D レイヤーとして扱う」トグル（= 既存 `threeD`）と直交。動画を WebGL 化するには `threeD=true` かつ実効モードが GL 経路であること。

### 2.3 レンダラ側（新規 `WebglLayerRenderer`）

- **1 GL コンテキスト / N 表示 canvas** を推奨（§4.2 コンテキスト枯渇対策）:
  - 単一の `WebGLRenderer`（オフスクリーン / framebuffer）で各グループを描画 →
    グループごとの表示用 `<canvas>`（z スタック上の要素）へ `drawImage` で転送。
  - 各グループ canvas は DOM 上で通常オブジェクトと同じく `z-index`/`matrix3d` 配置。
- 動画は `THREE.VideoTexture`（通常）＋ mask 用 `VideoTexture` をシェーダでアルファ結合（split-alpha を GPU 化）。genlock は不要になる可能性が高い（両テクスチャを同一 render tick でサンプルするため）— ただし **decode タイミングのズレは残る**ので §6 で要検証。
- export（INV-2）: GL → `readPixels` でブラウザ内取り込み（spec §5.4b の既定方針どおり）。

---

## 3. 既存コンポジットでの動作（回帰マトリクス）

「一気に実装 → 既存コンポで挙動確認」の観点。**動画を含まないコンポは一切変化しないこと**が最優先の不変。

| 既存シナリオ | 期待挙動 | リスク |
|---|---|---|
| solid+text+image のみ（動画なし） | **完全無変化**（GL 経路に一切入らない） | 低（`resolve()` で GL 対象 0 → 従来経路） |
| 通常動画 1 枚（3D 化しない） | **現行の素 `<video>` 経路のまま**（GL 化は opt-in） | 低 |
| アルファ動画 1 枚（3D 化 ON） | GL 合成に切替、見た目一致・軽くなる | 中（アルファ境界のにじみ・decode ズレ） |
| アルファ動画＋通常動画（共有 ON） | 1 グループで深度交差 | 中（順序・ブレンド） |
| 動画の上に text（DOM）を重ねる | DOM サンドイッチで text が前面 | 中（z-index 境界） |
| ネスト precomp 内の動画 | precomp 側の GL 経路 or ラスタ化 | **高**（§6 未確定） |
| 調整レイヤー + 動画 | `backdrop-filter` が GL canvas に効くか | **高**（§4.1） |
| トラックマット源が動画 | マット合成が GL 経路で成立するか | **高**（§4.1） |
| export（mp4/webm/PNG 連番/bundle） | 全経路で GL readPixels 一致（INV-2） | **高**（§5） |

---

## 4. 既存エフェクトが WebGL レイヤーにどう働くか（最重要検討）

現状エフェクトは「DOM 要素への CSS/SVG フィルタ」が基本。動画を WebGL 化したときの効き方を種別ごとに整理する。

### 4.1 エフェクト種別ごとの効き方

| エフェクト種別 | **単独 WebGL レイヤー**（1 canvas / 1 動画） | **グループ内 WebGL レイヤー**（1 canvas に複数動画） |
|---|---|---|
| `{kind:"css"}`（blur/tint/wipe） | **そのまま効く**（表示 canvas 要素に CSS `filter:` を掛けられる。DOM 要素と同じ） | **効かない**（filter は canvas 全体＝グループ全体に掛かる）→ **per-layer は GPU シェーダ実装 or テクスチャ焼き込みが必要** |
| `{kind:"svg"}`（displacement 等） | canvas 要素に CSS `filter:url(#…)` を掛けられる → **原理上効くが要検証**（SVG filter が canvas ソースに対して正しく働くか） | 同上・グループ全体に掛かる問題あり |
| `{kind:"raster"}`（`processPixels`） | GL 出力を canvas キャプチャ → 既存 raster 経路に流せる（ただし GPU→CPU 往復が発生し**主目的の軽量化を相殺**しうる） | 同上 |
| **調整レイヤー**（`backdrop-filter`） | `backdrop-filter` は下層の**描画済みピクセル**に効く。GL canvas も通常の描画要素なので**下にあれば効く見込み**（要検証） | 同上・境界がグループ単位になる |
| **トラックマット**（§5.4f） | マット源/被マットのどちらかが GL の場合、合成をどこで行うか（DOM 合成か GL 内か）を決める必要 | GL 内で解決するのが自然 |
| **ブレンドモード**（§5.4d） | GL canvas 要素に CSS `mix-blend-mode` を掛けられる（単独なら OK） | グループ内の per-layer blend は GL 側で実装 |

### 4.2 設計判断（エフェクト × グルーピングのトレードオフ）

- **原則**: **単独 WebGL レイヤー（1 canvas/動画）は CSS/SVG/blend エフェクトをライブ維持できる**（canvas も 1 個の DOM 要素なので、そのまま CSS `filter:`/`mix-blend-mode` を掛けられる）。**破壊的ラスター化は不要**。
- **グルーピング（共有 ON）時**: per-layer の CSS filter は「グループ全体の canvas」に掛かってしまうため per-layer には使えない。ただし選択肢は 2 つ:
  - **(a) GPU シェーダで per-layer エフェクトを“ライブ”実装**（blur/tint 等をフラグメントシェーダで再現）。**ラスター化しない**。実装コストは上がるが、§2.0 のラスター化フリー方針と整合。
  - **(b) テクスチャ焼き込み**（最終手段・raster3d 相当）。**本プランでは避ける**。
- **v1 の割り切り案（要承認・実装簡素化のため）**: 「**エフェクト付き動画レイヤーは共有グループに join できない**（トグル自動 disabled）」。これで v1 は「(a) の GPU シェーダ実装」も「(b) 焼き込み」も**どちらも不要**になり、主目的（アルファ動画の GPU 化）＋副目的（**エフェクト無し**動画同士の深度交差）を最小実装で両立。エフェクト付き動画の深度交差（= (a) GPU シェーダ路線）は Phase 2 送り。この割り切りでも **v1 は完全にラスター化フリー**。

---

## 5. スキーマ / INV への影響 `[要承認]`

### 5.1 新規スキーマ `[要承認・§5]`

```ts
interface SceneObject {
  // 既存: threeD?, threeDMode?, ...
  threeDGroupWithPrev?: boolean;  // 提案: true = zOrder 直上の WebGL レイヤーと同一 GL シーンを共有。省略/false = 独立
}
```

- **代替案**: 新フィールドを足さず `threeDMode` の値を増やす（例 `"raster3d-shared"`）／グループ ID を持たせる、等。**フィールド追加が最小で diff が読みやすい**と考えるが、命名・意味論はユーザー確認事項。
- 直列化: `true` のときのみ書く（既存 project.json は byte 等価維持・INV-4）。

### 5.2 spec 制約の緩和 `[要承認・§6.5b]`

- 現行 §6.5b:「共有 WebGL シーンは **1 枚**の canvas」。→ **「zOrder 連続する共有 ON レイヤーの run ごとに 1 枚（=comp 内に複数枚可）」**へ緩和する追記が必要。
- カメラ共有原則（§6.5b「dom/raster3d は同一カメラ」）は**維持**（全グループが active camera を参照）。

### 5.3 INV 影響（**追加・変更なしを目標**）

| INV | 影響 | 対応 |
|---|---|---|
| INV-1（resolve 純関数） | グルーピング判定を resolve に入れる。乱数/DOM 不使用を厳守 | グルーピングは zOrder + フラグの純計算 |
| INV-2（preview=export 一致） | GL ラスタ忠実度差は許容だが**グルーピング結果は完全一致必須** | グルーピングを resolve 出力に焼く。レンダラは従うだけ |
| INV-3（型はレンダラ非依存） | `ResolvedScene` に「グループ割当」を焼くと GL 前提が漏れないか | グループ割当は「連続 run の区切り」情報として中立に持つ（GL 固有語を型に入れない） |
| INV-4（FS パス等価） | 新フィールドは optional・省略時無出力 | 既存 project.json 不変 |
| INV-5/INV-6 | 影響なし | — |

> **INV-3 の要注意点**: `ResolvedObject` に「WebGL グループ番号」を焼くと、型がレンダラ（GL）を知ってしまう懸念。中立化のため「**描画バッチ境界**（連続 run の group index）」という抽象で持ち、dom レンダラも同じ境界情報を無害に無視できる形にする。← **設計レビュー項目**。

---

## 6. 懸念点・未確定点（Open Questions）

1. **[perf 本丸] GPU 化で本当に軽くなるか未計測**。`getImageData`/`putImageData` 撤廃で軽くなる見込みだが、**GL コンテキスト生成コスト・VideoTexture アップロード帯域**が新たに乗る。→ **Phase 0 で単発プロトタイプ計測**（アルファ動画 1 枚: 現行 canvas vs WebGL の frame time）を先に取るべき。**プロトタイプ計測を実装前ゲートにするか**はユーザー判断。
2. **WebGL コンテキスト枯渇**。ブラウザ上限 ~16 contexts。「1 動画 = 1 グループ = 1 context」だと簡単に超える。→ **§2.3 の「1 GL コンテキスト / N 表示 canvas」方式**で回避する前提。実装難度は上がる。
3. **color/alpha decode ズレ**。GL で同一 tick サンプルにしても、2 本の `<video>` の decode 位置は独立。genlock 不要になるか、別方式（`requestVideoFrameCallback` 同期）が要るか **要実測**。
4. **エフェクト付き動画のグループ join 可否**（§4.2）。v1 は「不可（自動 disabled）」で割り切る案。ユーザー承認事項。
5. **調整レイヤー `backdrop-filter` / トラックマット / ブレンド**が GL canvas をまたいで正しく効くか（§4.1 の「要検証」群）。export 経路（foreignObject ラスタで backdrop-filter 消滅の既知問題）との相互作用も。
6. **ネスト precomp 内の動画**。precomp 内で GL 経路に入るか、precomp を丸ごとラスタ化するか。`NestedCompRasterizer` との整合。**v1 スコープ外にするか要確認**。
7. **export 決定論（INV-2）**。GL `readPixels` の色・アルファが CSS/canvas 経路と小数点いくつまで一致すべきか。既存 verify の許容差に合わせる。
8. **並べ替え時のトグル意味変化の UX**。実効グループ境界の可視化方法。
9. **依存追加**: `three` を入れるか、素の WebGL で最小実装するか。`mat4.ts` が既に Three.js 互換なので `three` 採用が自然だが、バンドルサイズ・`public/player.js` 再ビルド（bundle export）への影響を確認。

---

## 7. 実装フェーズ（「一気に実装」の内訳）

> ユーザー要望は「一気に実装 → 既存コンポで挙動確認 → ダメなら revert」。以下は一気通貫で入れる想定の順序。**§5 承認後**に着手。

- **Phase 0（推奨・任意）**: 単発 WebGL プロトタイプでアルファ動画 1 枚を GPU 合成し frame time 計測。実装続行の go/no-go。
- **Phase 1**: `resolve()` にグルーピング判定を追加（`threeDGroupWithPrev` → 連続 run の group 境界を `ResolvedScene` に焼く）。純関数テストで固定。**この段階ではレンダラ未変更＝挙動不変**。
- **Phase 2**: `WebglLayerRenderer`（1 GL コンテキスト / N 表示 canvas）を新規追加。単独 WebGL 動画レイヤーの preview を成立させる（アルファ動画の split-alpha を GPU 化）。
- **Phase 3**: グループ（共有 ON 連続）で複数動画を 1 GL シーンに投入・深度交差。カメラ共有。
- **Phase 4**: UI（fold-out トグル＋グループ境界可視化）。
- **Phase 5**: export 全経路（mp4/webm/PNG 連番/bundle）で GL readPixels 配線・INV-2 verify。**`public/player.js` 再ビルド**（bundle export が GL 経路に触れるため・CLAUDE.md 必須）。
- **Phase 6**: 既存コンポ回帰（§3 マトリクス）・progress.md 更新。

---

## 8. 検証計画

- **INV-2 全経路**（implementation-loop / add-layer-component-type の §E 準拠）:
  - preview / browser export（mp4・webm・PNG 連番）/ `compFrameCapture`（ネスト・調整 raster）/ Web bundle player。
  - **新型 verify だけ緑にして終わらない**。既存 `verify-*-export*.mjs`・blend/調整/displacement・solid+text+image のみコンプ・bundle bake 件数・`npm test` の export/raster/bundle 関連を**無回帰確認**。
- **新規 verify（想定）**:
  - `verify-webgl-alpha-video.mjs`: アルファ動画 GPU 合成が現行 canvas 版と画素一致（許容差内）。
  - `verify-webgl-group-depth.mjs`: 共有 ON 2 動画の深度交差。
  - `verify-webgl-noop-regression.mjs`: 動画なしコンポが GL 経路に一切入らない（frame 出力 byte 一致）。
- **計測**（perf 主目的の証明）: アルファ動画 N 枚で現行 vs GL の平均 frame time を実機比較。

---

## 9. Revert / ブランチ戦略

- 現行ブランチ `claude/3d-alpha-video-performance-iz1o8i` が実験隔離そのもの。**新規ブランチ不要**。
- **実装前にベースライン固定**: `git commit --allow-empty -m "baseline: before webgl-video-layer impl"`（またはタグ `baseline-webgl-video`）。
- 失敗時は `git reset --hard <baseline>`（未 push なら綺麗に消える）。push 済みなら `--force-with-lease`。
- 段階コミット（Phase 単位）にしておけば、部分採用（例: Phase 1-2 の GPU 化だけ残しグルーピングは捨てる）も選べる。

---

## 10. 次アクション（ユーザー確認事項）

1. **§5.1 の新フィールド `threeDGroupWithPrev`（or 代替案）を承認するか**。
2. **§5.2 の「WebGL シーン 1 枚 → run ごと N 枚」緩和を spec に追記して良いか**。
3. **§4.2 の割り切り（エフェクト付き動画はグループ join 不可 = v1）で良いか**。
4. **Phase 0 プロトタイプ計測を実装前ゲートにするか**、それとも計測せず「一気に実装」まで進めるか。
5. **`three` 依存を入れて良いか**（bundle/player 再ビルド影響あり）。
6. **ネスト precomp 内動画（§6-6）を v1 スコープに含めるか**。

> **採用済み方針（ユーザー指示 2026-07-06）**: 「**ラスター化フリーで進める**」。動画は `VideoTexture`（ライブ）、DOM は DOM バンド維持、エフェクトは焼き込みでなく単独=CSS / グループ=GPU シェーダで対応。破壊的な静止テクスチャ化（汎用 raster3d）は v1 スコープ外。詳細は §2.0。
