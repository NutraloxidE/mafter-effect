# 3D テキスト拡張（非破壊・ライブ・shape 再利用）設計プラン

> **ステータス**: ドラフト（2026-07-13・Claude Code）。本ファイルは spec（SSoT）を置き換えない。
> **§5 スキーマ追加を含むため、実装着手前に §9 の承認事項をユーザーと確定してから spec → 実装の順で進める**（CLAUDE.md 運用体制の必須手順）。
> 参照ブランチ: `claude/3d-text-extension-k040dx`。

---

## 0. TL;DR

**目的**: 既存の `text` レイヤーを**非破壊**に拡張し、Illustrator の 3D 効果（押し出し・ベベル・ねじり・曲げ）相当の表現を**ライブ（テキスト編集可能なまま・ベイク不要・リアルタイムプレビュー）**で実現する。厚み・変形・グラデーションはすべて**キーフレーム可能**。3D ⇄ 通常テキストは**1 トグルで往復**でき、OFF に戻せば既存描画と byte 等価。押し出し機構は **`OutlineProvider` 抽象で汎用化**し、`shape`（rect/ellipse/path/merge）にも同じ props 群を後付けできる。

**アーキテクチャの核（3 案比較 → 案 B 推奨・§3）**:

- 押し出し・ねじりの実体は **per-layer の素の WebGL canvas**（three.js 不使用）。レイヤー div の「座席」に canvas が座るだけで、`matrix3d`・blendMode・effects・トラックマット・export のレイヤー列挙は**一切触らない** — [webgl-video-layer-plan v2](webgl-video-layer-plan.md) の確立原則「WebGL はシーンではなく **canvas のピクセルを作る手段**」を踏襲。
- アウトラインは既存資産をそのまま使う: text は `opentype.js`（既依存・[fontOutlineCache.ts](../../src/runtime/fontOutlineCache.ts)）のグリフ path、shape は `vertices`/`rings`/`mergeInputs` の解決結果（[shapePath.ts](../../src/runtime/shapePath.ts)）。
- ジオメトリは**単位厚で 1 回生成してキャッシュ**し、厚み＝z スケール、ねじり/曲げ/テーパー＝**頂点シェーダの純関数**で毎フレーム無コスト変形 → 60fps ライブ + キーフレーム対応。
- グラデーションは再利用可能な **`GradientFill` スキーマ**（linear / radial / conic / depth、stop ごとに色・位置がキーフレーム可能）として定義し、3D の面（前面/側面/ベベル/背面）ごとに割り当てる。将来 2D の shape/text 塗りにも同スキーマを流用できる形にする。

---

## 1. 要求 → 設計要件マッピング

| ユーザー要求 | 設計要件 | 本プランの対応 |
|---|---|---|
| 現状テキストの**非破壊**拡張 | 既存 props（text/font/size/color/…）は一切変更せず additive-optional で追加。3D OFF・キー欠落の旧プロジェクトは byte 等価（INV-4） | §4 スキーマ設計原則 |
| **3D 化**（分厚さ＝押し出し） | 押し出し（depth）+ ベベル。フォントアウトライン → 実メッシュ | §5.2 ジオメトリ |
| **ライブ性維持** | テキストは編集可能なまま（ベイク・ラスタ化ステップなし）。scrub/再生でリアルタイム更新 | §3 案 B + §5.3 シェーダ変形 |
| **Illustrator 的表現**（ねじ曲げ等） | twist / bend(arc) / taper をキーフレーム可能なパラメータで | §4.2 / §5.3 |
| **分厚さ変更・キーフレーム可能** | depth ほか全変形パラメータを `AnimatedProp<number>`（flat param → 既存 Timeline KF 行が自動で出る） | §4.2 |
| **様々な形式のグラデーション** | `GradientFill`（linear/radial/conic/depth）・stop 色/位置アニメート可 | §4.3 |
| **3D ⇄ 通常テキスト切替** | `geomEnabled: boolean` トグル。OFF = 既存 2D 描画経路をそのまま通る | §4.1 |
| **shape にも組み込める再利用性** | `OutlineProvider` 抽象 + 共通 props 群（text/shape の ComponentDef が同じ定数を共有） | §5.1 / Phase 4 |

---

## 2. 現状調査サマリ（コード根拠）

### 2.1 テキストのアウトラインは既に取れる

- 厳密モード（§26.4.1）は **`opentype.js` でグリフを SVG path 化**して描画済み（[textRender.ts:220](../../src/runtime/textRender.ts#L220) `font.getPath(g.char, x, baseline, size)`）。**押し出しの元データ（2D 輪郭）はこの経路がそのまま供給できる**。
- レイアウト（advance/折返し/align/tracking/leading）は決定論の [textLayout.ts](../../src/runtime/textLayout.ts) に集約済み（INV-1 適合）。グリフごとの `(x, y, baseline)` が取れるため、**per-glyph のメッシュ配置**が可能。
- フォントは [fontOutlineCache.ts](../../src/runtime/fontOutlineCache.ts)（asset フォント）+ ビルトイン Noto（`public/fonts/*.ttf`・§26.3.2）。**system フォントはアウトライン不可**（§26.4.1 と同じ制約が 3D にも掛かる）。

### 2.2 shape のアウトラインも解決済み値で取れる

- `kind="path"` は `vertices`（ベジェ tangent 付き）、`kind="merge"`/Bake は `rings`（複数リング・穴対応）、rect/ellipse はパラメトリックに輪郭化できる（§5.5c–e）。Boolean 合成（`shapePathBoolean.ts`）はポリゴン化まで済ませている。**「閉じた輪郭のリスト」という共通形に正規化すれば text と同じ押し出し器に流せる**。

### 2.3 3D・カメラ基盤は dom 経路が本番稼働、raster3d は未実装

- `threeD?: boolean`（§5.4b）+ カメラモデル（§6.5b・view/projection の式が確定、[mat4.ts](../../src/runtime/mat4.ts) に lookAt/perspective あり）。DomRenderer は 3D 層のみ per-object でカメラ view を焼く方式（[DomRenderer.ts:1049](../../src/runtime/DomRenderer.ts#L1049)）。
- `raster3d`（共有 WebGL シーン・three.js）は **spec 予約のみで未実装**。§5.4b は「3D 層の export は GL ラスタ → readPixels」と既に宣言している。

### 2.4 WebGL の使い方は v1 失敗の教訓が確定している（必読: [webgl-video-layer-plan.md](webgl-video-layer-plan.md) §1）

- **three.js は不採用**（player.js +510KB・依存肥大）。素の WebGL + 小さなシェーダで per-layer canvas。
- **canvas はレイヤー div 内の 1 DOM 要素**として座らせる（CSS blend/filter/matte/カメラ配線を壊さない）。
- 技術的罠（UV 反転・未バインド sampler・`preserveDrawingBuffer: true`・export 前の再描画・`playerBuildFreshness` の緑を信用せず必ず `npm run build:player`・perf 計測は headed 実 Chrome + 実ドラッグ + CDP screencast）を新実装でも全部踏襲する。

### 2.5 「AnimatedProp を内包する構造化 prop」の前例がある

- `ShapeVertex.pos: AnimatedProp<Vec3>` は ParamDescriptor に載せず **Inspector 専用フィールドで編集**する前例（§5.5c）。グラデーション stop の色/位置アニメートは同じパターンで実現できる。

---

## 3. アーキテクチャ選定（3 案比較）

| | **案 A: CSS スライス積層**（preserve-3d で輪郭 SVG を translateZ 多層コピー） | **案 B: per-layer 素 WebGL + 実押し出しメッシュ（推奨）** | 案 C: three.js 共有シーン（raster3d 全面実装） |
|---|---|---|---|
| 厚みの見た目 | ✗ 側面が縞状（スライス数を増やすと DOM 爆発）。ベベル不可 | ✅ 実メッシュ（側壁 + ベベル + 深度バッファで自己遮蔽正しい） | ✅ 実メッシュ |
| ねじり/曲げ | △ per-glyph 剛体変換まで（輪郭自体は曲がらない） | ✅ 頂点シェーダで滑らかに連続変形 | ✅ |
| グラデーション | △ SVG gradient（面別・深度方向は不可） | ✅ フラグメントシェーダで任意（linear/radial/conic/depth） | ✅ |
| ライブ性 | ✅ DOM のまま | ✅ 毎フレーム GL 描画（ベイク無し・テキストは編集可能なまま） | ✅ |
| 既存配線への影響 | 中（レイヤー内 DOM 構造が激変・export foreignObject 経路が多層 3D を撮れるか未知数） | **小**（canvas 1 要素が座るだけ。blend/effects/matte/export 列挙は不変） | **大**（共有シーン = z スタック 1 要素、レイヤー意味論が変わる。v1 失敗の再来リスク） |
| 依存追加 | なし | earcut（三角形分割・~2KB・MIT）のみ | three.js（+510KB） |
| export (INV-2) | 未知数（foreignObject の preserve-3d 多層は capture 忠実度に既知の癖） | ✅ `preserveDrawingBuffer` + 既存 canvas インライン化経路（webgl-video 実装で実証済み） | ✅ だが全面新規 |
| リスク | 品質上限が低く要求（ねじ曲げ・厚み）を満たせない | 中（ジオメトリ生成は新規だが局所的） | 高（v1 post-mortem の轍） |

**推奨 = 案 B**。要求品質（Illustrator 相当のねじり・厚み・面別グラデ）を満たす最小構成で、リポジトリで実証済みの「per-layer GL canvas」原則に乗る。案 C（共有シーン・層間の真の深度交差）は将来 §5.4b raster3d を実装する際に、本プランのメッシュ生成器（§5.2）を**そのまま入力として再利用**できるため、案 B は C への布石にもなる。

---

## 4. データモデル（§5 追加案 — **要ユーザー確認・§9**）

### 4.1 設計原則と 3D トグル

- **additive-optional**: 追加キーはすべて省略可。省略＝現行挙動・現行直列化（byte 等価・INV-4）。
- **フラットな param キー**（`geom*` prefix）として text / shape の ComponentDef に追加する。単一 `AnimatedProp` のスカラー/色/vec3 に収まるものは ParamDescriptor に載せ、**既存 Timeline KF 行・Inspector PropRow・undo 配線をゼロ改修で再利用**する（§26.2 と同じ考え方）。構造化が必要なグラデーションのみ §2.5 の前例（Inspector 専用編集）に従う。
- **トグル**: `geomEnabled`（bool・**非アニメータブル**）。`false`/欠落 → レンダラは既存 2D 経路（draft DOM / precise SVG）を**そのまま**通る。`true` → GL 押し出し経路。トグルはデータを消さない（3D パラメータ・KF は保持されたまま眠る）＝非破壊往復。
  - 非アニメータブルにする理由: フレーム間で描画トポロジー（DOM 構造）が切り替わるとキャッシュ・export 経路の分岐が毎フレーム変わり、片経路回帰（CLAUDE.md「export 正常化」節）の温床になるため。AE の 3D レイヤースイッチも非 KF。

### 4.2 共通 3D ジオメトリ props（`GEOM3D_PARAM_DESCRIPTORS` として単一定数化・text/shape で共有）

```ts
// text / shape 両 ComponentDef の params 末尾に concat する共有定数（builtinComponents.ts）
// kind/animatable は ParamDescriptor（§5.5）の既存語彙のみで表現できる
{ key: "geomEnabled",       kind: "bool",   default: false, animatable: false }, // 3D ⇄ 2D トグル
{ key: "geomDepth",         kind: "scalar", default: 50,    animatable: true, min: 0 },   // 押し出し厚 px
{ key: "geomBevelSize",     kind: "scalar", default: 0,     animatable: true, min: 0 },   // ベベル幅 px
{ key: "geomBevelSegments", kind: "scalar", default: 2,     animatable: false, min: 1, max: 8, step: 1 },
{ key: "geomCurveQuality",  kind: "enum",   default: "medium", animatable: false, options: ["low","medium","high"] }, // 輪郭ベジェ分割数
// —— 変形（すべて頂点シェーダの純関数・キーフレーム可能）——
{ key: "geomTwist",         kind: "scalar", default: 0, animatable: true },  // deg。レイアウト x 軸に沿って全幅で twist° ねじる
{ key: "geomBend",          kind: "scalar", default: 0, animatable: true },  // deg。ベースラインを円弧に曲げる（Illustrator の Arc 相当。360 で全周）
{ key: "geomTaper",         kind: "scalar", default: 0, animatable: true, min: -1, max: 1 }, // 奥に向かう縮小/拡大
// —— シェーディング ——
{ key: "geomShading",       kind: "enum",   default: "lambert", animatable: false, options: ["none","lambert"] },
{ key: "geomLightDir",      kind: "vec3",   default: { x: -0.5, y: -0.7, z: -0.5 }, animatable: true },
{ key: "geomAmbient",       kind: "scalar", default: 0.35, animatable: true, min: 0, max: 1 },
```

- 面の**基本色は既存 prop を継承**する（text = `color`/`strokeColor`、shape = `fill`）。3D ON にしただけで前面＝従来の塗り、側面＝lambert 陰影付きの同色になり、**色の二重管理をしない**（非破壊の要）。
- 単位: `geomDepth`/`geomBevelSize` は px（レイヤーローカル・INV-5 と無関係な空間量）。`geomTwist`/`geomBend` は degrees（Transform の rotation と同じ流儀）。

### 4.3 `GradientFill`（再利用可能スキーマ・構造化 prop）

```ts
// §5 追加候補。3D 面の塗りが初出だが、将来 2D の shape.fill / text.color の
// 上位互換塗りとしても使える中立スキーマとして定義する（レンダラ非依存・INV-3）
type GradientKind = "linear" | "radial" | "conic" | "depth"; // depth = 押し出し z 方向（3D 専用）

interface GradientStop {
  id: string;                       // ULID（INV-6）。順序は offset 昇順に描画（id 昇順ソート対象外・頂点前例と同じ）
  offset: AnimatedProp<number>;     // 0..1
  color:  AnimatedProp<RGBA>;
}

interface GradientFill {
  kind: GradientKind;
  angle:  AnimatedProp<number>;     // deg（linear/conic）
  center: AnimatedProp<Vec3>;       // 0..1 正規化（radial/conic。z 未使用）
  stops:  GradientStop[];           // 2 個以上
}

// 面ごとの塗り上書き（構造化 prop・ParamDescriptor 非掲載 = ShapeVertex 前例・§5.5c）
// 欠落した面は §4.2 の継承色（既存 color/fill + lambert）で塗る
interface Geom3DFaces {
  front?: GradientFill;   // RGBA 単色は stops 2 個同色で表現できるため union は設けない（正準形を 1 つに保つ）
  side?:  GradientFill;
  bevel?: GradientFill;
  back?:  GradientFill;
}
// Component.props.geomFaces?: Geom3DFaces
```

- **キーフレーム**: `offset`/`color`/`angle`/`center` が `AnimatedProp` なので、グラデーションの色・位置・角度は補間アニメート可能（stop の**本数**はトポロジーなので非アニメ。AE のグラデーションと同制約）。
- **直列化**: `geomFaces` は面キーが 1 つでも存在するときのみ書く。stop は配列順を保存（正準化でソートしない — 頂点と同じ「順序が意味を持つ」型）。

### 4.4 スキーマに**入れない**もの（明示的非目標）

- `SceneObject` 側の変更: **ゼロ**。`threeD`/`threeDMode`/camera（§5.4b/§6.5b）は既存のまま使う。
- パーレイヤー光源レイヤー（light component）・DoF・環境マップ・影: 将来（§16 系）。`geomShading` の固定 lambert が v1 の上限。
- パステキスト（テキストをパスに沿わせる）: `geomBend` の円弧が v1 の代替。任意パス追従は将来。

---

## 5. レンダリング設計

### 5.1 `OutlineProvider` 抽象（text/shape 再利用の要）

```ts
// src/runtime/geom3d/outlineProvider.ts（新規・純関数群）
// 「閉じた輪郭リング列 + 配置」の共通形に正規化する。これが再利用境界。
interface OutlineGlyph {
  rings: Vec2[][];        // flatten 済みポリゴンリング（外周 CCW / 穴 CW）。geomCurveQuality で分割数決定
  offset: Vec2;           // レイアウト位置（text: グリフ原点 / shape: 常に 0,0）
  layoutU: number;        // 0..1 レイアウト横位置（twist/bend の変形パラメータ座標）
}
// text:  textLayout + fontOutlineCache（opentype Path → rings）→ OutlineGlyph[]（per-glyph）
// shape: buildShapePathD 相当の頂点/リング解決値 → OutlineGlyph 1 個（or merge 結果の複数リング）
```

- ベジェ → ポリゴン分割は `shapePathBoolean.ts` の flatten と同一ロジックを共有化する（既に実装・テスト済みのため）。
- **text の変形は per-glyph 座標（`layoutU`）で連続化**する: twist/bend は「行全幅にわたる変形場」であり、グリフ単位の剛体変換ではなく**頂点ごと**に評価する（Illustrator のワープと同じ見え方）。

### 5.2 メッシュ生成（キャッシュされる重い部分）

- リングを **earcut**（新規依存・~2KB・**要承認 §9**）で三角形分割 → 前面/背面キャップ。側壁はリングのエッジから quad 帯を生成。ベベルは輪郭法線方向オフセット × `geomBevelSegments` 段。
- **単位厚（z ∈ [0,1]）で生成**し、頂点属性に `(pos.xy, zNorm, faceGroup, layoutU, bevelOffset.xy)` を焼く。キャッシュキー = `(font, text 内容, size, tracking…レイアウト入力, bevelSize, bevelSegments, curveQuality)` の決定論ハッシュ。**`geomDepth`/`geomTwist`/`geomBend`/`geomTaper`/色/光はキーに含めない**（下記シェーダ処理のため）→ タイプ中以外は再生成が起きず、KF アニメはキャッシュヒットし続ける。

### 5.3 毎フレーム（uniform だけで完結する軽い部分・すべて resolved 値の純関数）

- 頂点シェーダ: `z = zNorm * depth + bevelOffset` → taper(layoutU) → twist(layoutU) 回転 → bend 円弧写像 → `projection · view · world · local`。`world` は `ResolvedObject.worldTransform`、`view`/`projection` は §6.5b の確定式（[mat4.ts](../../src/runtime/mat4.ts) を CPU 側で合成して 1 uniform に）。
- フラグメント: `faceGroup` で `geomFaces` の GradientFill を選択 → kind 別に UV/オブジェクト空間で評価（stops は昇順 offset の 1D LUT テクスチャ or ≤8 stop の uniform 配列）→ lambert（`geomShading`）を乗算。
- **カメラ整合**: `threeD=true` なら `resolve()` が選んだ active camera（§6.5）の view/projection を使う。**canvas の DOM 座席は full-comp サイズ・カメラ免除（2D 扱い）**とし、カメラは GL 内でのみ適用 — CSS 側と二重適用しない（v1 失敗 §1.1-3 の教訓を構造で回避）。`threeD` 欠落/false のときは**固定の既定パースペクティブ**（AE 既定カメラ相当 `zoom=1158` 基準）で正面から描く: カメラを置かなくても Transform の rotation で立体感が出る（Illustrator 的な使い方）。
- **draft 降格**: §26.3 の編集中フォールバックを踏襲 — テキスト入力・パラメータドラッグ中は 2D draft へ自動降格し blur で GL に戻す（メッシュ再生成のタイプ毎連打を避ける）。

### 5.4 フォント制約とフォールバック

- 3D 化はアウトラインが取れるフォント（asset フォント / ビルトイン Noto）が前提。**system フォントで `geomEnabled=true` の場合は 2D 描画のまま + Inspector に警告**（§26.4.1 の precise フォールバックと同じ UX 文法）。無音で違う見た目にしない。

---

## 6. Export / INV 整合（CLAUDE.md「export 正常化」節 遵守）

| INV | 影響評価 |
|---|---|
| **INV-1** | メッシュ生成・変形・グラデーション・陰影はすべて resolved 値の純関数。`Math.random`/`Date.now` 不使用。キャッシュは決定論キー。`resolve()` 自体は props を解くだけで**変更なし** |
| **INV-2** | preview / mp4 / webm / PNG 連番 / bundle が**同一の GL 描画関数**でピクセルを作る。canvas は `preserveDrawingBuffer: true` で既存の canvas インライン化 export 経路（webgl-video で実証済み）に乗る。`compFrameCapture`（ネスト precomp）も canvas を含む DOM を撮るだけ |
| **INV-3** | `ResolvedScene` は解決済み数値のみ。GL 実装詳細（シェーダ・キャッシュ）はレンダラ層に閉じる |
| **INV-4** | 追加キーは全部 optional・既定値は直列化時 strip。3D 未使用プロジェクトは byte 等価 |
| **INV-5** | 時間パラメータなし（空間量のみ）。フレーム依存はすべて既存 `AnimatedProp` 経由 |
| **INV-6** | `GradientStop.id` は ULID。面/stop の参照は id |

- **共有パイプラインへの変更は型別オプトインで閉じる**: 分岐条件は「`c.type ∈ {text, shape}` かつ `geomEnabled===true`」のみ。false の場合は既存コードパスに 1 行も差分が出ない構造にする（rasterCapture / exporter / DomRenderer の一律挙動変更をしない）。
- **既存 export の回帰ゲート**（必須）: 既存 `verify-*-export*.mjs`・blend/調整/fast displacement・solid+text+image のみコンプ・bundle bake 件数・`npm test` の export/raster/bundle 系を無回帰確認。3D 用 verify の追加は既存シナリオの PASS を**置き換えない**。
- **bundle player**: ランタイム（`src/runtime/geom3d/*` を DomRenderer が import）に触るため、**`npm run build:player` 必須**。three.js を入れないため player.js サイズ増は最小（earcut ~2KB + シェーダ文字列）。
- **exportStrategy 既定**: `text`/`shape` は現行どおり `live`（§5.5）。GL canvas はブラウザでライブ実行可能なので bake 不要。

---

## 7. UI 設計（Phase 対応）

- **Inspector**: text / shape セクションに **"3D" フォールドアウト**を追加。`geomEnabled` トグル → ON で Depth/Bevel/Twist/Bend/Taper/Shading 行（既存 PropRow・ScrubNumber・ストップウォッチをそのまま使用 = flat param の配当）。
- **グラデーションエディタ**（Phase 3・新規コンポーネント）: 面（Front/Side/Bevel/Back）タブ + stop バー（追加/削除/ドラッグ）+ 既存カラーピッカー。stop の offset/color の KF は ShapeVertex と同じ Inspector 専用ストップウォッチ配線。
- **Timeline**: flat param（§4.2）は ParamDescriptor 登録だけで KF 行が自動で出る（§26.2 の機構）。`geomFaces` 内の AnimatedProp は Phase 3 で頂点 KF と同じ扱い。
- **ビューポートギズモ**（depth ドラッグ等）: v1 スコープ外（Inspector 数値のみ）。

---

## 8. Phase 分解

| Phase | 内容 | 完了条件（概要） |
|---|---|---|
| **P0** スパイク | earcut + 単位厚押し出し + per-layer GL canvas の使い捨て検証。**実 Chrome + 実ドラッグ + CDP screencast** で日本語 20 文字・depth/twist アニメの scrub fps を実測（progress.md 2026-07-12 の計測手法を踏襲） | 60fps 近傍で回ること・罠（UV 反転/preserveDrawingBuffer/export 再描画）の再確認 |
| **P1** 押し出しコア | §5.1–5.2 + `geomEnabled`/`geomDepth`/`geomBevel*`/`geomShading`/継承色。トグル往復・export parity（mp4/webm/PNG/bundle） | 3D ⇄ 2D 往復で byte 等価・INV-2 verify 緑・既存 export 回帰ゲート緑 |
| **P2** 変形 | `geomTwist`/`geomBend`/`geomTaper`（頂点シェーダ）+ KF | 変形 KF アニメが preview≡export・キャッシュ再生成ゼロ（uniform のみ）を実測 |
| **P3** グラデーション | `GradientFill`/`geomFaces` スキーマ + エディタ UI + stop KF | 4 種 kind × 面別割当が preview≡export |
| **P4** shape 統合 | `OutlineProvider` の shape 実装（rect/ellipse/path/merge/rings）+ shape ComponentDef へ同 param 群 concat | 任意 SVG シェイプ（merge 結果含む）が同じ 3D パラメータで押し出せる |
| **P5** 将来 | `GradientFill` の 2D 塗り流用（shape.fill / text.color 上位互換）、raster3d 共有シーンへのメッシュ供給、light/DoF | — |

各 Phase は [implementation-loop](../../.claude/skills/implementation-loop/SKILL.md) に従い spec 更新 → 実装 → 実機 verify → progress.md 記録の順。P1 以降は [add-layer-component-type](../../.claude/skills/add-layer-component-type/SKILL.md) の配線チェックリスト（bake 判定・キャッシュ・タイムライン・直列化）を通す。

---

## 9. §5 / INV への影響サマリ（**実装前にユーザー承認が必要な項目**）

| # | 項目 | 種別 | 推奨 |
|---|---|---|---|
| 1 | text/shape component への `geom*` flat params 追加（§4.2） | **§5 スキーマ追加** | 承認を求める（additive-optional・INV-4 維持） |
| 2 | `GradientFill`/`GradientStop`/`Geom3DFaces` 型の新設（§4.3） | **§5 スキーマ追加** | 承認を求める（将来 2D 塗りにも流用できる中立形） |
| 3 | `project.json` 直列化: `geomFaces`/stops の「配列順保存・既定値 strip」規則 | **直列化規則追加** | 承認を求める（ShapeVertex と同規則） |
| 4 | 新規依存 `earcut`（MIT・~2KB） | 依存追加 | 承認を求める（three.js 不採用の代償として最小） |
| 5 | INV-1〜6 の**変更・緩和**: なし | — | 不要（既存 INV の枠内に収まる設計） |

---

## 10. 検証計画

- **純関数テスト（vitest）**: 輪郭 flatten の決定論、押し出しトポロジー（リング n 個 → 面数の閉式）、twist/bend/taper の CPU リファレンス実装 vs シェーダ式の一致（数式レベル）、GradientFill 補間、直列化 round-trip byte 等価（3D OFF 旧プロジェクト / ON 新規）。
- **実機 verify（Playwright・使い捨て + 恒久 `verify-geom3d-*.mjs`）**:
  - 押し出しテキストのスクリーンショット骨格判定（**非ゼロピクセルだけでなく向き・正立を目視系アサートで**— UV 反転教訓）。
  - preview ↔ mp4/webm/PNG 連番 ↔ bundle の同一フレーム画素比較（INV-2）。
  - 3D ⇄ 2D トグル往復で 2D 描画が変更前スクリーンショットと一致（非破壊性）。
  - **既存回帰ゲート**: §6 記載の既存 verify 群 + `npm test` フルスイート。
- **perf**: P0/P2 で実 Chrome + 実ドラッグ + CDP screencast/Tracing（headless SwiftShader では perf 判定しない — 既確定の教訓）。

---

## 11. オープン質問（実装着手前にユーザーへ確認したい点）

1. **§9 の承認事項**（スキーマ 2 件・直列化規則・earcut 依存）— まとめて可否を伺いたい。
2. **`geomBend` のモデル**: v1 は「ベースラインを円弧に曲げる」1 パラメータ（Illustrator の Arc 相当）を推奨。Flag/Wave/Fish 等の多形ワープ族はパラメータ空間が別物なので将来拡張（`geomWarpKind` enum の余地だけ確保）で良いか。
3. **面塗りの単色ショートカット**: §4.3 は「単色 = 同色 stop 2 個のグラデーション」で正準形を 1 つに保つ設計。`RGBA | GradientFill` union にして単色を素で持てる方が良いか（直列化の分岐が増える）。推奨は前者。
4. **`threeD=false` 時の既定パースペクティブ**（§5.3）: AE 既定カメラ相当（zoom=1158 基準）を推奨。完全な正射影（遠近なし）が良ければその旨。
5. **P4（shape 統合）を初回リリースに含めるか**: 機構は共有だが verify 対象が倍になる。推奨は P1–P3（text）を先に出荷し P4 を直後の別イテレーションにする。

---

## 12. 参照

- 仕様書: [doc/mafter-effect-spec.md](../mafter-effect-spec.md) — §5.4b（3D レイヤー）/ §5.5c–e（shape 頂点・merge・rings）/ §6.5–6.5b（カメラ）/ §26（テキスト）
- 既存プラン: [shape-editing-plan.md](shape-editing-plan.md)（非破壊 shape の前例）/ [webgl-video-layer-plan.md](webgl-video-layer-plan.md)（per-layer GL 原則と v1 post-mortem）
- コード: [textRender.ts](../../src/runtime/textRender.ts) / [textLayout.ts](../../src/runtime/textLayout.ts) / [fontOutlineCache.ts](../../src/runtime/fontOutlineCache.ts) / [shapePath.ts](../../src/runtime/shapePath.ts) / [mat4.ts](../../src/runtime/mat4.ts) / [DomRenderer.ts](../../src/runtime/DomRenderer.ts) / [builtinComponents.ts](../../src/runtime/builtinComponents.ts)
- スキル: [implementation-loop](../../.claude/skills/implementation-loop/SKILL.md) / [add-layer-component-type](../../.claude/skills/add-layer-component-type/SKILL.md) / [debug-visual-render-bug](../../.claude/skills/debug-visual-render-bug/SKILL.md)
