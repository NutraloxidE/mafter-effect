# Mafter Effect — MVP 仕様書 v0.12

> **Mafter Effect = After Effects, but with Markup language.**
> Git で管理できる / HTML・CSS・JS をネイティブに扱う / AI フレンドリーな映像制作エンジン。
> 「AE クローン」ではない。動作する最小構成と、決定論的・再現可能なレンダリングを最優先する。

---

## §0. この文書の使い方（SSoT 宣言）

この仕様書は **SSoT Based Vibe Coding** 前提で書かれている。claude-code はこの文書を ground truth として実装する。

**load-bearing なのは prose ではなくスキーマと不変条件である。** 矛盾が生じた場合の優先順位:

1. `§5 データスキーマ`（TypeScript 型）
2. `§4 不変条件 (INVARIANTS)`
3. `§15 マイルストーンの受け入れ条件`
4. その他の散文

実装言語は **TypeScript**（strict）。散文は日本語、識別子・スキーマ・コードは英語。
ランタイムは **React + Vite**、`npm run dev` でブラウザ起動。MVP の段階では全て JS/TS で記述する。

**MVP の範囲は M0–M4（§15）**。Plugin API v1 を MVP 必須に含めた選択により、MVP は通常より広い。

---

## §1. 設計目標と非目標

### 目標
- 共通 `Object` モデルで 2D / 3D / HTML / UI を同一タイムライン上に扱う。
- HTML/CSS/JS を一級のコンポジション素材として扱う。
- キーフレーム + エクスプレッションによるアニメーション。
- プロジェクトを Git リポジトリとしてそのまま管理できる。
- preview と export が **値レベルで完全一致**する決定論性。
- 後から重い処理を Rust/Go/WASM に差し替えても I/O 互換。
- サードパーティ Plugin による拡張。
- **作品を「実行可能な web-native バンドル」として配信できる**（フレーム精度の動画書き出しに加え、ブラウザで実時間再生する DOM/JS バンドル。§11.7）。Mafter を"ツール"であると同時に"web-native なモーション配信フォーマット+オーサリング環境"として位置づける。

### 非目標（MVP では追わない）
- AE 機能互換・パリティ。
- 実 3D（深度ソート / ライティング / 物理カメラ）。MVP は CSS-3D による 2.5D まで。
- WebGL/WebGPU レンダラ。MVP は DOM レンダラ 1 本。
- Blender import / particle / 分散レンダリング / AI 編集支援（§16 将来）。

---

## §2. コアモデル

全要素は共通の `SceneObject`。レンダリング内容は `Component` が与える。`Object` 自体は Transform と Opacity しか持たない。

```
SceneObject
 ├ Transform        (anchor / position / rotation / scale)
 ├ opacity          (universal, 0..1)
 ├ components[]      (renderable / behavior — built-in or plugin-defined)
 └ parent            (ツリーは parent 参照から導出。§5.4-note 参照)
```

- **2D/3D/HTML/UI の区別はモデル上に存在しない。** 違いは「どの Component を持つか」だけ。
- Transform は常に 3D（z を持つ）。MVP では z は CSS-3D の奥行きに写像される。

---

## §3. プロジェクト構造（確定）

```
Project/
 ├ assets/                 # 画像・動画等のバイナリ
 │   └ font/               # フォント（.ttf/.otf/.woff）。新規取り込みはここへ書く
 ├ compositions/
 │   └ <compId>/           # HTML Composition は 1 ディレクトリ
 │       ├ index.html
 │       ├ style.css
 │       └ script.js
 ├ scripts/                # エクスプレッション
 │   └ <objectId>/
 │       └ <param>.js      # 例: position.js, opacity.js, transform.position.x.js
 ├ presets/
 │   └ easing/*.json       # イージングプリセット
 ├ plugins/
 │   └ <pluginId>/         # plugin.json + entry
 ├ claude.md               # ★ エンジン/フレームワークの使い方（canonical, AI 用 SSoT）
 ├ copilot-instruction.md  # ★ claude.md から自動生成される薄いビュー（独立ソースにしない）
 ├ prompt.md               # この作品固有の演出方針（claude.md とは scope が直交）
 └ project.json            # ★ プロジェクト本体（タイムライン/オブジェクト/参照）
```

- `git init` してそのまま運用可能。バイナリ以外は全てテキスト diff 可能であること。
- **フォント配置の移行**: プロジェクト読み込み時（`loadFromFs`）に次の 2 つを移送し、変化があれば保存する。スキーマは変わらない。
  - **FS**: [migrateFontAssetPaths.ts](../src/editor/migrateFontAssetPaths.ts) が `kind:"font"` かつ `assets/font/` 配下でない asset を `assets/font/<id>.<ext>` へ移し `asset.path` を書き換える（`assets/font/` 導入前のプロジェクト対策）。best-effort（失敗した asset は旧 path のまま参照可能）。
  - **Project パネル（bin）**: [fontBin.ts](../src/editor/fontBin.ts) の `migrateFontAssetsToBin` が、ルート直下に並んだままの font asset を `fonts` フォルダへ移す（§26.3.2）。
- **AI 三点ファイルの SSoT 整理（§13）**: `claude.md` のみが正。`copilot-instruction.md` は生成物。`prompt.md` は別 scope。

---

## §4. 不変条件 (INVARIANTS)

実装が常に満たすべき契約。テストで検証する。

- **INV-1（決定論）**: `resolve(comp, frame)` は同じ入力に対し常に同じ `ResolvedScene` を返す。エクスプレッションは `(frame, comp state)` の純関数であり、`Math.random` / `Date.now` / DOM / network を一切使わない。乱数は seeded helper のみ。
- **INV-2（preview ≡ export）**: 同一 frame における preview の scene 値・browser export の scene 値・headless export の scene 値は一致する（ラスタ化の忠実度は手段により差が出てよいが、**scene の解決値は同一**）。
- **INV-3（レンダラ非依存）**: `SceneObject` / `Composition` / Timeline / Keyframe の各データ構造は Renderer に依存しない。Renderer は `ResolvedScene` のみを受け取る。
- **INV-4（FS 等価）**: `IndexedDbFs` と `NodeFs` は同一のプロジェクトフォルダ（同一パス構成）を生成する。zip 書き出し結果はフォルダ構成と一致する。
- **INV-5（frame canonical）**: 時間の正準単位は整数 frame。秒は `frame / fps` で導出する派生値。
- **INV-6（参照は ID）**: オブジェクト・コンポ・アセットの参照はすべて stable ID。表示名 (`name`) は参照に使わない。
- **INV-7（単一ランタイム核）**: `resolve` + Renderer + module loader + expression engine + 再生クロックは **`@mafter/runtime` という独立ライブラリに括り出し**、(a) エディタ preview / (b) video exporter / (c) web bundle player の 3 者が**同一の核を共有**する。エディタ依存（React/状態管理/UI）を runtime に混ぜない。これが分岐すると bundle 経路で INV-2 が破れる。
- **INV-8（bundle は別の決定論クラス）**: web bundle player（§11.7）は**実時間・エンドユーザのハード依存**で動き、フレーム精度は保証しない（マスタークロック=音声、frame drop はフレームをスキップして現在 frame に `resolve` でワープ）。フレーム精度の正準出力は MP4/headless 経路のみ。bundle と MP4 を同一の保証として扱わない。

---

## §5. データスキーマ（本体）

> これが仕様の中核。claude-code はこの型に従って `project.json` を読み書きする。

### §5.1 基本型

```ts
type ObjectId = string;   // ULID. stable, 表示名とは独立 (INV-6)
type CompId   = string;   // ULID
type AssetId  = string;   // ULID
type Frame    = number;   // 整数 (INV-5)

interface Vec3 { x: number; y: number; z: number; }
interface RGBA { r: number; g: number; b: number; a: number; } // 0..1
```

### §5.2 アニメーション可能プロパティ

```ts
// 静的値・キーフレーム列・エクスプレッションのいずれか。
// expression があれば keyframes/value を上書きする（評価時に value/keyframe 値が ctx.value として渡る）。
interface AnimatedProp<T> {
  value: T;                  // base 値（keyframe が空のとき使用）
  keyframes: Keyframe<T>[];  // frame 昇順。空 = 静的
  expression?: ExpressionRef;
}

interface ExpressionRef {
  path: string;   // scripts/<objectId>/<param>.js への相対パス
  enabled: boolean;
}

interface Keyframe<T> {
  frame: Frame;
  value: T;
  easing: Easing;  // この KF から「次の」KF への区間に適用 (§9)
}
```

### §5.3 イージング（§9 も参照）

```ts
type Easing =
  | { type: "linear" }
  | { type: "hold" }                                       // ステップ補間
  | { type: "bezier"; bezier: [number, number, number, number] } // CSS cubic-bezier 形式
  | { type: "preset"; id: string };                        // presets/easing/<id>.json を解決
```

MVP の易しさのため、ベクトルへのイージングは **全成分一律**（per-axis は §16 将来）。

### §5.4 Transform / Object

```ts
interface Transform {
  anchor:   AnimatedProp<Vec3>;  // アンカーポイント
  position: AnimatedProp<Vec3>;  // z は CSS-3D 奥行き
  rotation: AnimatedProp<Vec3>;  // euler XYZ degrees
  scale:    AnimatedProp<Vec3>;  // {1,1,1} = 100%
}

interface SceneObject {
  id: ObjectId;
  name: string;                  // 表示専用・ユーザー編集可（参照は ULID、INV-6 不変）
  parent: ObjectId | null;       // transform 継承のみ。描画順とは無関係
  zOrder: number;                // comp 内グローバル描画順。fractional（小→奥）。§5.4-note 参照
  enabled: boolean;
  inPoint: Frame;                // この comp 内での表示開始
  outPoint: Frame;               // 表示終了
  transform: Transform;
  opacity: AnimatedProp<number>; // 0..1, 全 Object 共通
  components: Component[];
  labelIndex?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16; // §5.4c ラベル色。省略 = 無色
  blendMode?: BlendMode;         // §5.4d 描画モード。省略 = "normal"
  trackMatteMode?: TrackMatteMode; // §5.4f トラックマット。省略 = なし
}
```

> **§5.4-note（Object 格納形式 — 確定）**: オブジェクトは **flat list** で保持し、ツリーは `parent` 参照から導出する（`children[]` は持たない）。理由 = reparent が 1 フィールド変更で済み Git diff が最小、LLM 編集も局所化、かつ **描画順(`zOrder`) と transform 親(`parent`) を直交**させられる（AE 同様、子を親の裏に置ける）。
> - `parent` は **transform 継承のみ**。`zOrder` は comp 内グローバル描画順で **fractional index**（1.0 と 2.0 の間に挿す＝1.5、全体再採番不要、たまに rebalance）。
> - `project.json` 直列化時は `objects` を **id 昇順でソート**し配列順に意味を持たせない → 追加/削除/reparent/並べ替えのどれでも「変わったオブジェクトの行だけ」が diff に出る（§5.6 正準化）。
> - 整合性は **load 時 1 パス検証**: 存在しない `parent` id → root 扱い + warn、循環（A→B→A）→ プロジェクトエラー。
> - DomRenderer は **ネストしない**。`resolve()` が parent チェーンを畳んで各オブジェクトに **world transform を焼き込み**、全オブジェクトを 1 つの root の**兄弟**として `transform: matrix3d(world)` + per-object `opacity` で並べ、`zOrder` を DOM/z-index 順、root に `preserve-3d` をかける。これで zOrder⊥parent / opacity 非継承（CSS opacity は子に合成されない）/ 3D は z 深度でブラウザが合成、が同時に成立する。transform 数学が全部 `resolve()`（純関数）に寄るので §14 の WASM 化にも有利。これはレンダラ実装詳細でありデータは無傷（INV-3）。

### §5.4b 3D レイヤー（additive スキーマ・確定）

> AE の per-layer「3D レイヤー」スイッチ + comp 単位「3D レンダラー」に準拠。**どれも optional**、値があるときだけ直列化（既存 project.json は byte 等価のまま・INV-4）。

```ts
interface SceneObject {
  // ...既存フィールド...
  threeD?: boolean;                          // true = 3D 空間に配置（AE の 3D レイヤースイッチ）。省略/false = 平面 2D
  threeDMode?: "auto" | "dom" | "raster3d";  // 描画経路。省略 = "auto"（comp.renderer3d に従う）
}

interface TimelineComposition {
  // ...既存フィールド...
  renderer3d?: "classic" | "advanced";       // comp の 3D レンダラー。省略 = "classic"
}
```

- **実効モード解決**（`resolve()` で確定し `ResolvedObject` に焼く・INV-3）: `threeD!==true` → 平面 2D。`threeDMode==="auto"` → `renderer3d==="advanced" ? "raster3d" : "dom"`。それ以外は上書き値。
- **`dom`（≈ AE Classic 3D）**: CSS `preserve-3d` のネイティブ経路。ベクター鮮鋭・**ライブ HTML**・編集可能。レイヤー境界の交差はペインター級（相互貫通不可）。
- **`raster3d`（≈ AE Advanced / CINEMA 4D）**: レイヤーをラスタライズし comp 共有の WebGL シーン（Three.js）にテクスチャ板として投入。同シーン内の他 raster3d 層・`scene3d` メッシュと per-pixel で本物の深度交差。代償＝静止テクスチャ化（ライブ HTML 不可）。実装は §6.5 / Phase 2（将来 §16）。
- **既定運用**: comp 既定 classic（全部 dom/ライブ）→ 真の交差が必要な層だけ `threeDMode="raster3d"` に上書きし、ライブ性の損失を最小化する。
- **エクスポート**（INV-2）: scene 解決値は全経路一致（ラスタ忠実度差は許容）。平面 2D 層 = foreignObject、3D 層（dom/raster3d いずれの解決でも）= 書き出し時に GL ラスタ→`readPixels` でブラウザ内取り込み（決定論）。Playwright ヘッドレスは将来 Node CLI（§16）オプション。

### §5.4c レイヤーラベル色（additive スキーマ・確定）

> AE のレイヤーラベル色に準拠。**エディタ UI のみ** — `resolve()` / export / preview には影響しない（INV-1〜3 不変）。

```ts
type LabelIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;

interface SceneObject {
  // ...既存フィールド...
  labelIndex?: LabelIndex;  // 省略 = 無色（既定グレー行）
}
```

- 直列化: `labelIndex` は **0–16 のときのみ**書く。範囲外は strip。UI は [src/editor/layerLabels.ts](../src/editor/layerLabels.ts) のパレット（AE 16 色 + index 16 = 旧 LayerBar ベージュ `#b89b6a`、§21.10）。

### §5.4e レイヤーロック（additive スキーマ・確定）

> AE のレイヤーロックに準拠。**エディタ UI のみ** — `resolve()` / export / preview / bundle player には影響しない（INV-1〜3 不変）。

```ts
interface SceneObject {
  // ...既存フィールド...
  locked?: boolean;  // true = ロック（編集不可）。省略/false = 編集可
}
```

- 直列化: `locked === true` のときのみ `project.json` に書く。`false` / `undefined` はキー省略（§5.6 正準化）。
- UI 規約は §21.11。

### §5.4d 描画モード / ブレンドモード（additive スキーマ・確定）

> AE の「描画モード」に準拠。レイヤー描画結果を**背面に積まれた合成結果**と合成する。**Web ネイティブ合成**を採り、preview / Live バンドルはラスター化ゼロ（CSS）、動画キャプチャは Canvas で合成し直して INV-2 を守る。

```ts
type BlendMode =
  | "normal"
  | "multiply" | "screen" | "overlay" | "darken" | "lighten"
  | "color-dodge" | "color-burn" | "hard-light" | "soft-light"
  | "difference" | "exclusion"
  | "hue" | "saturation" | "color" | "luminosity";   // CSS mix-blend-mode が直接持つ 16 種（normal 含む）

interface SceneObject {
  // ...既存フィールド...
  blendMode?: BlendMode;  // 省略 = "normal"
}
```

- **データ型はプレーン enum**（`AnimatedProp` にしない）。AE でも描画モードはキーフレーム不可。
- **直列化**: `blendMode` は **`"normal"` 以外のときだけ**書く。`undefined`/`"normal"` はキー省略（§5.6 正準化）→ 既存 `project.json` は byte 等価（INV-4）。**未知値は validate / canonicalize で strip**（書き出しに残さない）。
- **未知 blendMode（load 時）**: `validateProject` が `blendMode` を `undefined`（= normal 描画）に正規化し、エディタは `missingBlendModes`（editor-only・非直列化）に raw 名を記録。Inspector は `{raw} (missing)` を表示。ユーザーが既知 mode を選ぶと missing 記録は消える。
- **resolve（INV-3）**: `resolve()` が `ResolvedObject.blendMode`（未知は `"normal"` に正規化）に焼く。補間しない（純粋・INV-1）。
- **描画経路**（§8 / §11）:
  - **preview / Live HTML バンドル**: 16 種は CSS `mix-blend-mode` をレイヤー div に直接設定（ラスター化ゼロ・ネイティブ合成）。
  - **動画キャプチャ書き出し（mp4 / webm / png 連番）**: `foreignObject` は backdrop 合成をしないため、comp 内に非 `normal` の 15 種が 1 つでもあれば **レイヤー別キャプチャ → Canvas 2D `globalCompositeOperation`**（`normal`→`source-over`、他 15 種は同名）で z 順に合成し直す。これで preview ≡ export（INV-2）を守る。非 blend comp は従来の単一スナップショット高速経路を維持。
- **INVARIANTS**: `blendMode` は `ResolvedObject` に焼くためレンダラ非依存（INV-3）、optional 省略で byte 等価（INV-4）。
- **Dither Dissolve**: 旧 `blendMode: "ditherDissolve"` は廃止。§27 `ditherDissolve` **live エフェクト**を使用（マスク型ディザ・`blendMode` ではない）。

### §5.4f トラックマット（additive スキーマ・確定・2026-07）

> AE の TrkMat（直上レイヤーをマット源）に準拠。**レイヤーパスマスク（ペン / ベジェ）は含まない**（将来）。正準は **live**（comp 空間 SVG `<mask>`）。export / bundle は live DOM を撮影して INV-2 を守る。

```ts
type TrackMatteMode = "alpha" | "alphaInverted" | "luma" | "lumaInverted";

interface SceneObject {
  // ...既存フィールド...
  trackMatteMode?: TrackMatteMode;  // 省略 = なし。マット源はスタック直上（ID 参照なし）
}
```

- **ペアリング**: `zOrder` 昇順（タイは id）のスタックで、塗りから見て**次の適格レイヤー**がマット源。フレーム非依存。`enabled` / in-out で**再バインドしない**。マットが当該フレーム非可視なら**空マット**（alpha では塗り全消し）。
- **対象外**（塗り・マット源とも無視 / validate strip）: `isAdjustment` / `isNull` / camera のみ。
- **連鎖なし（v1）**: マット源自身の `trackMatteMode` は無視。1 マット源は 1 塗りにのみ使用。
- **直列化**: 有効値のときだけ書く。不明値は strip。省略時 byte 等価（INV-4）。
- **resolve（INV-3）**: 塗りに `trackMatte: { mode, matteId }`、可視マット源に `isTrackMatteSource: true`。
- **描画正準（preview / export 共通）**: 塗り = full-comp host + inner（`matrix3d` + content）。マット源は host の子（画面非表示・キャプチャ専用）。両者を comp 空間へラスタし、純関数 `applyTrackMatte`（`src/runtime/trackMatteApply.ts`）で合成した結果を host 上の canvas に blit。**CSS `mask-image` / SVG mask+foreignObject / `mix-blend-mode: destination-*` は使わない**（Chromium で text マット不可、または不正 CSS で no-op）。
- **export**: 合成済み result canvas を含む fillHost をキャプチャ（マット源は通常レイヤー列から除外）。INV-2 は同一純関数で担保。
- **非目標（v1）**: レイヤーパスマスク、マット連鎖、人物セグメンテーション（OpenCV 等は後続）。

### §5.5 Component（タグ付き union + プラグイン拡張）

```ts
// 全 Component は type と props を持つ。各 type は ParamDescriptor[] で
// 「どの props がアニメーション可能か」を宣言する。これが Inspector / Plugin / HTML manifest を貫く統一契約。
interface Component {
  type: string;                       // 下記 built-in or plugin 定義
  props: Record<string, AnimatedProp<unknown> | unknown>;
  exportStrategy?: "live" | "bake";   // web bundle export 時の扱い（§11.7）。未指定なら type の既定
}

interface ParamDescriptor {
  key: string;
  label: string;
  kind: "scalar" | "vec2" | "vec3" | "color" | "bool" | "enum" | "string" | "asset";
  default: unknown;
  animatable: boolean;
  min?: number; max?: number; step?: number;
  options?: string[];                 // enum 用
}

// §5.5c shape Phase 2（頂点/ベジェパス編集）。Component.props.vertices?: ShapeVertex[]
// に additive-optional で乗る（存在しなければ従来通り kind=rect/ellipse の CSS box）。
// ParamDescriptor には載せない — 単一 AnimatedProp ではなく「AnimatedProp を内包する
// オブジェクトの配列」のため ParamDescriptor 駆動の汎用 UI/KF行の対象外（Inspector 専用編集）。
interface ShapeVertex {
  id: string;                         // ULID (INV-6)。頂点順 = パス順（id 昇順ソート対象外）
  pos: AnimatedProp<Vec3>;
  inTangent?: AnimatedProp<Vec3>;      // 頂点位置からの相対オフセット（AE 風ハンドル）
  outTangent?: AnimatedProp<Vec3>;
}

// §5.5d shape kind="merge"（Boolean/Pathfinder 合成・他レイヤー参照・確定・2026-07）。
// AE の Merge Paths（同一レイヤー内の shape グループ合成）ではなく Illustrator の Pathfinder
// （選択した複数の別オブジェクトを合成）に相当する。この engine の objects はフラットで
// レイヤー内ネスト（AE の shape グループ）を持たないため、こちらが自然なモデル。
// kind==="merge" のとき Component.props.mergeInputs?: BooleanMergeInput[] を使う（rect/ellipse/path
// の kind 別 props とは排他）。objectId は同一 comp 内の他 SceneObject への安定 ID 参照（INV-6）。
// 参照先は kind が rect/ellipse/path の shape のみ（merge 同士の参照は循環防止のため不可＝resolve
// 時に無視）。mergeInputs[0].op は無視される（直前の合成結果が無いベース図形のため）。
// **参照されたレイヤーは自身の通常描画から自動的に除外される**（合成結果としてのみ見える。
// trackMatte のマット源レイヤーが除外されるのと同じ考え方 — §5.4f 参照）。
type BooleanOp = "unite" | "subtract" | "intersect" | "exclude";

interface BooleanMergeInput {
  id: string;                         // ULID (INV-6)
  objectId: ObjectId;                 // 参照先 SceneObject（同一 comp 内、shape kind=rect/ellipse/path）
  op: BooleanOp;                      // 直前までの合成結果に対する自分の合成規則
}
```

**Boolean 合成の実装（確定）**: `polygon-clipping`（npm, MIT）で `unite→union` / `subtract→difference` / `intersect→intersection` / `exclude→xor` にマップする。rect/ellipse/path いずれの入力もポリゴン輪（Ring）へ変換してから合成する — rect は4隅（**角丸は v1 では無視し鋭角として扱う既知の制約**）、ellipse は48角形近似、path は bezier tangent を直線分割（flatten、既定24分割/辺）。そのため**合成結果の輪郭は多角形近似**になる（合成しない単体 shape は通常の CSS box / `buildShapePathD` の厳密な形状のまま描画される — この近似は merge 使用時のみ）。結果の SVG path は `fill-rule="evenodd"` で描画し、穴（`subtract` で切り抜かれた内側リング）を正しく表示する。`src/runtime/shapePathBoolean.ts` に純関数として実装（INV-1）。

**cross-object 座標変換（確定）**: 参照先レイヤーは同一 comp 内の別 SceneObject であり、自身の Transform（position/rotation/scale/anchor、親チェーン込み）を独立に持つ。resolve.ts は参照先の world 行列 → merge shape 自身の world 行列の逆、で「merge shape 自身のローカル空間」へ頂点を変換してから合成する（`resolveComponent` 内に `worldOf`/`byId` を統合し、cross-object 参照から参照先の world を引けるようにした）。そのため参照先・merge shape のどちらの Transform がアニメートしても、合成結果は毎フレーム正しく追従する。

#### §5.5e shape kind="path" 複数リング（Bake 出力・確定・2026-07）

```ts
// Component.props.rings?: ShapeVertex[][] に additive-optional で乗る。存在すれば単一の
// vertices より優先して描画される（fill-rule="evenodd" — 内側リングは穴として表現）。
// 手動生成の単一図形は従来通り vertices のまま。rings は Bake（下記）の出力専用。
type ShapeRings = ShapeVertex[][];
```

**Bake（kind="merge" → kind="path"、Illustrator Expand 相当・確定）**: Inspector の Shape フォールドアウトに「Bake」ボタンがあり、`mergeInputs`（他レイヤー参照）を外し、Boolean 合成結果を独立した `rings` データへ変換する（`src/editor/shapeBake.ts`）。

- **AE の「Convert Expression to Keyframes」と同じ制約**: 1つのパスプロパティは全キーフレームで頂点数・リング数（トポロジー）を揃える必要がある（AE のマスクパスも同様）。オブジェクトの `inPoint..outPoint` 区間で毎フレーム合成し、トポロジー（穴の有無・リング数・リングごとの頂点数）が区間全体で一定なら、区間全体を各頂点 `pos` のキーフレーム列としてベイクする（`easing: "hold"` — フレーム間の補間ではなく決定論的な per-frame サンプルのため）。
- **トポロジーが区間内で変化する場合（確定・フォールバック）**: 区間全体を1本の連続アニメーションとして表現できないため、**現在フレームの静止形状のみ**を `staticProp` としてベイクし、その理由を Inspector にメッセージ表示する。
- Bake 後は `mergeInputs` が無くなるため、参照されていた他レイヤーは自動的に再表示される（§5.5d の自動非表示は `mergeInputs` の存在に基づく構造的判定のため、自然に解除される）。
- rings も Inspector で編集可能（既存 `ShapeVertexRow` をリングごとに再利用。リング単位の削除、または「Rings を破棄して単一パスに戻す」で `vertices: []` の単一図形へ戻せる）。

#### §5.5f text 3D 押し出し（geom3d・非破壊・additive・確定・P1 実装済み 2026-07-13・P2 実 MVP 投影 2026-07-14）

> 設計の正は [doc/cloudplan/3d-text-extrusion-plan.md](../doc/cloudplan/3d-text-extrusion-plan.md)（アーキテクチャ・比較検討）/ [doc/cloudplan/3d-text-extrusion-implementation.md](../doc/cloudplan/3d-text-extrusion-implementation.md)（作業票）。Illustrator の 3D 効果（押し出し・ベベル）相当をライブ（ベイク不要）に実現する。**P1 実装スコープ = depth + bevel + lambert 陰影 + 3D⇄2D トグルのみ**。twist/bend/taper（ねじり・曲げ・テーパー）とグラデーション面塗り（`GradientFill`）は本リビジョンでは**未実装**（次フェーズ）。

```ts
// text（将来 shape も同じ配列を concat する・P4 未着手）の Component.props に additive-optional で乗る。
// flat prop のため既存 ParamDescriptor 駆動の Timeline KF 行・Inspector PropRow・undo 配線をそのまま使う
// （§26.2 と同じ契約）。全キー省略時は従来の 2D 描画のまま・byte 等価（INV-4）。
interface Geom3DTextProps {
  geomEnabled:       boolean;                          // 既定 false。animatable: false（構造トグル）
  geomDepth:         AnimatedProp<number>;              // px, >=0。既定 50
  geomBevelSize:      AnimatedProp<number>;              // px, >=0。既定 0（ベベルなし）
  geomBevelSegments: number;                            // 1..8。既定 2。animatable: false
  geomCurveQuality:  "low" | "medium" | "high";          // ベジェ flatten 分割数。既定 "medium"
  geomShading:       "none" | "lambert";                 // 既定 "lambert"
  geomAmbient:       AnimatedProp<number>;               // 0..1。既定 0.35（lambert 時のみ意味を持つ）
  geomLightDir:      Vec3;                                // comp/world 空間の平行光方向。既定 {x:-0.5,y:-0.7,z:-0.5}。animatable: false
}
```

- **3D⇄2D トグル（非破壊）**: `geomEnabled=false`（既定・省略）は既存 2D 描画経路（draft DOM / precise SVG、§26.4）を**そのまま**通る。ON にしても既存 `text`/`color`/`strokeColor` 等の 2D 用 props は変更されない。トグルは非アニメータブル（AE の 3D レイヤースイッチと同じ理由 — フレーム間で DOM 構造が切り替わるとキャッシュ・export 分岐が毎フレーム変わるため）。
- **色の継承**: 前面/背面/側面/ベベルはすべて既存 `color` を継承し lambert 陰影を掛けるのみ（面ごとの色/グラデーション上書きは次フェーズ §5.5g 予定・未実装）。
- **フォント制約（§26.4.1 と同じ）**: アウトライン抽出できるのは asset フォント（`.ttf/.otf/.woff` を assets として取り込んだもの）のみ。system フォント（`sans-serif` 等、ビルトイン Noto を含む — Noto は `@font-face` 実ロードのみで opentype パース未登録・§26.3.2）では `geomEnabled=true` でも**アウトライン抽出不可のため自動的に 2D 描画へフォールバックする**（無音・非破壊。Inspector 警告表示は未実装・既知のギャップ）。
- **カメラ・実 MVP 投影（P2・確定 2026-07-14）**: comp のアクティブカメラ（§6.5）・`Transform.rotation` を含む
  `worldTransform` を GL に実投影する。`mvp = Proj·cameraPre·worldTransform`（`cameraPre` は `DomRenderer.setupCameraRig` の
  `translate(cx,cy,P)·view` を再利用、`Proj` は同じ CSS `perspective` リグを数式的に再現した pixel-space 透視/正射影）。
  法線は `normalMatrix(worldTransform)`（= world の逆転置）で world 空間へ運び、`geomLightDir`（comp/world 空間の平行光）と
  内積して lambert 陰影を計算する＝回転させると陰影が正しく面を横断する（真の per-object 3D 回転応答）。
  **中立性**: camera 無し・回転無し・`depth=0` のとき既存 2D 描画とスクリーン位置/サイズが一致する（実機 verify 済み、水平方向は厳密一致・
  垂直方向は 2D の CSS line-box と GL の ink-bbox の測定手法差ぶんの許容あり）。
  **描画方式**: per-object canvas（3D レイヤーごとに 1 canvas）。canvas は **comp 全域**を `devicePixelRatio` 解像度で覆い、
  親 div（`entry.div`）の CSS `matrix3d` 傾けは打ち消す（投影は GL の `mvp` が一手に担う。§ AABB 最適化は次フェーズ）。
  レイヤー間の合成は既存 z-order（DOM）、オブジェクト内の自己遮蔽は GL depth buffer が担う。
  ネスト comp（`renderNestedComp`）内の 3D-extrude text は本リビジョンの対象外（`geom3dCamera=null` で従来の
  CSS `matrix3d` 傾け近似のまま・既知のギャップ、次フェーズ）。
- **描画経路（案 B・確定）**: per-layer の**素の WebGL canvas**（three.js 不使用）。`entry.contentRoot`（= `el`）内の 1 DOM 要素として座り、blend/filter/matte/export のレイヤー列挙には一切関与しない（[webgl-video-layer-plan.md](../doc/cloudplan/webgl-video-layer-plan.md) §1 の確立原則を踏襲）。実装: `src/runtime/geom3d/`（`geom3dTypes.ts`/`geom3dParams.ts`/`outlineProvider.ts`/`normalizeRings.ts`/`extrudeMesh.ts`（earcut 使用）/`geom3dGl.ts`/`geom3dMeshCache.ts`/`geom3dDomApply.ts`）、配線は `DomRenderer.ts` の `case "text"` 内のみ（型別オプトイン）。
- **輪郭の nonzero 正規化（確定・2026-07-15 修正）**: フォントのアウトラインは **nonzero winding rule** 前提で作られ、**輪郭どうしが重なってよい**（画 = stroke ごとの独立輪郭）。押し出しパイプラインの下流（`groupRingsByNesting` の入れ子深度判定・earcut・bevel の inset・側面 band）はいずれも「交差しない外周 + 真の穴」しか扱えないため、`OutlineProvider` は**リングをグリフ単位で nonzero rule により再構築してから**下流へ渡す（`normalizeRings.ts` の `normalizeRingsNonzero`）。正規化後のリングが互いに交差しないことは `OutlineGlyph` の不変条件であり、生アウトラインを下流へ直接渡してはならない。
  - 生アウトラインが下流の前提を満たさない実例: Noto Sans JP の `日` は〈枠をシーム付き 1 輪郭で描いたもの〉+〈横棒 2 本〉の重なりで**穴を 1 つも持たない**。巻き方向を捨てる入れ子深度判定はこの横棒を穴と誤判定する。Roboto の `A`/`B`/`8` でも起き、**フォント依存であって言語依存ではない**（Anton/Tinos/Noto Sans/Cousine のように重なりを持たないフォントは影響を受けない）。
  - 正規化は塗り領域を保存する（nonzero で塗った面積が等価）ため、見た目の意図は変わらない。tesselator が失敗した場合は生リングへフォールバックし描画を止めない。
  - グリフ単位で正規化する（tracking が詰まって文字どうしが重なっても融合させない）。
- **メッシュ生成の設計簡略化（既知）**: `depth`/`bevelSize` は uniform ではなく**メッシュ生成時に実座標として焼き込む**（front cap z=0 固定・back cap z=-depth。ベベルの XY オフセット px と Z 比率を正しく釣り合わせるため）。そのため depth/bevel の変更はメッシュキャッシュ（`geom3dMeshCache.ts`、決定論キー）のミス＝再生成を伴う。twist/bend/taper 用に想定していた「アニメ中 uniform のみで再生成ゼロ」は本パスでは未達成（次フェーズの性能最適化課題）。
- **export（INV-2）**: GL canvas は `preserveDrawingBuffer: true`。mp4/webm/PNG 連番・bundle は既存の canvas インライン化 export 経路に乗る想定（本リビジョンで詳細な export parity verify は未実施・次フェーズで実施）。`exportStrategy` の既定は他の text と同じ `live`（§5.5、GL 描画はブラウザでライブ実行可能なため bake 不要）。
- **依存追加**: `earcut`（MIT・~2KB、cap の三角形分割）、`libtess`（SGI Free Software License B・~17KB min、輪郭の nonzero 正規化）。`libtess` を選ぶ理由は **nonzero rule での輪郭出力**（`GLU_TESS_BOUNDARY_ONLY`）が必要なため — bevel の inset と側面 band がリングを要求するので三角形しか返さない tesselator では代替できず、既存依存の `polygon-clipping` は even-odd 系 boolean 演算のみで nonzero rule を表現できない。
- **INV 影響**: なし（既存 INV-1〜6 の枠内。§5 追加は additive-optional・INV-4 準拠）。

**受け入れ確認（実機 Playwright）**: P1 = 実フォント（Noto Sans asset）でのグリフ押し出し（depth/bevel/lambert）が実 Chrome で正しく描画されること、`geomEnabled` トグルの ON→OFF→ON 往復で 2D/3D 双方の DOM 構造が正しく切り替わり残留ノードが無いこと、`depth=0` で例外なく描画できること、Inspector から各 param を編集できることを確認。
P2（2026-07-14, `verify-geom3d-neutral.mjs`/`verify-geom3d-mvp.mjs`）= camera 無し・回転無し・depth=0 で 2D と実機ピクセル一致（中立性）、
camera dolly（POI 固定で距離を詰める）で投影後 bbox が拡大、`Transform.rotation.y` 回転で bbox が変化（旧固定カメラ実装は camera/rotation 無応答だった）、
非 3D-extrude の 3D solid/image が引き続き CSS `matrix3d` 経路で無回帰（`cameraPre` 応答・console error 0）を確認。
**mp4/webm/bundle export の実 parity verify、shape への適用（P4）、ネスト comp 内 3D-extrude text の実 MVP 化、Inspector の system フォント警告表示は未実施・次フェーズ**。

**MVP built-in component types:**

| type        | 役割                              | 主な params                          |
|-------------|-----------------------------------|--------------------------------------|
| `solid`     | 単色塗り（AE Solid 相当）          | `color: RGBA`, `size: vec2`          |
| `text`      | テキスト（DOM/SVG レンダリング, §26） | `text`, `font`, `size`, `color`, `align`, `tracking`, `leading`, `weight`, `italic`, `strokeColor`, `strokeWidth`, `geom*`（3D 押し出し・任意, §5.5f） |
| `image`     | 画像アセット表示                   | `asset: AssetId`, `fit`              |
| `shape`     | rect / ellipse / path（頂点編集, §5.5c）/ merge（他レイヤー Boolean 合成, §5.5d） | `kind: "rect"\|"ellipse"\|"path"\|"merge"`, `fill: RGBA`, `radiusTL/TR/BR/BL`（rect のみ）, `size: vec2`（rect/ellipse のみ）, `vertices?: ShapeVertex[]`（path のみ）, `rings?: ShapeRings`（path のみ、Bake 出力・存在すれば最優先, §5.5e）, `mergeInputs?: BooleanMergeInput[]`（merge のみ） |
| `html`      | HTML Composition（Model A, §7）     | `compId: CompId`, + comp が宣言した params |
| `video`     | 動画アセット（best-effort, §11.4）   | `asset: AssetId`, `fit`, `trimStart: Frame`, `gain: AnimatedProp<number>`（0..1, 既定 1）, `autoFade: bool`（既定 true, §11.5.2） |
| `audio`     | 音声アセット（最小, §11.5）          | `asset: AssetId`, `gain: AnimatedProp<number>`（0..1, 既定 1）, `trimStart: Frame`, `autoFade: bool`（既定 true, §11.5.2） |
| `camera`    | カメラ（comp に最大 1 つ active, §6.5） | `cameraType`, `pointOfInterest`, `zoom`, `focalLength`, `filmSize`, `near`, `far`（被写界深度は将来）, Transform で位置/向き |

plugin はここに新しい type を追加できる（§12）。

> **`camera` パラメータ（AE 準拠・段階導入, §6.5）**: `cameraType: "one-node" | "two-node"`（新規作成は **two-node 既定**）。`pointOfInterest: AnimatedProp<Vec3>`（two-node 時、常にこの注視点を向く＝auto-orient）。タイムライン可変は `zoom`(px)、設定値 `focalLength`(mm) / `filmSize` は zoom と相互導出（§6.5）。`near`/`far` はクリップ面。被写界深度（`depthOfField`/`focusDistance`/`aperture`/`blurLevel`）は将来（§6.5 / Phase 3）。one-node はカメラ Transform の rotation/Orientation で向きを決める。後方互換: 旧 `fov` のみのカメラは one-node・`zoom` を `fov` から導出して扱う。

> **決定（覆し可）**: `video` と `audio` を MVP に入れた（音楽 MV 用途を想定）。ただし `video` は決定論シーク制約があり browser は best-effort（§11.4）。`audio` / `video` 内蔵音声とも `gain` を **keyframe 可能な `AnimatedProp<number>`（0..1）** として持つ（mixing graph は §16 将来）。後方互換: 既存 `gain` が plain number でも `readGainProp()` が `staticProp` に正規化する。`compRef`（comp ネスト＝precomp）は曖昧さが大きいため **MVP から外し §16 将来**へ（プリコンポは時間マッピング/collapse 仕様が要るため）。

> **`exportStrategy` の既定（確定）**: web bundle export 時、各 component type が既定を宣言する。**自動判定はしない**（任意の author JS が実用速度で web 実行できるかは静的に分からないため）。既定: `solid`/`text`/`shape`/`image`/`html`/`audio` → `live`、将来の WebGL/particle/3D → `bake`。**plugin（第三者）は既定 `bake`**（§12、配信時に第三者コードをエンドユーザに流さない安全側）。author は per-component で上書き可。`bake` 指定レイヤは export 時に headless 機構（§11.4 / M3.5）で部分 MP4/WebP 化してアセットに差し替える。

### §5.5b Effect（レイヤー後処理） — additive スキーマ（確定）

> **設計の正は §27**。本節は §5（データスキーマ・§0 優先度 1）に属する **型定義**のみを確定する。

```ts
// §27 エフェクト。components（描画内容）とは独立した「レイヤー描画結果への後処理」。
// 適用順 = 配列順（components 同様、意味順なので並べ替えない・§5.6 正準化）。
interface EffectInstance {
  id: string;                          // ULID. stable ref (INV-6)。name 参照しない
  type: string;                        // "blur" | "tint" | plugin 定義
  enabled: boolean;                    // AE の fx 有効トグル
  props: Record<string, AnimatedProp<unknown> | unknown>;  // ParamDescriptor[] と同契約（§5.5）
}
```

`SceneObject` を additive 拡張する（**どちらも optional**。値があるときだけ直列化＝既存 project.json は byte 等価のまま・INV-4）:

```ts
interface SceneObject {
  // ...既存フィールド...
  effects?: EffectInstance[];   // 省略/[] = エフェクトなし。配列順 = 適用順（先頭が先に適用）
  isAdjustment?: boolean;       // true = 調整レイヤー（content components を描画せず effects を背面に適用・§27.4）
  adjustmentMode?: "live" | "raster"; // isAdjustment 時のみ有効。省略 = "live"（§27.4）。"raster" のときだけ直列化（byte 等価維持）
  isNull?: boolean;             // true = Null レイヤー（描画なし・transform 親のみ・§30）
}
```

- `EffectInstance.props` は `Component.props` と完全に同じ規約（`AnimatedProp<T>` か素の値）。これにより Inspector foldout / Timeline KF 行 / 補間 / expression seam を**そのまま再利用**できる。
- `effects[]` は **意味順配列**。`components` と同じく正準化で並べ替えない（§5.6 / L283）。`AnimatedProp.keyframes` は従来どおり frame 昇順。
- builtin effect type（`blur`/`tint`）も plugin effect 同様 `EffectDef` を `globalPluginRegistry.registerEffect` に登録する（§27.2 / §12）。

### §5.6 Composition / Project

```ts
type CompKind = "timeline" | "html";

interface CompositionMeta {
  id: CompId;
  name: string;
  kind: CompKind;
  width: number;            // px
  height: number;           // px（任意比率・任意解像度を明示可能）
  fps: number;
  duration: Frame;          // 総フレーム数
  background?: RGBA;        // 未設定 = 透明。不透明 export（alpha 無）の最終ラスタ化時のみ黒でマット。bundle 再生・ネストコンポ合成は透明。
  binId?: string;           // §20.5 Project Bin。省略 = ルート。resolve 非参照。
  bpm?: number;             // 編集補助 BPM。0/省略 = 無効（タイムコードのみ）。表示専用メタ・resolve 非参照（§21.1b）。
  beatsPerBar?: number;     // 1 小節の拍数。省略 = 4。bpm > 0 のときのみ意味を持つ。resolve 非参照。
}
```

**BPM メタ（確定・2026-06-29）**: `bpm` / `beatsPerBar` は **編集補助の表示専用メタデータ**であり、`resolve()` / レンダラ / export / bundle は一切参照しない（INV-1/2/3/5 不変）。正準時間は整数 `Frame` のまま。
- **直列化（§5.6-canon）**: `bpm` が `0` / 未設定 → `bpm`・`beatsPerBar` ともキー省略（既存 `project.json` **byte 等価**・INV-4）。`bpm > 0` かつ `beatsPerBar === 4`（既定）→ `beatsPerBar` のみ省略。
- **validate（全 comp 対象）**: `bpm` が非数 / 負 → strip + warn。`bpm === 0` → undefined 化（`beatsPerBar` も strip）。`beatsPerBar < 1` / 非整数 → `4` に正規化 + warn。`bpm` 無効時の `beatsPerBar` は strip。
- **編集 UI**: Inspector の **Composition** セクションで `bpm`（`ScrubNumber`・0 = オフ）と `beatsPerBar`（`bpm > 0` のときのみ表示）を編集（command・undo 可）。

**背景色の編集 UI（確定・UI 層）**: `background` はコンポのプロパティであり、編集は **Inspector**（レイヤー未選択時の **Composition** セクション — 色スウォッチ + 透明トグル、`setCompBackground`・undo 可）。Preview の `⬚` チェッカー/黒トグルは **ビューア設定**（§25.2）であり背景値そのものではない。

**Composition 設定の編集 UI（確定・2026-06-24）**: 同 **Composition** セクションで `width` / `height` / `fps` / `duration` も **`ScrubNumber` で編集可能**（AE Composition Settings 基本相当）。すべて command パターン（undo 可）。挙動:
- **リサイズ（`resizeComp`）**: 既存レイヤーは**中央基準でオフセット**（`parent === null` のレイヤーのみ `transform.position` x/y を `((newW-oldW)/2, (newH-oldH)/2)` 平行移動、z 不変。子は parent 継承で追従＝二重移動しない）。相対的な中央配置を維持する。
- **fps 変更（`setCompFps`）**: **秒タイミングを維持して再スケール**。`ratio = newFps/oldFps` で全 AnimatedProp の全キーフレーム `frame`・各レイヤーの `inPoint`/`outPoint`・comp の `duration` を `round(*ratio)`（INV-5 準拠で整数化）。`comp` コンポーネントの `trimStart` は子 frame 単位のため不変。fps 不一致ネストは §23.2 の秒ベース式で自動的に整合する。
- **duration 変更（`setCompDuration`）**: `duration` のみ更新（再生ヘッドが超過時はクランプ）。

**Duration の表示・入力フォーマット（確定・2026-06-25）**: Inspector の **Duration フィールドのみ** AE 既定の **タイムコード `H:MM:SS:FF`**（ノンドロップ・コロン区切り）で表示／入力する。内部値は **INV-5 どおり整数 `Frame` のまま**（スキーマ不変＝§5 変更なし）で、見た目だけ変換する。
- **frames → timecode**: `totalSec = floor(frames/fps)` を `H:MM:SS` に、`FF = frames mod fps`。`MM`/`SS`/`FF` は 2 桁ゼロ詰め、`H` は非ゼロ詰め。例: 150f@30fps → `0:00:05:00`、45f@30fps → `0:00:01:15`。
- **timecode → frames**（`:` または `;` 区切り・右詰め解釈）: 4 segs=`H:MM:SS:FF` / 3=`MM:SS:FF` / 2=`SS:FF` / **1 seg = 生フレーム数**（精度入力の逃げ道）。各 seg を `((H*60+MM)*60+SS)*fps + FF` で合算（桁あふれは自然に繰り上げ）。負数・非数値は拒否（変更なし）。
- **fps 依存**: 同じ `frame` でも fps が変われば timecode 表示は変わる（`setCompFps` は frame を再スケールするので秒は維持される）。ドラッグ（scrub）は従来どおり 1px=1frame で動き、表示のみ timecode。実装: `src/editor/timecode.ts`（純関数）+ `TimecodeScrub`。

```ts
// timeline comp: objects を持つ（続き）
interface TimelineComposition extends CompositionMeta {
  kind: "timeline";
  objects: SceneObject[];   // flat list, id 昇順で直列化。ツリーは parent から導出（§5.4-note）
  // active camera は永続フィールドではない。その frame で「最前面（最大 zOrder）かつ可視」な
  // camera レイヤーを resolve() が自動選択する（§6.5）。手動のプレビュー視点切替は非永続 UI 状態（§17）。
  // 旧 `activeCamera?: ObjectId` はロード時に無視（後方互換・§5 変更 2026-06-25）。
  renderer3d?: "classic" | "advanced";  // 3D レンダラー。省略 = "classic"（§5.4b / §6.5）
}

// html comp: compositions/<id>/ の index.html/style.css/script.js を指す
interface HtmlComposition extends CompositionMeta {
  kind: "html";
  // 実体はファイル。params は script.js の manifest が宣言（§7）
}

interface Project {
  schemaVersion: 1;
  meta: { name: string; createdAt: string; updatedAt: string };
  assets: AssetEntry[];
  compositions: (TimelineComposition | HtmlComposition)[];
  rootComposition: CompId;       // 既定で開く comp
  pluginRefs: PluginRef[];       // plugins/ の有効化リスト
  bins?: ProjectBin[];            // §20.5 仮想フォルダ（省略可）
  treeOrder?: Record<string, ProjectTreeEntry[]>; // §20.5 キー "" = ルート
}

interface ProjectBin {
  id: string;
  name: string;
  parentId: string | null;
}

type ProjectTreeEntry =
  | { kind: "bin"; id: string }
  | { kind: "composition"; id: CompId }
  | { kind: "asset"; id: AssetId };

interface AssetEntry {
  id: AssetId;
  path: string;                  // assets/ 下の相対パス
  kind: "image" | "video" | "font" | "audio" | "other";
  meta?: Record<string, unknown>;
  binId?: string;                  // §20.5 省略 = ルート
}

interface PluginRef { id: string; version: string; enabled: boolean; }
```

### §5.6-canon 正準シリアライズ（確定・INV-4 の基準）

`project.json` は **一意なバイト列**に直列化する。実装非依存（§14 の Rust/WASM も同一バイトを再現でき、差分テストで検証可能）。2 段階で定義する。

**(a) データ正規化（順序・直列化前）**
- **集合配列は id 昇順にソート**: `objects` / `assets` / `compositions` / `pluginRefs`。配列順に意味を持たせない（描画順は `zOrder` が持つ、§5.4-note）。
- **意味順を持つ配列は並べ替えない**: `components`（重なり順が意味）、`effects`（適用順が意味・§5.5b/§27）、各 `AnimatedProp.keyframes`（`frame` 昇順を維持）、**`treeOrder` 各配列**（§20.5 Project Bin のユーザー並べ順）。
  - `SceneObject.effects` / `SceneObject.isAdjustment` / `SceneObject.adjustmentMode` / `SceneObject.isNull` は **optional**。`effects` は空（無し）なら**キーごと省略**、`isAdjustment` / `isNull` は `false` なら省略、`adjustmentMode` は既定 `"live"` なら省略し `"raster"` のときだけ書く（(b) の optional 規則）。これによりエフェクト未使用、および既存 `isAdjustment: true`（live 相当）の project.json は **byte 等価のまま**（INV-4・回帰なし）。`EffectInstance.id` は ULID（INV-6）、`props` は component props と同じく正準化対象。
- 文字列は **Unicode NFC** へ正規化。

**(b) バイト直列化（RFC 8785 / JSON Canonicalization Scheme を基礎）**
- **オブジェクトのキーは UTF-16 code unit 順に再帰ソート**（読みやすさより実装間一致を優先＝`id` が先頭に来るとは限らない）。
- **数値は ECMAScript `Number.prototype.toString` 準拠の最短往復表現**（`JSON.stringify` の数値出力と一致）。`Frame` 等の整数は整数表記。`-0`→`0`。`NaN`/`Infinity` は不正（書き込み前に検証してエラー）。
- 文字列は UTF-8、必須制御文字のみエスケープ。**非 ASCII は生 UTF-8 のまま**（日本語のオブジェクト名を `\uXXXX` にしない）。
- **不在の optional フィールドはキーごと省略**（`null` を書かない）。空配列/オブジェクトは `[]` / `{}`。
- **可読化（git diff 用）**: JCS は本来 minify だが、本仕様では **2-space indent・`": "` 区切り・改行 LF・末尾改行 1 個**で pretty-print する。空白規則を固定しているので一意性は保たれる。

> 補足: `AnimatedProp` の浮動小数は **保存される値＝ユーザが入力/ドラッグした authored 値**（`resolve()` の計算結果は保存しない）なので、上記で byte 等価は成立する。float jitter による差分 churn が気になる場合のみ、保存前に固定桁（例 6 桁）へ丸めるオプションを足してよい（lossy、必須ではない）。

**マイグレーション**: load 時 `schemaVersion` が現行未満なら、登録済み migration を順に適用して昇格する。現行より新しい（未知の）バージョンは破壊リスクを避けるため **読み込みを拒否**し、その旨を表示する。

---

## §6. 座標・時間モデル

### §6.1 時間
- 正準時間 = 整数 frame（INV-5）。`fps` は CompositionMeta が保持。秒は `frame/fps` で導出。
- オブジェクトは `inPoint <= frame < outPoint` かつ `enabled` のときのみ描画。
- **キーフレームの frame は comp 絶対 frame**（inPoint 相対ではない）。

### §6.2 座標系・単位（確定）
- **原点は左上、+x 右 / +y 下 / +z 手前（カメラ方向）。** 単位は position/anchor=px、rotation=degree、scale=倍率（1=100%）、opacity/gain=0..1。
- **anchor は回転・スケールのピボット**。`position` は親空間における anchor の配置先。

### §6.3 Transform 合成（確定・preview≡export の核）
ローカル変換は次の順で合成する（列ベクトル、左から掛ける）:

```
L = T(position) · R(rotation) · S(scale) · T(-anchor)
```
- `R` の euler 適用順は **Z·Y·X**（degree）。
- world 変換は **親から子へ** `W_child = W_parent · L_child`（root は `W = L`）。
- `resolve()` がこの world 行列（`Mat4`）を各オブジェクトに焼き込む（§5.4-note / §8）。DomRenderer は `matrix3d(W)` をそのまま適用、`transform-origin: 0 0`（anchor は行列に内包済み）。

### §6.4 補間（確定）
- scalar / vec は成分ごとに線形補間し、区間の `easing`（§5.3）で時間を再マップ。
- **color は straight-alpha のまま sRGB 成分ごとに線形補間**（linear-light 化はしない）。
- **rotation は euler 成分ごとに線形補間**（slerp はしない。2.5D で十分）。
- **端の外挿**: 最初の KF より前は最初の値、最後の KF より後は最後の値で **hold**（clamp）。

### §6.5 3D / Camera（確定）
- **アクティブカメラ選択（AE 準拠・確定 2026-06-25）**: コンポ映像（preview / browser export / headless export すべて）に使うカメラは**手動固定しない**。`resolve(comp, frame)` がその frame で **`enabled && inPoint <= frame < outPoint`（= `isVisible`）を満たす camera component 持ちレイヤーのうち最大 `zOrder`（最前面）**を自動選択する。タイは id で安定化。**該当が 1 つも無ければカメラ無し＝デフォルト視点**（`scene.camera` を設定しない＝正射影）。純関数のまま（INV-1）で preview/export が一致する（INV-2）。
  - **プレビュー視点 override（非永続・エディタ専用）**: AE の 3D View ポップアップ相当。`ResolveContext.previewCamera?: ObjectId | "default"` で、エディタのビューポートだけ任意カメラ（`ObjectId`）／デフォルト視点（`"default"`）に切り替えられる。**export / bundle / nested comp は常に override を渡さない**ため出力は上記の自動選択で決定論的（INV-2 を破らない）。override は Zustand の ephemeral 状態で `project.json` に書かない（§17）。
- DOM レンダラは root に `transform-style: preserve-3d`。dom モード 3D の前後関係はブラウザが z 深度で合成（§5.4b）。
- **active camera あり**: `perspective = (compHeight/2) / tan(fov/2)` [px] と `perspective-origin: 50% 50%` を **root に設定**する。**ビュー変換（camera world の逆）は root には掛けず、各 3D レイヤーの行列に焼く（per-object）**。理由 = CSS `perspective` は**その要素の子孫**の 3D 変換にのみ効くため、view を root（perspective と同一要素）に置くとカメラ Z が平面適用され dolly/zoom が効かない（実測確定・§6.5b）。
  - 3D レイヤー（`threeD=true`）の DOM 変換 = **`translate(cx, cy, P) · view · worldTransform`**（`P=perspective=zoom`、`cx,cy=comp 中央`）。`translate(cx,cy,P)` は XY 再センタリング＋深度補正で、既定カメラ（cameraZ=zoom=P）を等倍 neutral にする。dolly: `scale=P/(cameraZ−z)`、zoom: `scale=P/cameraZ`。
  - **2D レイヤー（`threeD≠true`）はカメラ免除**: 素の `worldTransform`（premultiply しない）。z=0 のため root perspective を受けず平面描画＝AE 同様「2D 層はカメラを無視」（§5.4b）。
  - 正準 `viewMatrix`（`scene.camera.viewMatrix`）は純粋なまま（INV-3）。`translate(cx,cy,P)` は CSS リグ固有の renderer 詳細で、将来 GL は projection 行列が深度補正を担う。
- **active camera なし**: `perspective` を設定しない（**正射影**）。z は描画順の tie-break と将来の被写界深度のためだけに保持され、見た目の遠近は付かない。
- Blender camera import（将来）は、この `camera` オブジェクトの keyframe を埋めるだけで済む（IO plugin、§12/§16）。

#### §6.5b カメラモデル（AE 準拠・確定）
- **ワンノード / ツーノード**（`cameraType`）:
  - `one-node`: 向きはカメラ Transform の rotation/Orientation。view = invert(camera world)。
  - `two-node`: 常に `pointOfInterest`（comp/world 空間の注視点）を向く（auto-orient）。view = `lookAt(eye, pointOfInterest, up)`（[mat4.lookAt]）。`eye` = カメラ world 位置、`up = (0,1,0)`（真下視で view が one-node の `invert(translate(eye))` と一致し X/Y 反転しない）。新規作成の既定。
- **fov の導出**: タイムライン可変プロパティは `zoom`(px)。`fov_vertical = 2·atan((compHeight/2) / zoom)`。Camera Settings の `focalLength`(mm)/`filmSize`(mm) は `zoom = focalLength · (compHeight / filmSize)` で相互導出（AE と同式）。旧 `fov` のみのカメラは `zoom = (compHeight/2)/tan(fov/2)` で後方互換。
- **projection 行列**（§8 / WebGL 経路）: `perspective(fov_vertical, width/height, near, far)`（[mat4.perspective]、NDC z∈[-1,1]、Three.js 互換）。dom モードは CSS perspective で等価表現。
- **dom / raster3d とカメラ共有**（§5.4b）: dom（CSS preserve-3d）と raster3d（共有 WebGL シーン）は**同一カメラ**を共有する。view は両経路で一致、projection は GL 経路が上式、dom 経路は CSS perspective。これにより dom の cube と raster3d の cube が画面上で一致する。
- **境界制約**: 共有 WebGL シーンは 1 枚の `<canvas>`（= z スタック上の 1 要素）。dom 層 ↔ GL 層の交差はペインター級のまま、GL 層（raster3d）同士・GL 内メッシュは per-pixel で真の交差（§5.4b）。
- **2D 免除（確定・実装済み）**: per-object 方式により、3D レイヤー（`threeD=true`）のみカメラ/dolly/zoom に応答し、2D レイヤーは画面に固定（AE 準拠）。Phase 1.1 で実測確定（dolly 半距離→2.0倍/倍距離→0.5倍、zoom 望遠2倍/広角0.5倍、2D 不動）。two-stratum 分離は不要だった（per-object 焼き込みで特異点が出ないため）。
- **被写界深度**（Phase 3）: `focusDistance`/`aperture`(F値)/`blurLevel`。GL bokeh パスが主、dom 経路は per-layer blur 近似。

#### §6.5c geom3d（text 3D 押し出し）のカメラ整合（P2 実 MVP 投影・確定 2026-07-14）

> §5.5f の押し出しメッシュは per-layer 素の WebGL canvas で描画される。本節で言う comp のアクティブカメラ（§6.5 冒頭）を
> **実際に消費する**（`raster3d` 共有シーン §6.5b とは引き続き別系統・別 GL コンテキスト）。

- **実装（P2）**: geom3d は comp のアクティブカメラ・`Transform.rotation` を含む `worldTransform` を GL に実投影する。
  `mvp = Proj·cameraPre·worldTransform`（`cameraPre` は §6.5a の `translate(cx,cy,P)·view` を `DomRenderer` から再利用、
  `Proj` は同じ CSS `perspective` リグを pixel-space で数式再現）。`Transform.rotation` に応じてメッシュ自体が GL 内で
  回転し per-pixel parallax が出る（旧 P1 の「平面カードを CSS で傾けるだけ」を解消）。
  法線は `normalMatrix(worldTransform)` で world 空間へ運び、`geomLightDir`（comp/world 空間の平行光）と内積するため、
  回転させると陰影が正しく面を横断する。
  3D-extrude text の `entry.div` は CSS `matrix3d` 傾けを**適用しない**（GL の `mvp` が投影を一手に担うため）。
  canvas は comp 全域を `devicePixelRatio` 解像度で覆う（per-object の AABB クロップ最適化は次フェーズ）。
- **中立性**: camera 無し・回転無し・`depth=0` は既存 2D 描画とスクリーン位置/サイズが一致する（実機 verify 済み）。
- **既知のギャップ（次フェーズ）**: ネスト comp（`renderNestedComp`）内の 3D-extrude text は本リビジョンの対象外
  （nested cameraPre が `DomRenderer` インスタンスの `this` に保持されないため未配線・従来の CSS 傾け近似のまま）。
  per-object 方式のため 3D レイヤー同士の**真の相互貫通**は非対応（レイヤー間合成は既存 z-order）。

---

## §7. Composition 実行モデル（HTML Composition = Model A）

**MVP は Model A（不透明）で確定。** engine は HTML comp の外側で Transform/Opacity を動かすのみ。内部 DOM 要素を個別に Object へ昇格させること（Model B）は §16 将来。

HTML comp は `compositions/<id>/script.js` から `CompositionModule` を default export する。

```ts
interface CompositionModule {
  manifest: {
    id: string;
    resolution?: { w: number; h: number } | "inherit";
    params: ParamDescriptor[];      // ここで宣言した params が timeline 上で keyframe 可能になる
  };
  mount(root: HTMLElement): void;     // 一度だけ。DOM 構築
  render(ctx: CompRenderContext): void; // 毎フレーム。決定論であること (INV-1)
  unmount?(): void;
}

interface CompRenderContext {
  root: HTMLElement;
  frame: number;       // host object 相対。= hostFrame - host.inPoint、[0, comp.duration) にクランプ
  time: number;        // frame / fps
  fps: number;
  width: number; height: number;
  params: Record<string, unknown>;  // keyframe/expression 解決済みの値
}
```

- **内部時間（確定）**: comp に渡る `frame` は **host object の inPoint を 0 とする相対 frame**（`hostFrame - host.inPoint`）。`[0, comp.duration)` にクランプ。これで trim とタイムライン上の配置移動が直感どおりに効く。
- **params 束縛（確定）**: host component の各 param 値（keyframe/expression 解決済み）を、manifest の `ParamDescriptor.key` と**キー一致**で `ctx.params` に渡す。`kind` と host 側 `AnimatedProp<T>` の型は load 時に検証し、不一致は警告のうえ default を使う。

- **隔離方式（MVP）**: 各 HTML comp は **Shadow DOM root** にマウントしスタイルを隔離。シーン内では通常の DOM 要素として engine の CSS-3D transform 配下に置かれる（iframe ではなく Shadow DOM を採るのは、headless export 時に 1 回の full-page screenshot で全 comp を撮るため。§11/§18-2）。
- **JS 実行（MVP）**: comp の JS はページの JS コンテキストで動く（trusted-author 前提）。fake FS 上の `script.js` のロード手段は **§11.3 の module loader** に従う。**ハードサンドボックス（iframe sandbox / worker / CSP）は §16 のセキュリティ硬化として明示的に将来送り。** 第三者 comp/plugin を信頼境界越しに動かすのは MVP の想定外。

---

## §8. レンダラ抽象化

`resolve()`（純粋・レンダラ非依存）と `Renderer`（出力）を分離する。

```ts
// engine core。純関数。WASM 差し替え対象 (§14)
function resolve(comp: TimelineComposition, frame: Frame): ResolvedScene;

interface ResolvedScene {
  width: number; height: number;
  camera?: { fov: number; viewMatrix: Mat4 };   // camera world 変換の逆（§6.5）。無ければ正射影
  objects: ResolvedObject[];   // zOrder 昇順でソート済み（フラット・兄弟）
}
interface ResolvedObject {
  id: ObjectId;
  worldTransform: Mat4;        // parent チェーンを畳んだ world 行列（§6.3）。ネストしない
  zOrder: number;              // 描画順
  opacity: number;             // per-object。親から継承しない
  components: ResolvedComponent[];
  inPoint: Frame;              // この comp 内での表示開始（§28.10 per-layer cache の local frame 算出用 passthrough）
}

type Mat4 = [number, number, number, number,
             number, number, number, number,
             number, number, number, number,
             number, number, number, number]; // column-major

interface Renderer {
  readonly kind: "dom" | "canvas2d" | "webgl" | "webgpu";
  mount(container: HTMLElement, comp: CompositionMeta): void;
  renderFrame(scene: ResolvedScene, frame: Frame): void;  // INV-3
  resize(w: number, h: number): void;
  dispose(): void;
}
```

- **MVP は `DomRenderer` 1 本のみ実装。** HTML comp が主役である以上、DOM/CSS が最も整合する。各 `ResolvedObject` を root の**兄弟** div として生成し `transform: matrix3d(worldTransform)` + `opacity` + `zOrder`→`z-index`、root に `preserve-3d`。ネストしないので opacity 合成も stacking context 閉じ込めも起きない（§5.4-note / §6.3）。
- `Canvas2DRenderer / WebGLRenderer / WebGPURenderer` は同インターフェースで将来追加（§16）。これらは HTML comp を扱えない or ラスタ化が必要なので、対応 component 型に制約が付く点を将来仕様で明記する。

> **`@mafter/runtime`（INV-7・M1 で境界を切る）**: `resolve` / Renderer / module loader（§11.3）/ expression engine（§9）/ 再生クロックは、エディタ（React/状態管理/UI）から独立した**単一ライブラリ**に括り出す。これを 3 者が共有する: ①エディタ preview（runtime + 編集 UI）②video exporter（runtime + frame ステップ + encoder）③web bundle player（runtime + 音声クロックのみ、§11.7）。**M1 着工時にこの境界を設計する**こと（後から剥がすのは高コスト。今なら設計だけでタダ）。bundle player は実質「runtime + `audioClock → frame → resolve → renderFrame`」の薄いラッパ。

---

## §9. エクスプレッション評価エンジン

- ファイル: `scripts/<objectId>/<param>.js`。`param` の既定粒度は **per-property**（例 `position.js` は Vec3 全体）。`transform.position.x.js` のような **per-axis 指定も可**。
- 既定でこのパスを読み込む。`ExpressionRef.path` で別ファイルを指定可。
- 各ファイルは **純関数を default export** する:

```ts
export default function (ctx: ExprContext): T { return ctx.value; }

interface ExprContext {
  frame: number;
  time: number;               // frame / fps
  fps: number;
  value: T;                   // expression 適用前の値（keyframe/static 解決値）
  thisObject: ExprObjectView; // 自オブジェクト
  comp: ExprCompView;         // comp.duration / comp.size / comp.object(idOrName)
  // 決定論 helpers のみ (INV-1)
  random(seed?: number): number;          // seeded。Math.random は禁止
  wiggle(freq: number, amp: number, seed?: number): T;
  linear(t: number, tMin: number, tMax: number, vMin: number, vMax: number): number;
  ease(t: number, tMin: number, tMax: number, vMin: number, vMax: number): number;
  clamp(v: number, lo: number, hi: number): number;
  lerp(a: number, b: number, t: number): number;
}

// オブジェクト参照は既定で local 値。world/comp 空間は明示変換で取得する。
interface ExprObjectView {
  position: Vec3; rotation: Vec3; scale: Vec3; anchor: Vec3; opacity: number; // local
  param(componentType: string, key: string): unknown;
  toWorld(p: Vec3): Vec3;   // local 点 → comp 空間
  toComp(p: Vec3): Vec3;    // alias
}
```

- **禁止**: DOM/network/`Date.now`/`Math.random`/副作用。実行は §11.3 の module loader でロードし、凍結した `ctx` を渡して呼ぶ。
- **戻り値型**: プロパティの型（scalar/Vec3/…）と一致必須。不一致は型強制せずエラー扱い（下記フォールバック）。
- **実行時例外・型不一致のフォールバック（確定）**: 評価が throw または不正型を返したら、そのフレーム・そのプロパティは **`ctx.value`（expression 適用前の値）にフォールバック**し、エラーをそのオブジェクトに紐づけて表示する。**レンダリング全体は止めない**（INV-1/INV-2 の決定論は維持）。
- **参照空間（確定）**: `comp.object(x).position` 等は **local 値**。world/comp 空間は `toWorld()/toComp()` で明示取得（§9 の `ExprObjectView`）。
- **MVP は main thread 実行**（反復速度優先）。worker offload は §16。
- **相互参照**: 依存グラフを frame ごとにトポロジカルソートして解決。循環はプロジェクトエラーにする。
- **Inspector プリセット（散文・Phase 0.5）**: `SceneObject.expressionPresets[]` にインスタンス（`presetId` / `enabled` / `props`）。UI は Effect 同型（+追加・disable・×・param scrub/KF）。脚本は共有 FS パス `presets/expressions/<presetId>.js`（write-if-absent）。評価時 `ctx.presetParams` に frame 解決済み props を注入。legacy `scripts/<objectId>/` + `@mafter:preset` は読取互換（開いただけでは project を書き換えない）。

---

## §10. イージング / Flow 的プリセット

- データモデルは §5.3。区間（KF→次 KF）ごとに `cubic-bezier(x1,y1,x2,y2)` を保持。`hold`/`linear` は特例。
- `presets/easing/<id>.json` に named preset を保存:

```json
{ "id": "snappy-out", "label": "Snappy Out", "bezier": [0.2, 0.9, 0.1, 1.0] }
```

- **ビルトイン UI**: キーフレームを複数選択 → プリセット適用 = 選択 KF の `easing` を上書きする操作として定義。プリセットの新規作成 = 現在の bezier ハンドルを `presets/easing/` に保存。
- Flow 互換のカーブエディタ（速度グラフ）は MVP では値グラフ cubic-bezier のみ。速度グラフ表示は §16。

---

## §11. FileSystem 抽象 と Export

### §11.1 FileSystem

```ts
interface FileSystem {
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  write(path: string, data: Uint8Array | string): Promise<void>;
  list(dir: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  delete(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}
```

- `IndexedDbFs`（ブラウザ MVP）: path 文字列 → blob を keyval ストアに格納、prefix クエリで list。
- `NodeFs`（アプリ版）: 実 FS。
- **INV-4**: 両者は同一フォルダ構成を生成。`exportZip()` は FS を走査し同一パスで zip 化（JSZip）。`importZip()` は逆。
- アセット blob は IDB に格納。**容量制限/eviction は実害になり得る**ため注記。大規模アセットは OPFS への移行を §16 で検討。
- **preview 起動最適化（2026-07, preview-rendering-pipeline-optimization-plan）**: `ImageAssetCache` の動画デコード（`decodeVideoEntry`）は非同期で、Blob 構築を Web Worker（`videoBlobDecode.ts` / `videoBlob.worker.ts`）へオフロードする。`URL.createObjectURL` は worker 発行の `blob:` URL が `<video>` から参照できないため必ずメインスレッドで呼ぶ。`url`/`size` の中身・戻り値の意味は不変（INV-2）。`IndexedDbFs` に `readBatch(paths): Promise<Map<string, Uint8Array>>`（単一 readonly トランザクションで一括取得、IndexedDbFs 固有・`FileSystem` インターフェース非拡張）を追加。`ImageAssetCache.loadFromProject` は起動時 comp が参照する asset を先に読む `priorityAssetIds` オプションと、N 件ずつのバッチ + バッチ間 `requestAnimationFrame` yield でロードする（ロード順序のみの変更、`byId`/`byPath` の最終内容・project.json 直列化とは無関係）。`deserializeProject`（serialize.ts）は `Uint8Array | string` を受理し、`Uint8Array` はモジュールスコープの `TextDecoder` で直接デコードする（`readText` の中間 string を経由しない）。`serializeProject` の出力形式は不変。

### §11.3 FS → module loader（確定）

expression / HTML comp の `script.js` / plugin entry は、すべて fake FS 上の JS。IDB のパスは直接 `import()` できないため、共通の loader を 1 個立てる:

1. `fs.readText(path)` でソース取得。
2. `new Blob([src], {type:"text/javascript"})` → `URL.createObjectURL` → **dynamic `import(blobUrl)`** で ES module として評価し、`default` を取り出す。`URL.revokeObjectURL` で後始末。
3. comp/plugin 間の相対 import が必要なら import map か事前バンドル（MVP は単一ファイル前提、複数ファイルは §16）。

- expression のように頻繁・大量に評価する純関数は、初回 import で得た関数を **キャッシュ**して毎フレーム呼ぶ（再 import しない）。
- アプリ版（NodeFs）は通常の dynamic import に置換可能。**入出力（path → default export）契約は同一**に保つ。

### §11.2 Export（MVP: browser best-effort を含む）

2 経路、同じ `resolve()` → `DomRenderer` パイプラインを共有:

- **browser best-effort（MVP / M3）**: rAF ではなく **決定論的に frame をステップ**し、各 frame を DOM に描画 → ラスタ化。
  - DOM→raster: SVG `<foreignObject>` シリアライズ → `<img>` → `drawImage` → canvas。
  - エンコード: **WebCodecs `VideoEncoder` を第一候補**（webm/mp4）、フォールバックで **PNG 連番 + ffmpeg.wasm**。gif も連番から生成可。
  - 既知の忠実度制約を export ダイアログで警告: クロスオリジン画像、`backdrop-filter` 等一部 CSS、フォント埋め込みの要否。
- **headless canonical（§16 / 早期推奨, M3.5）**: Puppeteer/Playwright が **同じアプリ**を headless Chromium で開き、`?frame=N&export=1` でフレーム送り → full-page screenshot → ffmpeg。実ブラウザエンジンなのでピクセル完全。

```ts
interface ExportConfig {
  range: [Frame, Frame];
  fps: number;
  scale: number;                 // 解像度倍率
  format: "mp4" | "webm" | "png-seq" | "html-bundle";
  alpha: boolean;                // 透過（webm/vp9 alpha or png-seq）
  textRenderMode?: "precise" | "draft"; // §26.7。未指定時 precise
  bundleLoop?: boolean;          // html-bundle のみ。未指定時 true
  /** 映像エンコード品質プリセット。未指定 = "high"（bitrate 8_000_000・現行互換）。mp4/webm / bundle bake のみ。 */
  videoQuality?: "low" | "medium" | "high" | "max" | "custom";
  /** bps。`videoQuality === "custom"` のとき使用。clamp 50_000..50_000_000。未指定 custom は 8_000_000。 */
  videoBitrate?: number;
  /**
   * WebCodecs `latencyMode`。未指定 = フィールドを渡さない（ブラウザ既定・現行互換）。
   * "quality" = 画質優先 / "realtime" = 速度優先。
   */
  encodeLatencyMode?: "quality" | "realtime";
}
```

- **映像品質プリセット（確定）**: `low`=1 Mbps / `medium`=4 Mbps / `high`=8 Mbps（既定）/ `max`=20 Mbps / `custom`=`videoBitrate`。未指定フィールドは現行どおり 8 Mbps・`latencyMode` 未設定。ピクセル解決（`resolve` → raster）は不変で、変わるのは WebCodecs エンコード段のみ（INV-2 の scene 一致は維持）。
- **成功条件はここ（M3）で満たされる**: browser best-effort で 5 秒尺を webm/mp4/連番に書き出せれば「アーティストが公開できる」が成立する。
- **音声の mux（確定）**: 映像フレームを決定論ステップで描き終えた後、`audio` レイヤ群を各自の `trimStart`/タイムライン配置と `gain` に従って **ffmpeg で mux**（png-seq/webm/mp4 へ）。音声はフレームステップせず元ソースをオフセット合成する。

### §11.2b Pre-render（editor-only）

編集の軽量化・表現の確定・低 bitrate のエンコード表現をタイムラインに固定するための操作。**INV / `project.json` 直列化規則は非変更**（既存の `enabled` / `locked` / video asset / `zOrder` のみ）。

1. アクティブ timeline comp を §11.2 と同じ `ExportConfig` で **mp4 / webm のみ**エンコードする（現状の見た目そのまま＝ロック層も含めて焼く）。
2. 書き出し blob を `assets/<ulid>.mp4|webm` に書き、`project.assets` に video として登録する。登録先は Project パネルのルート直下フォルダ **`pre-rendered`**（無ければ作成。既存なら再利用。`asset.binId` + `treeOrder`）。
3. **ロックされていないレイヤー**をタイムライン全体で `enabled=false`（§21.11 の一括非表示と同契約。ロック済みの `enabled` は変えない）。
4. コンポ **最上段**（`nextZOrder`）に video レイヤーを置く（`fit: "fill"`、`inPoint`/`outPoint` = export `range`）。
5. 上記 2–4（フォルダ作成含む）は **1 command / 1 undo**（label: `"Pre-render"`）。ファイルダウンロードはしない。
6. UI 既定: format=mp4、`videoQuality: "max"`（実用上の劣化最小。ロスレス容器は video レイヤー化できないため非対応）。ガビガビ表現時は Low / Custom に下げる。
7. ロックしたまま残したレイヤーに音声があると、焼き込み音声と二重になり得る（ユーザー責任。自動ミュートしない）。
8. PNG-seq フォールバック時は Pre-render 失敗（video asset 化できない）。

### §11.4 video コンポーネント（MVP / best-effort）

- `video` は `asset(video)` を参照し、表示フレームのソース時刻 = `(frame - host.inPoint)/fps + trimStart/fps`。
- **asset メタ**: 動画 import 時に 1 回 probe して `asset.meta`（`width`/`height`/`duration`/`mime`）に記録する（image / audio と同型の任意 meta フィールド。§5 スキーマ非変更）。`duration` はタイムラインのソース尺マッピング（§21.3）とレイヤー追加時の既定 `outPoint` に使う。
- 描画は `<video>` を対象時刻に **seek** して DomRenderer の対象 div に合成。ブラウザの seek はフレーム精度が不安定なので **`requestVideoFrameCallback` で実フレーム到達を待ち、許容誤差を明記**（browser export は best-effort）。
- **canonical な完全一致は headless 経路（§16, M3.5）で担保**。INV-2 は「ソース時刻のマッピング＝決定論」を満たし、実デコードフレームの差はラスタ忠実度の範囲とする。
- **video 内蔵音声（best-effort・基本再生）**: 音声トラック付き video の内蔵音声を鳴らす。`video` は `gain: AnimatedProp<number>`（0..1, 既定 1, keyframe 可）を持つ（§5.5）。`audio` と同じ `sampleGain(gainProp, frame)` を全経路で共有する（INV-2）。
  - **preview / HTML bundle player**: 再生中（`previewVideoPlayback`）のみ `<video>` をアンミュートし、ネイティブ A/V 同期に委ねる。スクラブ・停止・warm-up・export フレームステップは `muted=true`（決定論・オートプレイ制約の両立）。音量は `resolve()` 済みの `props["gain"]` を `video.volume = clamp(gain,0,1)` に毎フレーム反映する。`resolve()` は video の `gain` に §11.5.2 の自動フェード（declick）エンベロープを乗算済みで返すため、要素ベースの音量制御でもカット端のポップが軽減される（best-effort・サブフレーム精度は要素の `volume` 粒度に依存）。
  - **export**: video レイヤーの内蔵音声も §11.2 の mux 対象。`audio` レイヤーと**同一のタイミング式**（`inPoint`/`outPoint`/`trimStart`）で `decodeAudioData`→`OfflineAudioContext` に追加合成し、`gainProp` を §11.5 のフレーム刻み automation で `GainNode` に打つ。decode 失敗（無音動画・非対応コンテナ）は best-effort でスキップ。
  - **既知の制約**: 複数 video が同時再生するとブラウザが音声を自動ミックス（個別 volume は効くがミキサー側のクリッピングはブラウザ依存）。`audio` レイヤーと内蔵音声付き video の併用時、映像クロックは `PreviewAudioClock`/`BundleAudioClock`、video 音声はネイティブ再生で、大きなドリフト時のみ既存 resync が働く（best-effort）。mixing graph は §16 将来。
- **warm-up（再生レイテンシ回避・非直列化）**: §11.5 音声プリロードと対になる前倒し。preview / HTML bundle player は、編集中 comp の enabled video レイヤーを **idle 中（`requestIdleCallback`）に `<video>` を現フレームのソース時刻へ seek + decode（loadeddata 相当）まで warm-up** し、`assetId@frame` 粒度で primed 状態を共有キャッシュに記録する（多重 prime は inflight 去重）。再生開始時、全 video が warm-up 済みなら遅延ゼロで開始し、未完了の video がある場合のみ短時間（best-effort 上限）prime を待ってから再生する＝開幕の「他レイヤーは即描画されるが動画だけ遅れて登場」を防ぐ。warm-up は present（`requestVideoFrameCallback`）待ちをせず、再生ループは従来どおり軽量（毎フレーム seek しない）。**warm-up は preview/bundle player 専用で、export 経路（決定論 seek + `requestVideoFrameCallback` の present 待ち）は一切変更しない（INV-2 非干渉）。** warm-up 失敗は best-effort（再生開始時に再試行）で、Footage 削除時に primed 状態を破棄する。
- **preview 再生の映像×タイムライン双方向同期（非直列化）**: preview 再生は映像とタイムライン（カメラ／他レイヤー）のどちらも先行しすぎないよう双方向ゲートする。Play 押下時に全マウント video を現フレームへ再同期（primed キャッシュ非依存・既に半フレーム以内かつ data ready なら seek しない）してから `play()` を発火し clock を起動する。再生中 `error = mafterTargetSec − currentTime` について: **映像遅れ**（`error` が 1 フレーム超）→ frame 進行を保留（video は play 継続）。**映像先行**（`error` が −1 フレーム未満）→ video を `pause`（タイムラインは進行継続・**seek しない**）。解除は半フレームヒステリシス。遅れゲートが先行ゲートより優先（複数 video でデッドロックしない）。各ゲート連続 1 秒で強制解除。再生中 drift seek（0.5s 閾値）は不変（旧 HW スタッタ対策）。ended / error / duration 超えは判定除外（sync pause 中の `paused` は lead 計測のため適格）。HTML bundle player は Play barrier のみ。**export / scrub は本機構を通らない（INV-2）。** `currentTime` はメディア時計であり present 済み画素そのものではない（best-effort）。
  - **presented frame 基準の playbackRate サーボ（WP-2）**: 上記の双方向同期ゲートは大誤差時の failsafe とし、通常の preview / HTML bundle playback では `requestVideoFrameCallback` の presented `mediaTime`（取得不能なら `currentTime`）を映像時計として `error = mafterTargetSec - presentedSec` を測る。`|error| <= 0.25 frame` はデッドバンド、外側は `playbackRate` を 0.96〜1.04 の範囲で連続補正して drift を戻す。`holdTimeline` / `pauseVideo` は `|error| > 5 frames` の場合だけ発火する failsafe で、解除ヒステリシスと連続 1 秒の強制解除は従来どおり。rate 補正は `previewVideoPlayback` 中だけ有効で、停止・scrub・export frame-step では必ず `playbackRate = 1` へ戻す（INV-2 非干渉）。
  - **カット境界の `<video>` 要素再利用（デコードギャップ回避）**: 同一動画を分割して連結したタイムライン（隣接レイヤーが同一 `asset` を参照）では、カット境界でレイヤー（object id）が入れ替わる。DomRenderer の reconcile が離脱レイヤーの `<video>` を破棄し入場レイヤーに新規 `<video>` を生成すると、新要素のロード＋デコードが境界フレームに間に合わず**数フレーム空フレーム（映像のちらつき）と内蔵音声の再初期化（プチノイズ）**が出る。これを防ぐため、DomRenderer は離脱した `<video>` を破棄せず **`assetId` 単位の要素プール**へ退避（DOM から外すが参照・`src`・デコーダ状態を保持し、**再生は止めない**）し、入場レイヤーが同一アセットなら**プールの要素を再利用**する（src 同一のため再ロード・再デコード不要・現在時刻から映像も内蔵音声もシームレスに継続）。**退避時に `pause`/`mute` しないのが要点**: 同一フレームで再利用される要素を止めると内蔵音声が一瞬ミュート→再 seek→再 play で「音量が急落→急上昇」（ぶつ切り）になる。`<video>` は DOM から外しても再生継続する仕様を利用し、入場処理（reconcile の add パス）の後に**再利用されず残ったプール要素だけを `pause`+`mute`**（遅延静音）して離脱クリップの音漏れを防ぐ。同一アセットの2レイヤーが同フレームに同時存在（クロスディゾルブ等）する場合はプールが空になり新規生成へフォールバックする（要素の重複利用はしない）。この再利用は **preview / HTML bundle player 専用**で、export 経路は要素インスタンスが変わっても `waitForVideoFrame`/`flushVideoFrames` がデコード完了を待つため決定論は不変（INV-2 非干渉）。再利用直後（カット境界を跨いだフレーム）の resync 要否は、`currentTime` と target の差（再生 decode lag を含み常態で半フレームを超える）ではなく**前フレーム target からのソース読み出し位置の連続性**で判定する: target の軌道が連続（半フレーム以内）なら decode lag があっても seek せず映像・内蔵音声の連続を維持し、trim-in がずれた再取得のみ半フレーム精度で seek する。
  - **異なるアセット間カット境界の先読み warm-up**: 上記プール再利用は**同一アセットの連結カット**では有効だが、**異なるアセット同士の境界**では入場側のプールが空のままになり、境界フレームで新規 `<video>` 生成→デコード未完→数フレーム空白が残る。preview / HTML bundle player の**再生中**、in 点が近い（既定 ≈1 秒以内）enabled video レイヤーについて、in 点の trim 時刻へ offscreen で `<video>` を先行生成し `primeVideoElement`（loadeddata 相当）で decode 済みにしてから **`assetId` 単位プールへ stash** する。カット到達時に入場 reconcile が `acquire` すればコールドスタートを避けられる。判定は comp 内 video クリップ一覧と現フレームから純関数で upcoming 集合を求め、**現表示中と同一 assetId の upcoming は除外**（連結カットは退避再利用で足りる）。再生停止・scrub（`previewVideoPlayback=false`）・dispose では先読み要素だけをプールから除去して `src` 解放しリークしない。export 経路（`exportVideoStep` / `waitForVideoFrame` / `flushVideoFrames`）は触らない（INV-2 非干渉）。
  - **ループ再生の折り返し warm-up / 交代**: loop ON の preview / HTML bundle player では、playhead が `loopEnd` 手前 1 秒（`fps` フレーム）以内に入った時点で、`loopStart` 時点に active な video クリップ（`inPoint <= loopStart < outPoint`）を `targetSec = (trimStart + (loopStart - inPoint)) / fps` へ offscreen warm-up し、`assetId` 単位プールへ stash する。折り返しフレームで描画 frame が後退し、かつ現在 frame が `loopStart` と一致する場合は、通常のカット境界と同じくプール済み要素へ交代し、旧要素を mute/pause してから新要素を playback 経路で unmute/play する。プールに data ready な要素が無い場合は従来どおり同一要素の大ジャンプ seek にフォールバックする。これは preview / bundle live 再生専用のレイテンシ回避であり、scrub / export の決定論 seek 経路には影響しない（INV-2 非干渉）。

### §11.4b video footage quality（プロキシ・映像/音声分離）— Phase 1: 基盤

全 `video` コンポーネントに **画質ティア（`footageQuality`）** を持たせ、編集・プレビュー・書き出しで使う**映像ファイル**を切り替える。重い実写や高解像アニメ素材を軽いプロキシで編集し、最終書き出しだけ原本に上げる用途（AE の Proxy / Render Quality 相当）。

**§5 スキーマ非変更**: 本機能はすべて既存の freeform フィールドに載せる。新規 TS 型・INVARIANT・正準シリアライズ規則は追加しない。

- **レイヤー prop**: `video.footageQuality`（enum, 既定 `"original"`, 非 animatable）。component props は freeform（§5.5）なので型変更なし。未設定の既存 project.json は `"original"` フォールバックで挙動不変（後方互換）。
- **ティアと UI グループ**（[`footageQuality.ts`](src/runtime/footageQuality.ts)・英語ラベル v1）:

  | グループ | tier 値 | friendly ラベル |
  |----------|---------|------------------|
  | Source | `original` | Original |
  | Editing | `high` / `medium` / `low` | High / Medium / Low |
  | Performance | `super_low` / `potato` / `garbage` | Super Low / Potato / Garbage (preview) |

- **プロキシの保持場所**: 生成済みプロキシは `asset.meta.proxies: Record<tier, { path, mime, width, height }>` に記録する（`AssetEntry.meta` は既存任意フィールド・§5 非変更）。`asset.meta.footageKind`（`"native"` | `"animated-raster"`）と `asset.meta.originalPath`（プロキシを既定 `path` にする raster 用）も meta に載せる。
- **映像/音声パス分離**（[`footagePlayback.ts`](src/runtime/footagePlayback.ts)・純関数）:
  - `resolveFootageVideoPath(asset, quality)` — DomRenderer / export がデコードする**映像**ファイル path。要求 tier のプロキシが `meta.proxies` に無ければ原本（`meta.originalPath ?? path`）へフォールバック。
  - `resolveFootageAudioPath(asset)` — **quality 非依存**。内蔵音声は常に**原本**から取る（`native` = `meta.originalPath ?? path`、`animated-raster` = なし）。プロキシ tier でも音声は劣化させない。
  - INV-2: preview / browser export / bundle は同一の `resolveFootageVideoPath` を使う（解決値一致）。プロキシ tier 間のデコード差はラスタ忠実度の範囲（§11.4 と同じカーブアウト）。
- **ストレージ 3 経路**（規約のみ・配線は後続 Phase）:

  | 経路 | 含める映像ファイル | 備考 |
  |------|--------------------|------|
  | IndexedDbFs（編集中） | 原本 + `meta.proxies.*` | セッションキャッシュ |
  | project zip（保存・再 import） | **原本のみ**（`meta.originalPath ?? path`） | プロキシは再 open / 初回参照で lazy 再生成。zip 内 project.json は raster の `path` を `originalPath` に戻し `meta.proxies` を省く正規化版 |
  | bundle export | 各レイヤー `resolveFootageVideoPath(asset, layer.footageQuality)` の結果のみ | 全 `meta.proxies` は含めない。内蔵音声付き `native` は原本 path も同梱（音声 decode 用） |

- **v1 既知制約**: ラスタ `original` の preview/bundle/export 映像は medium フォールバック（v2 で原本閾値）。GIF 可変 delay は等間隔 fps リサンプル。APNG は v2。transcode は編集用プロキシのため byte 一致を要求しない（INV-4 は原本 zip にのみ適用）。

> **実装フェーズ（progress.md と一体）**: Phase 1 = 本節 spec + `footageQuality.ts` / `footagePlayback.ts`（純関数）+ `footageQuality` prop 登録 + 単体テスト（共有 capture パイプライン非変更＝既存 export 無回帰）。Phase 2 以降でプロキシ生成・cache の quality 解決・Inspector QualitySelect・zip 正規化・bundleCollect・内蔵音声抽出の clock 統合を順次配線する。

### §11.5 audio コンポーネント（MVP / 最小）

- `audio` は `asset(audio)` + `gain`（**`AnimatedProp<number>`, 0..1, keyframe 可**）+ `trimStart`。タイムライン配置（inPoint/outPoint）で再生区間が決まる。後方互換: 既存 plain number の `gain` は `readGainProp()` で `staticProp` に正規化する。
- **preview（音声マスタークロック）**: 再生中はオーディオレイヤーが 1 つでもあれば `AudioContext.currentTime` を**マスタークロック**とし、`currentFrame = rangeStart + floor((ctx.currentTime − t0) · fps)` を毎 rAF で算出して `resolve`/描画する（§11.7 と同型・INV-8）。各レイヤーは `inPoint`/`outPoint`/`trimStart` に従って `AudioBufferSourceNode` をスケジュールし、`gain` は毎 tick に live comp から `sampleGain(gainProp, currentFrame)` を再評価して `GainNode.gain.value` へ反映する（編集中スライダーが再生中に効く）。**スクラブ時・停止時は無音**。`AudioContext` の resume はユーザージェスチャ（再生ボタン）で行う。オーディオが無ければ従来の rAF 経過時間クロックを使う。
- **映像遅れ時も音声は止めない（audio-master, holdTimeline 非依存）**: §11.4 の双方向同期が `holdTimeline`（映像遅れ）を検出しても、`PreviewAudioClock` は `AudioContext.suspend()`/`resume()` を呼ばず、frame 進行も凍結しない。`ctx.currentTime` から求めた `currentFrame` の算出を継続し、毎 rAF tick は直近の frame だけを `onFrameChange`/`renderFrame` に渡す（中間フレームの描画は行わない＝取りこぼす）。すなわち音声が正準の transport clock であり、decode が追いつかない video は一時的に古いフレーム表示・コマ落ちを起こしうる（意図的なトレードオフ）。`pauseVideo`（映像先行時に video を pause）・±4% の `playbackRate` 補正・loop wrap／scrub／明示 pause・stop による音声制御は本項の対象外で従来どおり。video 内蔵音声（`<video>` 要素の直接再生）は本項の対象外（別途 Phase B）。
- **プリロード（再生レイテンシ回避・非直列化）**: decode 済み `AudioBuffer` は **assetId をキーに共有メモリキャッシュ**へ常駐させる。編集中 comp に音声レイヤーがあれば事前に decode しておき、再生ボタンで decode 待ちなく即発音する。波形抽出（§11.5.1）・再生・duration メタ取得は**同一バッファを共有**し、大きなソースを多重 decode しない。
- **asset.duration メタ**: 音声 import 時に 1 回 decode して尺（秒）を `asset.meta`（`duration`/`sampleRate`/`channels`）に記録する。`AssetEntry.meta` は既存の任意フィールド（image と同様）で **§5 スキーマ非変更**。波形のソース尺マッピング（§11.5.1・§21.3）はこの値を使う。未記録時のみ尺をレイヤー長へフォールバックする。
- **export**: §11.2 のとおり mux（決定論・`OfflineAudioContext`）。`gain` は keyframe を反映するため、export 区間を **1/fps 刻み**で `sampleScalar(gainProp, frame)` を評価し `GainNode.gain.setValueAtTime(mixSec, value)` をフレーム境界ごとに打つ（`linearRamp` では hold/bezier easing と一致しないため。`interpolate.ts` の `findSegment`/`easingFn` と完全同一曲線になる）。
- video 内蔵音声は **基本再生 + export mux + keyframed gain を対応**（§11.4）。mixing graph / エフェクト / LUFS は §16 将来。

#### §11.5.2 カット端のポップ音防止 自動フェード（declick）

クリップを**カットしただけ**でも、波形がゼロでない位置で始まる/終わるとカット端で振幅が不連続になり「プチッ」（ポップ／クリック）が鳴る。これを防ぐため、`video`/`audio` レイヤーの **in 端・out 端に既定 ON の極短い自動フェード**（declick）を `gain` に**乗算**で重ねる（ユーザーの `gain` キーフレーム／Volume スライダーの上に additive に乗る・置き換えない）。長さは既定 `90ms`（[`footageAutoFade.ts`](src/runtime/footageAutoFade.ts) `DEFAULT_AUTO_FADE_MS`）。レイヤー prop `autoFade: bool`（既定 `true`・非 animatable・freeform props ＝ **§5 型非変更**）で個別 OFF 可。未設定の既存 project.json は `true` フォールバックで挙動が滑らかになる（後方互換）。

- **フェード形状（cubic-bezier「slow in / fast out」）**: エンベロープは線形ではなく cubic-bezier（`fadeEase` ≒ easeInCubic 制御点 `(0.32, 0, 0.67, 0)`）。in 端は**ゆっくり立ち上がり最後に速く**1 へ達し、out 端は**最初はゆっくり下がり最後に速く**0 へ切れる。端の傾きが緩いため、線形ランプで残りがちな境界のジッパーノイズ／段差感を抑える。全経路がこの同一カーブを共有する（Web Audio 経路は `setValueCurveAtTime` でカーブを直接サンプル＝サンプル精度、要素ベース経路は毎フレーム／毎 tick で同じ `fadeEase` を評価）。

- **直前の §11.4 カット境界再利用との整合（最重要）**: 同一動画を分割連結したシームレス境界（隣接レイヤーが同一 `asset` を参照し、離脱クリップの読み出し終端が入場クリップの読み出し始端に連続）では、§11.4 の `<video>` 要素再利用が**音を途切れさせず連続再生**している。ここに out フェード→in フェードを掛けると、せっかく消した「音量の急落→急上昇」（ぶつ切り）を**復活させてしまう**。したがって declick は、**隣に同一アセットがソース時刻を連続して引き継ぐクリップがある境界ではそのフェードを抑制**する（`computeFadeSuppression`：`D.out==C.in` かつ `D.trimStart+(D.out-D.in)==C.trimStart` なら C の in フェードを抑制、対称に out も）。本当に音が途切れる端（真のカット端・トリム端・尺端）だけにフェードを掛ける。
- **全経路一貫（INV-2）**: フェードのエンベロープ・抑制判定・長さは全経路で同一の純関数 [`footageAutoFade.ts`](src/runtime/footageAutoFade.ts) から導く。整数フレーム解像度の解決値は preview / export / bundle で一致する。サブフレームのフェード曲線忠実度は**経路ごとの音声機構に依存**する（§11.4 のラスタ忠実度カーブアウトと同型）:
  - **`audio` preview（`PreviewAudioClock`）/ export mux（`OfflineAudioContext`）**: ソースの start/stop が既知なので、**専用の `fadeGain` ノードを直列**（`src → fadeGain → (user)gainNode → dest`）に挿し、`setValueCurveAtTime` で `fadeEase`（slow in / fast out）を直接サンプルした**サンプル精度**のフェードを打つ（`setValueCurveAtTime` 不可の環境は線形ランプにフォールバック）。ユーザー gain 自動化とはノードが別なので互いを stomp しない。
  - **`audio` bundle（`HTMLAudioElement`）/ video 内蔵音声 preview・bundle（`<video>.volume`）**: AudioParam が無いため、共有 multiplier を毎 tick／毎フレーム `volume` に乗算する best-effort（粒度は tick／フレーム）。video の乗算は `resolve()` が `gain` に焼き込む。
- **export**: `audio`・video 内蔵音声とも `buildAudioMix` の offline グラフで上記 `fadeGain` 直列により declick を反映（preview と同一の長さ・抑制）。

#### §11.5.1 タイムライン波形表示（編集補助・非直列化）

オーディオレイヤーのタイムラインバー上に**波形**を描画して頭出し・尺合わせを助ける。波形は**表示専用の派生物**であり、`resolve()` にも `project.json` にも一切影響しない（§5 スキーマ非変更）。

- **ピーク抽出**: `asset` の音声 bytes を `decodeAudioData` し、**レイヤーバー上の可視ソース区間**（`[trimStart, trimStart+可視尺)`）を**バー幅（ピクセル数）**で min/max ピーク化する。曲全体を固定バケット数に圧縮してから写像するとズーム時に解像度が破綻するため、decode 済みバッファから可視区間を直接サンプリングする。DSP は決定論（`OfflineAudioContext`・seeded helper のみ、INV-1 と同じ純粋性方針）。
- **表示モード（グローバル・UI-only state、既定 `transient`）**: 海苔波形でも編集しやすくするための加工。
  - `raw`: 無加工ピーク。
  - `donshari`: `OfflineAudioContext` の biquad（lowshelf 低域 + highshelf 高域ブースト）を通してからピーク化。キック/ハイのアタックが立つ。
  - `transient`: エンベロープフォロワ（fast attack / slow release の差分）でトランジェントを過剰強調したピーク。
- **キャッシュ**: decode 済み `AudioBuffer` は §11.5 の共有メモリキャッシュに常駐（波形・再生・メタで共有）。全曲 4096 バケットのピーク列は **L2 IndexedDB**（`assetId · mode · bucketCount`）に任意保存できるが、**描画の正準経路は可視区間の直接ピーク計算**（上記）。`project.json` には保存しない（直列化形式・INV 非変更）。
- バーへのマッピングは footage の `trimStart` に従い左端トリムに追従する。可視区間 `[trimStart, trimStart+可視尺)` をバー幅ピクセル数のバケットへ 1:1 写像する（ズームでバーが広がるほど解像度が上がる）。

### §11.6 フォント（確定）

- `assets/` のフォントは load 時に **`FontFace` API で登録**（`document.fonts.add`）。`text` component の `font` はその family 名で参照。
- **export 時の埋め込み**: browser の `<foreignObject>` ラスタ化はフォントの inline（base64 `@font-face`）が要る。headless 経路は実フォントが効くので不要。

### §11.7 Web Bundle Export（実行可能 web バンドル）

MP4 とは別の出力経路。作品を**ブラウザで実時間再生する DOM/JS バンドル**として書き出す。プレイヤーは `@mafter/runtime`（INV-7）+ 音声マスタークロックの薄いラッパで、`resolve()` の純粋性（INV-1）により frame drop 時も「現在 frame に resolve でワープ」するだけで状態が壊れない（INV-8）。

- **2 出力モード**:
  - **Single-file**（全 `live`・vector/text/CSS の軽量作品専用）: プレイヤー JS + 正準 JCS データ + 軽量アセットを **DataURL inline した 1 枚の静的 HTML**。Lottie 上位互換のスイートスポット。**ベイク動画を inline すると「軽量」が即死する**ため、`bake` レイヤがある作品では選べない。
  - **Folder bundle**（ベイク動画/重アセット有り）: `dist/` に `index.html` + プレイヤー + データ + メディアを出力。**全アセットは相対パス `./...`（Vite `base: './'`）** にしてサブディレクトリ/ローカル double-click でも動くポータビリティを保証。
- **`file://` 直開き（double-click）の既知の制約（要注意）**: 通常動画・テキスト・図形等は `file://` で double-click しても再生できる。しかし **packed/split alpha 動画（§16.2/§16.2b）だけは Chromium の `file://` セキュリティ制約の影響を受ける** — ブラウザは `file://` オリジンからの `fetch()` を CORS で無条件ブロックするため、bundle 側の blob-URL 化（本来 HTTP range 非対応ホストでも滑らかに再生させるための仕組み）が働かず、alpha 動画は生の `file://` src にフォールバックする。この状態で `<video>` を canvas に描画して alpha 合成すると canvas が "tainted" 扱いになり、`getImageData`/`putImageData`（および tainted 状態での WebGL テクスチャアップロード）が `SecurityError` を投げる。**2026-07 修正済み**: この例外は合成関数内で捕捉し「この 1 フレームは合成失敗」として扱うため、再生ループ自体は止まらない（他レイヤー・音声は正常に進む）— が、**alpha レイヤーは `file://` 直開きでは透明/空白のまま描画されない**（合成そのものは原理的に不可能なため）。**推奨: alpha 動画を含む bundle はローカル HTTP サーバ経由（`npx serve` 等）で開く**。通常動画のみの bundle は `file://` 直開きで問題ない。
- **bake 経路**: `exportStrategy: 'bake'` のレイヤ（将来の WebGL/3D/重 plugin 等）は §11.4 / M3.5 の headless 機構で**そのレイヤだけ**フレーム書き出しして MP4/WebP 化し、`video` アセットとして同 `worldTransform`/`zOrder` で player に差し戻す。重ライティングをテクスチャに焼くゲームエンジン的割り切り。
- **alpha 動画の制約（要注意）**: ベイクレイヤを live シーンに透過合成するには alpha 動画が要るが、Web の alpha video は VP9 alpha（Chrome/FF）止まりで Safari が弱い、HEVC-alpha は Safari 専用。→ **v1 は不透明ベイクのみ**を保証。透過が要る軽い要素は WebP/PNG 連番、本格的な透過は color+matte 2 ストリーム（§16 将来）。
- **再生クロック**: マスタークロック = `AudioContext.currentTime`（音声があれば）。`currentFrame = round(t * fps)` を毎 rAF で算出し `resolve(comp, currentFrame)` を描く。低スペックでは中間 frame を描かずスキップ＝音ズレしない（INV-8）。音声が無ければ rAF 経過時間をクロックにする。
- **実時間再生の適応 frame drop（音声優先）**: HTML bundle player は、音声マスター時に video 遅延の `holdTimeline` で音声要素を pause しない。video の遅れ・先行は各 video 要素の seek / `pauseVideo` / playbackRate サーボで吸収し、音声クロックと frame 番号進行は止めない。描画は best-effort とし、`renderFrame` 所要時間の EMA から重負荷時だけ描画呼び出しを間引く。間引き tick でも現在 frame は wall-clock / 音声クロックに追従し続け、次に描ける tick でその frame へ `resolve()` でワープする。これは INV-8 の実時間 bundle 専用挙動であり、`resolve()` の scene 解決値、INV-2、MP4/WebM/PNG/headless の決定論 frame-step には影響しない。
- **セキュリティ**: 公開 bundle は author の JS がエンドユーザのブラウザで走る。**第三者 plugin は既定 `bake`**（§5.5 / §12）でコードを焼き消し、`live` で出るのは author 自筆コードに限るのが安全側。ホスト側 CSP は author の責任範囲として明記。
- **インタラクティブは v1 では非対応**。click/scroll 応答を入れると `(frame)→絵` が `(frame, 入力状態)→絵` になり決定論・オーサリングモデルが別物になるため、v1 は**タイムライン駆動・音声クロックの再生のみ**（§16 将来）。

---

## §12. Plugin API v1（MVP 必須・フル）

> freeze 早すぎリスクは **registration パターン + `apiVersion` 固定**で殺す。
> 表面は登録ベース（open for extension / closed for modification）なので、後から capability を足しても v1 plugin は壊れない。追加 = minor、破壊 = `apiVersion: 2`。

```ts
interface PluginManifest {
  id: string;                 // 逆 DNS 風
  name: string;
  version: string;            // semver
  apiVersion: 1;              // host の major と一致必須
  entry: string;              // plugins/<id>/ からの相対
  capabilities: ("component"|"effect"|"easing"|"expr"|"io"|"inspector")[];
}

// default export
export default function activate(ctx: PluginContext): void { /* register 呼び出し */ }

interface PluginContext {
  registerComponent(def: ComponentDef): void;   // 新 component type（ParamDescriptor[] + DomRenderer 用 render hook + bundleExportDefault?: "live"|"bake"。既定 "bake"）
  registerEffect(def: EffectDef): void;          // DOM: CSS filter / canvas pass。buffer→buffer 互換契約
  registerEasing(preset: EasingPreset): void;
  registerExprHelper(name: string, fn: PureFn): void; // 決定論必須 (INV-1)。違反検出で無効化
  registerImporter(def: ImporterDef): void;      // 例: 将来の Blender camera/depth importer はこれ
  registerExporter(def: ExporterDef): void;
  registerInspector(def: InspectorControlDef): void; // MVP は param 制御のヒントのみ。フル custom React panel は v1.1
  fs: ReadonlyFileSystem;     // plugin dir + project を read scope。任意 write は不可
}
```

- **セキュリティ（MVP）**: plugin JS はページ内実行（trusted-author）。capability-scoped sandbox（iframe/worker、fs ケイパビリティ制限）は §16 の硬化項目。`registerExprHelper` で渡される関数は INV-1 検証（乱数/時刻/DOM/network アクセスを静的・動的に検出したら拒否）。
- **web bundle export（§11.7）での既定は `bake`**。第三者 plugin のコードを公開 bundle でエンドユーザに流さないため、`registerComponent` の `bundleExportDefault` は既定 `"bake"`。author が個別に `live` 上書きした時だけ live で出る。
- **EffectDef の I/O 契約**は将来の WASM effect（buffer→buffer）と同一シグネチャに揃え、§14 の差し替えを可能にする。

---

## §13. AI / SSoT 統合（三点ファイルの整理）

SSoT 違反を避けるため、scope と正準性を分離する:

- **`claude.md`（canonical）**: エンジン/フレームワークの使い方。スキーマ、規約、comp/expression/plugin の書き方。「Mafter をどう使うか」の唯一の正。
- **`copilot-instruction.md`（生成物）**: `claude.md` から薄く生成されるビュー。**独立ソースにしない。** ビルドスクリプトが `claude.md` から emit する（フォーマット差の吸収のみ）。
- **`prompt.md`（直交 scope）**: この作品固有の演出・意図・制約。エンジン知識とは scope が違うので重複ではない。

二層構造: 「エンジンを**作る**ための SSoT」= 本仕様書 + `project.json` スキーマ / 「エンジンを**使う**ための SSoT」= `claude.md`。

---

## §14. WASM / Rust / Go 移行方針

- 差し替え対象は **純関数の `resolve(comp, frame) → ResolvedScene`**、エクスプレッション評価、重い数値処理。
- 契約: 同一入力（Composition JSON + frame）→ 同一 `ResolvedScene`。JS 実装と WASM 実装を **差分テスト**で同値検証する。
- I/O は serializable に保つ。より効率的なフォーマット（例: `ResolvedScene` の flatbuffers 化）は **双方向 codec を文書化する限り**許可。
- Effect / Importer / Exporter も同じ I/O 契約を維持し、個別に Rust/Go へ移せるようにする。

---

## §15. マイルストーン（MVP = M0–M4, 受け入れ条件付き）

各 slice は claude-code が独立にビルド可能、ユーザがテスト可能。

- **M0 Foundations** — `project.json` schema + `IndexedDbFs` + zip export/import + プロジェクト作成/読込。
  - 受け入れ: 作成 → 保存 → 再読込 → zip DL → 再 import で `project.json` が正準シリアライズ後 byte 等価。`git init` で正常な diff。

- **M1 Core animation + DomRenderer** — Object/Transform/Opacity/Timeline/Keyframe/Easing + `resolve()`（world 行列を焼く）+ `DomRenderer`（フラット matrix3d）+ preview 再生 + Inspector + **Undo/Redo** + **パネルシステム（固定レイアウト + スプリッタ resize、§19）**。
  - **境界設計（Opus 案件）**: ここで `@mafter/runtime`（INV-7）とエディタの境界、およびパネルレジストリ + レイアウトツリー（§19）を設計する。**実装前にここを Opus で 1 周**（コア型/境界の凍結ゲート）。
  - 受け入れ: solid/text/image を配置し position/opacity を bezier easing で keyframe、スクラブ＆実時間再生、値が §6.3 の world 行列と一致、CSS-3D の z が効く、任意の編集を Cmd-Z/Shift-Cmd-Z で往復、パネルをスプリッタで resize でき、レイアウトはユーザ設定に保存され project.json を汚さない。

- **M2 HTML comp + expression** — HTML Composition（Model A, manifest, Shadow DOM）+ エクスプレッションエンジン（純粋・seeded）。
  - 受け入れ: params 宣言済み HTML comp が keyframe でアニメート、expression ファイルがプロパティを駆動、リロード跨ぎで preview 決定論的、`wiggle` 再現可能。
  - **de-risk spike（推奨）**: 「素の HTML 1 枚に `@mafter/runtime` を置き、エディタ無しで comp が音声クロックで動く」を最小実証。通れば §11.7 web bundle の 9 割が片付く。

- **M3 Export（browser best-effort）** — 決定論 frame ステップ + WebCodecs/PNG 連番エンコード + **音声 mux** + export ダイアログ。video/audio/font 対応。
  - 受け入れ: solid+text+image+video+HTML-comp に audio レイヤを足した 5 秒尺を webm/mp4/連番に書き出し、映像は preview の scene 値と一致、音声が mux される、フォントが反映される。**← ここで「アーティストが作品を公開できる」が成立。**

- **M4 Plugin API v1** — フル登録 API + `plugins/` ロード + サンプル plugin（custom component / effect / easing pack）。
  - 受け入れ: `plugins/` に置いた第三者 plugin が component を登録しタイムラインで使用可、save/load を跨いで生存。

- **M5 Web Bundle Export（§11.7）** — `@mafter/runtime` ベースの player + Single-file / Folder bundle 出力 + `exportStrategy:'bake'` レイヤの部分 MP4/WebP 化（M3.5 headless 依存）。
  - 受け入れ: 全 live の軽量作品が Single-file HTML 1 枚で任意のサーバ/ローカルで音声同期再生できる、`bake` レイヤを含む作品が Folder bundle として相対パスで動く、第三者 plugin レイヤは既定 `bake` で焼かれる。

> 注: Plugin API を MVP に含めた選択で M4 まで MVP。コア未安定のまま API を固める懸念は §12 の registration + apiVersion 設計で吸収するが、実務上は **M1–M3 でコア型を一度凍結してから M4 に入る**ことを推奨。M5 は MVP 後の機能だが、依存する `@mafter/runtime` 境界は M1 で先に切っておく。

---

## §16. MVP / 将来 の分離

| 機能 | 区分 |
|---|---|
| Project / Composition / Object / Timeline / Keyframe | **MVP (M0–M1)** |
| Transform(P/R/S) / Opacity / Easing(cubic-bezier) | **MVP (M1)** |
| HTML/CSS/JS Composition (Model A) | **MVP (M2)** |
| Expression（純関数・seeded） | **MVP (M2)** |
| Project Save/Load / zip / Git 形式 | **MVP (M0)** |
| Browser best-effort export（音声 mux 含む） | **MVP (M3)** |
| video（best-effort）/ audio（最小・gain keyframe 可）/ font | **MVP (M3)** |
| Undo/Redo（command + 逆 patch） | **MVP (M1)** |
| Plugin API v1（フル） | **MVP (M4)** |
| CSS-3D による 2.5D / 最小 Camera | **MVP（M1）** |
| パネル固定レイアウト + スプリッタ resize（§19） | **MVP (M1)** |
| `@mafter/runtime` 境界の設計（INV-7） | **MVP（M1 で設計）** |
| Web Bundle Export（Single-file / Folder, §11.7） | M5（MVP 後・runtime 抽出に依存） |
| Headless canonical export | 将来（早期推奨, M3.5） |
| パネルのドラッグ・ドッキング / タブ並べ替え（§19） | 将来 |
| パネルのデタッチ（別ウィンドウ：browser=window.open+同期, app=OS窓） | 将来 |
| インタラクティブ bundle（入力応答） / alpha-bake（color+matte） | 将来 |
| compRef / nested composition（precomp, 時間マッピング） | 将来 |
| Timeline Tier B（ラベル色 / **lock（§21.11 部分実装済み）** / solo / shy / parent ドロップダウン UI, §21.0） | 部分実装（優先度高） |
| Timeline Tier C ブレンドモード（§5.4d / §21.0） | 実装済み |
| Timeline Tier C トラックマット（§5.4f / §21.0） | **実装済み（2026-07・live SVG mask）** |
| Timeline Tier D（モーションブラー / フレームブレンド / 3D レイヤー / 調整レイヤー, §21.0） | 将来 |
| タイムコード ドロップフレーム表示（0;00;00;00, §21.1） | 将来 |
| Model B（DOM 内省で要素を Object 化） | 将来 |
| WebGL/WebGPU レンダラ / 実 3D（深度・ライティング・物理カメラ） | 将来 |
| Blender Camera / Depth Import（IO plugin） | 将来 |
| Particle / Advanced Effects / 分散レンダリング / AI 編集支援 | 将来 |
| comp/plugin JS のハードサンドボックス / CSP | 将来（セキュリティ硬化） |
| keyframed gain（audio / video 内蔵音声, §11.4 / §11.5） | **実装済み（0..1・全経路 `sampleGain` 共有）** |
| audio mixing graph / エフェクト / LUFS | 将来 |
| video 内蔵音声（基本再生 + export mux + keyframed gain, §11.4） | **実装済み（best-effort）** |
| タイムライン波形表示（raw/donshari/transient, §11.5.1） | **実装済み（編集補助・非直列化）** |
| エディタプレビューの音声再生（マスタークロック, §11.5） | **実装済み** |
| OPFS アセット格納 / time remap / per-axis easing・expression | 将来 |
| グラフエディタ Phase 2（per-axis 値カーブ, §22.0） | 将来（additive スキーマ） |
| グラフエディタ Phase 3（空間モーションパス / 速度グラフ, §22.0） | 将来（additive スキーマ + resolve 拡張） |
| Monetization / entitlement 層（feature-flag, account/app レベル, §29） | 将来（MVP 後・スキーマ/INV 非変更） |
| watermark（raster 出力, §29.2） | 将来（MVP 後・依存: raster export=M3） |
| tier ゲート（bundle=§11.7 / headless=M3.5 / native=§14, §29.3） | 将来（MVP 後・依存: §11.7 / M3.5 / §14） |
| Motion Track from footage — 並進（§16.1 Phase 1a・editor-only WASM VO） | **実装済み（2026-07 Phase 1a）** |
| Motion Track 回転推定（§16.1 Phase 1b-a・editor-only） | **実装済み（2026-07 Phase 1b-a）** |
| Motion Track 追跡範囲 ROI（§16.1 Phase 1c・mask） | **実装済み（2026-07 Phase 1c）** |
| Motion Track 特徴品質・補間（§16.1 Phase 1d） | **実装済み（2026-07 Phase 1d）** |
| Motion Track Walk（前進・揺れ・見回し / R+t）（§16.1 Phase 2a/2b） | **実装済み（2026-07）** |
| Motion Track 3D Solve（オフライン SfM / バンドル調整）（§16.1） | **実装済み（2026-07）** |
| Motion Track POI 軌道・COLMAP/Blender カメラ import | 将来（§16.1 Phase 1b-b / 外部 import） |
| Subject Extract from footage — 人物切り抜き（§16.2・editor-only ML） | **実装済み（2026-07）** |

---

### §16.1 Motion Track from footage（映像からのカメラ運動推定・editor-only）

video レイヤーのフッテージから単眼 visual odometry（vendored WASM トラッカー: QUAR Engine `TrackerHandle`, MIT）で**カメラ並進方向**をフレームごとに推定し、同 comp 内の **Camera または Null** の `transform.position` に dense keyframe としてベイクするエディタ機能。

**アーキテクチャ境界（INV 非関与の根拠）**:

- 推定は **editor-only の非決定的解析**。結果は通常の `Keyframe` として `project.json` に保存され、以降の `resolve()`・preview・export は既存パスのまま（INV-1/INV-2 は「ベイク済み KF の再生」にしか関与しない）。
- WASM は `public/motion-track/pkg/`（由来・sha256 は同ディレクトリ `PROVENANCE.md`）から**「Track Motion」実行時のみ** Web Worker 内に lazy load。メインバンドル・player.js・Web bundle export（§11.7）には一切同梱しない。
- フレーム抽出はメインスレッド（hidden `<video>` + `videoSeekTargetSec` seek + canvas `getImageData`）。comp フレーム→ソース時刻は `sourceFrame = f - inPoint + trimStart` でマッピングし、レイヤー in/out とソースの交差範囲のみ解析。
- ベイクは**単一 applyCommand**（Undo 1 件）。対象プロパティに expression がある場合は確認の上クリアし、クリアも同一 command に含める。

**スコープと制約（正直な期待値）**:

- **並進（position）— Phase 1a**: QUAR `TrackerHandle` でカメラ並進**方向**のみ推定し、Null / Camera の `transform.position` に dense KF ベイク。方向のみ信頼可・大きさは非メトリック（UI スケール係数で補正）。
- **回転（パン/チルト/ロール）— Phase 1b-a**: 特徴点対応から rotation-only モデル（ベアリングベクトルの四元数フィット + RANSAC）で推定し、Null / one-node Camera の `transform.rotation`（euler ZYX deg）に dense KF ベイク。**ノーダルパン（カメラがその場で回る）前提**。並進が混在するフレームはフィット残差で低信頼としてホールド（Phase 1a の warmup/confidence 方針と同型）。焦点距離はアクティブ camera の `zoom`（px）を初期推定に用い、UI スライダーで上書き可。two-node Camera への回転ベイクは **Phase 1b-b** で POI 軌道（`poi' = position + R·(poi₀ − position)`）として扱う。**Position モードでは pointOfInterest を変更しない**（Phase 1a 契約を維持）。two-node のロールはパン/チルトのみ（lookAt + `transform.rotation` 併用は未対応とする）。
- **zoom — Phase 1b-b**: camera component の `zoom` への KF ベイク。zoom とドリーは単眼で原理的に不可分のため、解釈はモード選択でユーザーが指定する。
- 対応点抽出は vendored OpenCV.js（`calcOpticalFlowPyrLK` 等、Apache-2.0、`public/motion-track/opencv/`、PROVENANCE.md 併置）を worker 内 lazy load。QUAR `inlier_points()` は inlier **件数**のみ返し座標ペアは供給しない（2026-07 Phase 0b スパイク実測）。いずれも **editor-only・Track Motion 実行時のみ**。メインバンドル・player.js・Web bundle export（§11.7）非同梱（Phase 1a と同一境界）。
- ローリングシャッター・強いモーションブラー・画面の大半を占める動体では破綻しうる。冒頭数フレーム（warmup）は frame 0 をホールド。
- **追跡範囲（ROI）— Phase 1c**: Inspector Video の Motion Track で正規化矩形（プリセット / カスタム）を指定できる。フレーム抽出後に ROI 外を黒塗り（mask）し、画像サイズは変えない（回転推定の主点を維持）。セッション UI 状態のみで `project.json` には永続しない。人が多いシーンでは背景側の ROI を指定すると安定しやすい。
- **特徴品質・補間 — Phase 1d**: 回転経路は forward-backward LK・LK 誤差閾値・グリッド分散再検出・ROI 縁マージン棄却で動体/偽特徴を抑える。並進ベイクは無効フレームを baseline にスナップせず前後有効値で線形補間（スロープ制限）する。
- **追跡マスク — Phase 1d+ / Comp 27 修正**: **既定は「全体」**。オプトインの「背景優先（人混み）」は手前中央の群衆帯のみ exclude（道路全体は消さない）。フレーム抽出後に逆光向けコントラスト伸長（マスク黒は維持）。回転経路の `equalizeHist` は full mask 時のみ。回転の有効率が低いときは identity KF を黙って焼かず警告する。マスク境界の静止エッジは QUAR 並進がロックしうる既知制約（境界フェザリングでは防げない）。
- **Walk モード — Phase 2a/2b/2c（連続性ファースト）**: 歩き撮り向け。OpenCV WASM は **KLT / 特徴検出のみ**。毎フレーム FOE/発散フローで予測ステップを出し、地図（DLT 三角測量）が十分なら DLT-PnP 候補を作るが、**ベイク入力は常に相対ステップ 1 本**（`walkAccumulate` のみ絶対化）。PnP は予測との回転角・並進方向が近いときだけ向きを補正し、scale は予測のまま（単眼スケール不定でもゲートが機能する）。絶対ポーズ直書きは禁止（ジャンプ防止）。並進 auto-scale あり。Rotation（その場）はノーダルパン専用。逐次 VO のため AE 級フル BA は対象外（一括解法は **3D Solve**）。
- **3D Solve（オフライン SfM）— 推奨既定**: AE の 3D Camera Tracker 相当の**一括**カメラ解析。OpenCV WASM で長寿命特徴トラックを蓄積したあと、純 TypeScript の SfM（キーフレーム選択 → essential 2-view 初期化 + 焦点距離スイープ → 逐次 PnP + 三角測量 → 全体バンドル調整（LM + Schur・Huber）→ 全フレーム pose-only 局所化）で position + rotation を同時ベイク。カメラ対象では推定焦点距離を `zoom`（静的）へ任意適用可。視差が検出できないクリップ（純パン/チルト・平面シーン）は **rotationOnly** にフォールバック（並進は baseline 維持）。単眼スケールは不定のため **auto-scale（支配軸 range → comp 高さの 1.5 倍を既定目標。Position/Walk の 0.15 倍より強い）の後に UI スケール係数を等方乗算**して補正する（回転 KF はスケール非依存で不変。係数 1 が実写でしっくり来る強さの目安）。特徴追跡は序盤シードに加え **短間隔の再検出**と画面外点の即ドロップで後半トラックを維持する（見切れ以降の地図薄さ対策）。既存 Position / Rotation / Walk 経路とは**隔離**（`src/editor/motionTrack/sfm/`）。editor-only・Track Motion 実行時のみ（INV-1/INV-2 はベイク済み KF の再生にのみ関与）。合成シーンでの受け入れ基準は軌道 RMSE < 全長の 1%・回転中央値 < 0.2°・焦点誤差 < 5%（`test/motionTrackSfm.test.ts`）。
- さらに高精度が必要な場合の外部 import（COLMAP / Blender camera, §6.5 の ImporterDef 経路）は将来。two-node Camera の POI 軌道ベイクは Phase 1b-b。

### §16.2 Subject Extract from footage（映像からの対象切り抜き・editor-only）

video レイヤーのフッテージから **MediaPipe Selfie Segmentation**（Apache-2.0、`public/subject-extract/mediapipe/`、PROVENANCE.md 併置）で人物マスクを推定し、フレームごとに alpha を適用した **WebM VP9 alpha** アセットを生成するエディタ機能。

**アーキテクチャ境界**:

- 推定は **editor-only の非決定的解析**。成果物は通常の `video` asset として `project.json` + FS に保存され、以降の `resolve()`・preview・export は既存 video 経路のまま（INV-1/INV-2 非侵襲）。
- ML/WASM は **Extract 実行時のみ** lazy load。メインバンドル・`player.js`・Web bundle export（§11.7）非同梱。
- フレーム抽出は Motion Track と同型（hidden `<video>` + seek + canvas `getImageData`、§16.1 と共有ヘルパ）。
- 適用は **単一 applyCommand**（Undo 1 件、label: `"Subject Extract"`）。

**出力**:

- **新 video レイヤー**: ソース video レイヤーの **直上**（`zOrder = source.zOrder + 0.5`）。`inPoint` / `outPoint` / `transform` / `parent` / `opacity` / `fit` はソースからコピー。
- **新 asset**: FS `assets/<ulid>.webm`（透過 VP9）。Chrome 等で VP9 `alpha:keep` 非対応の場合、サイズが収まれば **packed alpha**（§16.2b・2026-07 プレビュー軽量化プラン v2 で追加・優先）、収まらなければ従来の **split alpha** — 同色 WebM + `assets/<ulid>.alpha.webm`（グレースケールマスク）の 2 本と `meta.alphaMode: "split"` / `meta.alphaPath`。再生は `DomRenderer` が canvas 合成（split は CPU/GL 両対応、§16.2b 参照）。Project Bin **`Assets` → `VideoSubjectExtract`**（無ければ作成）。`asset.meta.extractedFrom` に元 asset id を記録可。

#### §16.2b packed alpha（color+mask 1本パック・2026-07 追加）

**目的**: split alpha は color/mask が独立デコードの2ストリームになり、2クロック同期・毎フレーム CPU 合成という構造的な重さを持つ（`doc/issue/subject-extract-split-alpha-webm-preview-instability.md`）。packed alpha は color の直下に grayscale mask を上下パックした **1本の動画**にすることでこの構造自体を解消する。

- **フォーマット**: `y=0..contentHeight` に color、`gutterPx`（既定 8px・黒・4:2:0 クロマにじみ防止）を挟んで `y=contentHeight+gutterPx..` に mask（grayscale）。総高さ ≈ `2*contentHeight + gutterPx`。
- **コーデック**: H.264/mp4（`avc1.42e0xx`、`VideoEncoder.isConfigSupported` で交渉）優先。非対応環境は VP9/webm にフォールバック（1ストリーム化の利益は両方で残るが、webm フォールバックは音声非同梱）。
- **音声**: mp4 の場合、元 footage の音声トラックを同じ実時間範囲だけ切り出して別トラックとして同梱（AAC）。無音素材はトラック省略。
- **サイズ上限**: packed 高さ（`2*contentHeight+gutterPx`）が 4096px を超える場合（4K 級ソース）は packed 化せず split のまま。
- **asset.meta**（`AssetEntry.meta` は自由形 record・§5 型は不変）: `{ alphaMode: "packed", packedLayout: "topBottom", contentHeight: number, gutterPx: number }`。`asset.meta.width/height` は **content サイズ**（packed 動画自体の全高ではない）。
- **再生**: `<video>` は 1 本のみ（companion なし・genlock 不発）。合成は `src/runtime/videoPackedAlpha.ts`（WebGL1 シェーダ優先・`src/runtime/videoAlphaGl.ts` 経由、CPU フォールバックあり）。表示は split と同じく「video を非表示にし合成 canvas を表示」。
- **export/bundle**: 単一ファイルのため split 特有の companion 同梱処理は不要（通常の video asset と同じ扱い）。
- **既存 split → packed 変換**: 1レイヤー/1アセット単位でオフライン変換する UI をスコープに含む（詳細は cloudplan doc）。
- **元レイヤー**: 変更なし。

**色空間ポリシー（2026-07 追加・黄ばみ色ズレ対策）**: Subject Extract が生成する動画（unified / packed / split 問わず、`src/editor/subjectExtract/encodeAlphaWebm.ts` の H.264・VP9 双方）と、その proxy 再エンコード（`src/runtime/webcodecsVideoEncode.ts`）は、canvas 由来 RGBA フレームを `VideoEncoder` で再エンコードする際、**再エンコードを sRGB 中立（round-trip が恒等に近い）にする**ことをポリシーとする。

- **既知の原因**: canvas/`ImageBitmap` から作った `VideoFrame` は sRGB としてタグ付けされるが、これは入力側のタグに過ぎない。`VideoEncoderConfig` に `colorSpace` を明示しない場合、実際に RGB→YUV へ変換する行列（BT.601/BT.709）はブラウザ・プラットフォーム・HW/SWエンコーダ依存で曖昧になり、再生側（`<video>` の YUV→RGB）は解像度ベースのヒューリスティック（概ね SD→BT.601 / HD→BT.709）で独立に推測するため、両者が食い違うと黄色っぽい色シフトが生じる（Chromium で報告例あり。特に Windows 上の HW エンコーダ経路で顕在化しやすく、macOS では出ないことがある＝プラットフォーム依存）。範囲（full/limited）も副次的要因になり得るが、色相シフト（黄ばみ）の主因は一般に matrix 側。
- **対策（確定・ただし効果未実証）**: 上記のいずれの `VideoEncoder.configure()` 呼び出しにも、明示的に `colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false }` を指定する（`src/runtime/videoColorSpace.ts` の `RGBA_SOURCE_VIDEO_COLOR_SPACE` を単一の正として共有）。これは今使っている `mp4-muxer`/`webm-muxer` がコンテナへ色空間メタデータ（`colr` box 等）を書き出す機能を持たないための代替策で、「エンコーダに実際にこの行列を使わせる」ことで、コンテナが無タグのままでも再生側の既定推測と一致させる狙い。**実機検証（2026-07-08）の結果、少なくとも本開発環境の Chromium（software encoder）ではこの `colorSpace` 指定は無視され、実際に生成されるファイルは常に `smpte170m`（BT.601）のまま変化しないことを確認した**（`VideoEncoderConfig.colorSpace` / `VideoFrameBufferInit.colorSpace` いずれも無効。H.264・VP9 とも同様）。設定自体は無害（型安全・既存テスト無回帰）で将来ブラウザが対応した場合に備える価値はあるが、**現時点でこの対策だけで黄ばみが解消する保証はない**。詳細は progress.md 2026-07-08 追記を参照。
- **非対象**: 通常のシーン合成 export（`src/runtime/exporter.ts` の `configureVideoEncoder` 経由・mp4/webm/PNG 連番書き出し）は本ポリシーの対象外（このセッションのスコープ外）。

**packed preview proxy（2026-07 追加・decode-bound 対策）**: packed 原本が webm（VP9 ソフトウェアデコード）に落ちるケース（H.264 非対応環境）で、`contentHeight` が大きい（実測 1080×2284px 級）と実時間デコードが追いつかず、preview 再生が chronic に `holdTimeline`（§11.4 双方向同期）でゲートされ、タイムライン全体が実時間の半分程度まで速度低下する（実機計測で確認・drop rate ≈40%）。この劣化を preview 専用の忠実度トレードオフで回避する:

- **editor preview ＋ §11.7 HTML bundle player（live 再生）** は、レイアウト保持のまま縮小した **packed preview proxy**（既存 §11.4b footage proxy 基盤 `meta.proxies[tier]` を packed 対応拡張）を使う。proxy は webm（低解像度なので VP9 ソフトデコードでも実時間再生可）。Inspector の **Preview Quality** ドロップダウン（packed レイヤー専用・通常 video の `footageQuality` ドロップダウンと排他）でユーザーが tier を選べる。**"Original" は文字通り原本を使う**（2026-07 変更・以前は "Original" 選択時も decode-bound 回避のため黙って既定 proxy tier `low` に差し替えていたが、ユーザーから見て不透明だったため撤回した）。decode-bound 回避は**新規レイヤー作成時の初期値**として担保する — Subject Extract が packed レイヤーを作る際、`footageQuality` prop を明示的に `"low"` で書き込む（`applySubjectExtractToProject`）。ドロップダウンは常にこの明示値をそのまま表示・尊重するため、「原本より低画質に見える」不透明さは無くなり、"Original" を選べば常に本当に原本になる（プロパティが未設定・不明値のときのみ `normalizePackedPreviewSelection` が安全側の `low` にフォールバックする）。
- **Preview Quality には「Same as Export Quality」という特殊選択肢**（`PACKED_SAME_AS_EXPORT` sentinel、`footageQuality` prop に文字列として保存）がある。選ぶと Export Quality の値に**そのまま**追従する（既定 proxy tier への自動差し替えは行わない — Export Quality が `original` ならプレビューも文字通り原本を使い、decode-bound の低速化を承知の上で export と完全一致のプレビューを見たい、という明示的な要求として扱う）。Export Quality を変えると、リンク中の Preview Quality も自動で追従する（`PackedExportQualitySelect` が Preview 側のリンク状態を見て evict+reload する）。
- **決定論 export（mp4/webm/PNG、および HTML bundle の bake 焼き込みレイヤー）** は、Preview Quality とは**独立**した専用の **Export Quality**（packed レイヤーの `packedExportQuality` プロパティ・既定 `"original"`）を使う。既定のままなら原本 packed（INV-2 非干渉）。ユーザーが明示的に proxy tier を選んだ場合のみ低画質で書き出す（例: ドラフト書き出しの高速化）。
- proxy は自身の縮小 `contentHeight`/`gutterPx` を `meta.proxies[tier]` に併記する（合成 rect はレイアウトごとに再計算されるため、原本のレイアウト値を縮小 proxy にそのまま流用してはならない）。
- proxy 生成トリガ・既定 tier・quality 解決の実装詳細は `src/runtime/packedVideoProxy.ts` / `src/editor/store.ts`（`ensureProxyTier`）/ `src/runtime/imageAssetCache.ts` / `src/runtime/footageQuality.ts`（`effectivePackedQuality` — `exportStep` 時は `exportQuality`、それ以外は `previewSelection`（通常 tier または `PACKED_SAME_AS_EXPORT`）を独立に解決する）参照。
- **WebCodecs 不可環境**: proxy 生成（Preview Quality / Export Quality いずれも）は `VideoEncoder`（WebCodecs）に依存する。非対応ブラウザでは Inspector に警告バナーを常時表示し（`webcodecsUnavailableReason()`）、preview 側の自動事前生成（idle トリガ）も試行自体を止める（失敗を前提に無駄なリトライ・キャッシュ破棄をしない）。生成が完了するまで／生成に失敗した場合は必ず原本 packed 資産にフォールバックする — **生成中・失敗時に一時的にでもレイヤーが不可視（透明）になってはならない**（該当キャッシュを生成完了「前」に破棄しないことで保証する。§実装ガイドライン参照）。
- **HTML bundle export の zip 同梱**: `collectBundleDependencies`（`bundleCollect.ts`）は packed レイヤーの同梱ファイルを、生の `footageQuality` prop ではなく `effectivePackedQuality`（Preview Quality 側の解決規則・`PACKED_SAME_AS_EXPORT` 込み）で決める。bundle player（`registerProjectUrls`）は `meta.proxies` を無条件に URL 登録するため、ここがズレると「player は proxy URL を要求するのに zip にそのファイルが無く 404」という壊れ方をする（既定 tier への自動差し替え・Same as Export Quality いずれの場合も同一関数で解決することで一致を保証する）。

**UI**: Inspector Video 内の Subject Extract 折りたたみ。対象種別プルダウン（v1: Person）+ sample interval + Extract。プルダウン選択はセッション UI のみ（`project.json` 非永続）。

**制約**: WebM alpha 再生は Chrome/FF 中心（§16 alpha 動画制約と同型）。Safari は弱い。長尺は sample interval で間引き可。

---

## §17. 推奨スタック（参考・差し替え可）

- React + Vite + TypeScript(strict)。`npm run dev` でブラウザ起動。
- エディタ状態管理: Zustand（軽量・差し替え容易）を推奨。プロジェクトデータの正は `project.json`（FS）であり、ストアはその投影。
- **Undo/Redo（確定・MVP）**: すべての編集は **command** を通し、各 command が「適用 patch / 逆 patch」を生成する（プロパティ単位の JSON patch 推奨）。undo/redo はこの patch スタックの往復。スタックはセッション内のみ（永続化しない）。`resolve()`/レンダラはストア変更に反応して再描画。これにより編集は局所 patch となり、§5.6 の id ソート直列化とも素直に噛み合う。
- zip: JSZip。エンコード: WebCodecs（第一）/ ffmpeg.wasm（フォールバック）。
- **prior art**: React→動画 via headless Chromium を既に解いている **Remotion** を必ず一読。本プロジェクトは「Remotion + AE 的タイムライン UI + 統一 Object モデル」に近い。流用するか、意識的に分岐するかを決めること。

---

## §18. 決定事項・要確認リスト

### 確定済み（合意 or 本文に確定として記載）
- **Object 格納形式**: flat list + `parent`(transform のみ) + `zOrder`(fractional, id ソート直列化)（§5.4-note）。**確定**。
- **レンダリング**: ネストせず world 行列を焼いてフラット matrix3d（§6.3 / §8）。**確定**。
- **Transform 数学 / 座標系 / 補間 / camera**: §6 に固定。**確定**。
- **FS→module loader**（blob URL + dynamic import, §11.3）。**確定**。
- **expression**: 実行時例外はフォールバック、参照は local + `toWorld/toComp`（§9）。**確定**。
- **video=MVP(best-effort) / audio=MVP(最小) / compRef=将来**（§5.5 / §11.4 / §11.5 / §16）。**俺の既定 — 覆し可**。
- **Undo/Redo=MVP(command+逆patch)**（§17）。**確定**。
- **font 登録 + export 埋め込み**（§11.6）、**schema migration**（§5.6）。**確定**。

### まだ覆せる俺の決め打ち
1. **HTML comp 隔離**: iframe ではなく **Shadow DOM**（headless export を 1 screenshot で済ませるため）。→ 隔離強度優先で iframe にするか？
2. **comp/plugin JS 実行**: MVP は **ページ内実行（trusted-author 前提）**、サンドボックスは将来。→ MVP からサンドボックス必須にするか？
3. **easing 粒度**: 区間ごと **一律 cubic-bezier**（per-axis は将来）。→ MVP から per-axis 必要か？
4. **expression 粒度**: 既定 **per-property**（per-axis も可）。→ 既定を per-axis に？
5. **encoder**: **WebCodecs 第一 / PNG 連番 + ffmpeg.wasm フォールバック**。→ ffmpeg.wasm 一本化のほうが楽か？
6. **video/audio を MVP に入れた件**: 重い場合は M3 から外して将来へ回す選択もある。→ このままでいいか？
7. **文書/コードの言語**: 散文 = 日本語、スキーマ/識別子 = 英語。→ claude-code 投入用に全英訳版も要るか？
8. **状態管理**: Zustand 推奨。→ 指定あるか？

### 追加検討の確定（このリビジョン）
- **Web Bundle Export**（§11.7 / INV-7 / INV-8 / `exportStrategy` / M5）。**確定**（実装は MVP 後、境界は M1 で先取り）。
- **UI / ワークスペース**（§19）: MVP は固定レイアウト + スプリッタ resize、ドッキング/デタッチは将来。**確定**。

---

## §19. UI / ワークスペース（パネル & ドッキング）

> 従来この仕様にウィンドウ構成の規定が無かったため追加。エンジン SSoT とは独立した UI アーキテクチャ層。

### §19.1 方針（確定）
AE / VSCode / Illustrator 風の **単一ウィンドウ + 複数パネル**。MVP では「ドッキング可能になるよう設計しておくが、実装は固定レイアウト + スプリッタ resize に留める」（レンダラ抽象化と同じく**境界だけ今切る**）。

### §19.2 パネルアーキテクチャ（確定・後方互換のため今決める）
- **パネルは ID で引ける自己完結ユニット**（`preview` / `timeline` / `project`(assets) / `inspector` / `pipeline` / `log` …）。各パネルは自分の状態を持ち、他パネルと直接結合しない（共有は `@mafter/runtime` / エディタストア経由）。
- **レイアウトは直列化可能なツリー**で表現する（VSCode / 各種 docking lib と同型）:

```ts
type LayoutNode =
  | { type: "split"; dir: "row" | "col"; sizes: number[]; children: LayoutNode[] }
  | { type: "tabs"; active: number; panels: PanelId[] }
  | { type: "panel"; panel: PanelId };
```

- **MVP の既定レイアウト**: 中央 `preview` / 下 `timeline` / 左 `project` / 右 `inspector`。MVP はこのツリーを固定し、`split.sizes` のスプリッタ resize のみ可変。ドラッグ・ドッキング、`tabs` 並べ替え、パネル追加/削除は §19.4 将来。

### §19.3 状態の置き場所（確定・重要）
- **レイアウト/ワークスペース状態は `project.json` に入れない**（作品データではない・Git を汚す・ポータブルでない、INV-4 の minimal diff を壊す）。
- ユーザ/アプリ設定ストアに保存（ブラウザ=IndexedDB or localStorage の設定領域、アプリ版=OS のユーザ設定）。プロジェクト横断で保持。

### §19.4 将来（§16 にも記載）
- **ドラッグ・ドッキング / タブ並べ替え / パネル追加削除**: `LayoutNode` ツリーを編集可能にするだけの増分。MVP の固定ツリーが土台になる。
- **デタッチ（別ウィンドウ）**: ブラウザ = `window.open` 子ウィンドウ + `BroadcastChannel`/`SharedWorker` でストア同期、アプリ版 = ネイティブ OS ウィンドウ。状態同期が要るため独立フェーズ。
- **実装方針**: ドッキングは自作せず **dockview / FlexLayout / rc-dock / react-mosaic** 等を評価して採用（車輪の再発明回避、Remotion と同じ姿勢）。ただし上記 `LayoutNode` の直列化形と状態置き場所（§19.3）は採用ライブラリに依存せず本仕様側で固定する。

### §19.5 Pipeline パネル（パイプライン可視化・確定 2026-06-20）

現在のアクティブ comp が live / raster の経路を何段通るか（= §27.4.1 合成順序の multi-pass flush 段数）を可視化し、軽量維持派が `live→raster→live` の崖を避け、映像派が必要なだけ raster できるようにする。

- **配置**: 既定レイアウトの左カラム（`project`）を col split `[project, pipeline]` 化（§19.2 既定ツリーへの追加）。レイアウトは project.json に入れない（§19.3）。旧レイアウト（左 `project` 単一）は migration で補正。
- **表示（progressive）**:
  - 既定: **サマリ1行**（例 `raster 2段・やや重い`。段数 0 / 1 / 2+ で色分け。閾値は §28 リアルタイム判定と整合）。
  - クリック展開: **レイヤースタックを zOrder 順に縦並び**、各段に live / raster バッジ、**raster 確定境界をハイライト**、**「減らせる崖」**（無駄な live↔raster 交替）を警告表示。precomp はネスト展開（depth 表示）。
- **算出**: §27.4.1 合成順序に基づく純関数 `pipelineAnalysis(comp)`（comp を zOrder 昇順走査 → 段リスト・raster 確定境界・段数・崖。precomp 再帰 depth ≤ 4）。`executionPath`（§27.2）/ `adjustmentMode`（§27.4）/ `isAdjustment` を根拠に判定。
- **依存**: 正確な判定は `executionPath` メタと Live/Raster 調整レイヤー（§27.4 / §27.13）の実装が前提。
- **非目標**: パネルからの直接編集（並べ替え等）は将来（§19.4）。可視化のみ。
- **INV-7**: UI 層（エディタ側）。`pipelineAnalysis` は runtime 純関数（DOM/乱数なし・INV-1 と整合）。
- **透過チャンネル二重描画警告（確定 2026-07-06）**: live/raster の段数とは独立した軸として、comp 内の `video` component が参照する asset の `meta.alphaMode === "split"`（Subject Extract split alpha・§16.2）であるレイヤーを検出し、崖警告と同様の警告 UI で表示する。split alpha は color WebM + グレースケール mask WebM の2本 `<video>` を毎フレーム CPU で合成する（`getImageData`×2 → `putImageData`）ため、他の全レイヤーが前提とする「GPU compositing のみ」という preview パイプラインの前提を破り、live 再生の同期ドリフト要因になる（[doc/issue/subject-extract-split-alpha-webm-preview-instability.md](issue/subject-extract-split-alpha-webm-preview-instability.md)）。precomp ネストも再帰的に検出する。**対象外**: unified alpha（単一 VP9 alpha WebM・ブラウザネイティブ透過・二重描画なし）、track matte（`applyTrackMatte` も毎フレーム canvas 合成だが別機構・別軸）。

---

## §20. Project パネル / コンポジション管理（UI 層・MVP 後の UX 拡張）

> §19 の続き。「AE の Project パネル概念」と「アクティブコンポジションの明示」を規定する。`Project.compositions` / `rootComposition` / `currentCompId`(エディタ状態) は既存。**§20.5 Project Bin** は additive スキーマ例外（`bins` / `treeOrder` / `binId`）。それ以外の本節は **UI 層と store 操作の規約**。

### §20.1 Project パネル（= AE の Project パネル相当）

`project` パネル（§19.1 の左パネル）は **プロジェクトに属する全アイテムの一覧**を表示する。AE 同様、ここは「素材とコンポの倉庫」であり、**レイヤー一覧ではない**（レイヤーは Timeline パネルが持つ。§20.4）。**§20.5** により単一ツリー（仮想フォルダ対応）。

表示する 2 系統:

- **Compositions** — `project.compositions` の全要素（`timeline` / `html` 両 kind）。
  - 各行は `name` ＋ kind バッジ ＋ `width×height @ fps` ＋ `duration`。
  - **timeline comp** の行クリック = そのコンポを**アクティブにする**（`setCurrentComp(id)`）。アクティブ行はハイライトする。
  - **html comp** の行クリック = §7 の `html` コンポーネントとして**現アクティブ comp のタイムラインに配置**する（既存 `addHtmlInstance`）。html comp は「タイムラインを持たない素材（footage/precomp 相当）」であり、それ単体を編集対象として開かない（§20.3）。
- **Footage / Assets** — `project.assets`（audio / image / video / font / other）。クリックで該当レイヤーをアクティブ comp に追加できる（種別が対応するもの。MVP は audio / image / video）。

操作:
- **`+ Composition`**: 新規 timeline comp を作成（既定 1920×1080 @30fps / 5s, name `Comp N`）して即アクティブにする。
- **`+ HTML Comp`**: 既存どおり html comp を作成（FS スターター生成）。
- **コンポのリネーム / 削除**を提供する（§20.2）。
- **Footage（audio / image / video）の削除**を提供する（§20.2b）。使用中の場合は確認ダイアログを出し、素材と参照レイヤーを 1 command（undo 可）で削除する。
- **`⬇ zip`（プロジェクト zip 書き出し）**: ブラウザダウンロード前に `saveToFs` → FS 走査 → JSZip 圧縮の前処理が走る。大きい `assets/*` では数秒以上かかるため、**Project パネルヘッダ内でインライン進行表示**する（ボタン `⬇ 準備中…` ＋ フェーズ文言: 保存中 / 読み込み中 n/m / 圧縮中 %）。§20.4b の「はい（保存）」経路でも同じ状態をモーダル内に表示する。

### §20.2 コンポジションの作成・切替・削除（store 操作）

エディタ store に以下を追加する（すべて command 経由で undo 可能、§17。`currentCompId` はエディタ状態であり undo 対象外）:

```ts
addTimelineComp(name?): CompId          // 新規 timeline comp を作成し currentCompId を移す
removeComposition(id): void             // comp を削除
renameComposition(id, name): void       // 表示名変更（INV-6: 参照は id なので安全）
setCurrentComp(id): void                // 既存。アクティブ comp を切替（frame を 0 に戻す）
```

**削除の不変条件（確定）:**
- **最後の timeline comp は削除できない**（プロジェクトは最低 1 つの timeline comp を持つ）。
- 削除対象が `rootComposition` なら、`rootComposition` を残った別の timeline comp（id 昇順で先頭）に張り替える。
- 削除対象が `currentCompId` なら、`currentCompId` を `rootComposition`（張り替え後）に移す。
- html comp 削除時は `compositions/<id>/` 配下の FS ファイルも削除する（best-effort）。
- **ダングリング参照の方針（MVP）**: 削除した html comp を `compId` 参照している `html` コンポーネント（他 comp 上のインスタンス）は**カスケード削除しない**。参照先不在は DomRenderer / HtmlCompPlayer 側で「何も描かない」で安全に縮退する（§7 の throw→silent と同方針）。整合性の自動掃除は §16 将来。

### §20.2c Footage からのコンポジション作成（右クリック・store 操作・確定 2026-07-06）

Project パネルの image / video アセット行を右クリックすると、共有コンテキストメニュー基盤
（`useContextMenuStore` / `ContextMenuHost`）経由で「このファイルでコンポジットを作成」を表示する。
audio / font / other はメニュー対象外（ブラウザ既定メニューのまま、挙動変更なし）。

```ts
addCompositionFromAsset(assetId): CompId | null
```

- 対象は `AssetEntry.kind` が `"image" | "video"` のみ。それ以外・asset 不在は `null`。
- `width` / `height`: `asset.meta.width/height`（正の number）があればそれを使用、無ければ `1920×1080`。
- `fps`: 常に `30`（ソースの実フレームレートは probe していないため。既存 `addTimelineComp` の既定と同じ）。
- `duration`（frame）: `kind === "video"` かつ `asset.meta.duration`（秒、正の number）があれば
  `round(duration * fps)`、それ以外（image、または video で meta 欠損）は既定 `150`（5s@30fps）。
- comp 名: アセットのファイル名から拡張子を除いたもの。
- 内部実装: `addTimelineComp(name, { width, height, fps, duration })` で comp を作成（`currentCompId` が
  切り替わる）→ 続けて `addImageLayer` / `addVideoLayer` でその asset を新 comp のレイヤーとして配置し選択する。
  2 つの既存 command の連鎖のため **undo は 2 step**（Add Composition → Add image/video の順）。
- 新規 comp は既存 `addTimelineComp` と同じくプロジェクトツリーの**ルート**に作成する
  （ソース asset と同じ bin には入れない）。

### §20.2b Footage 削除（store 操作・確定 2026-06-24）

```ts
removeAsset(assetId): void   // audio / image / video の Footage を削除（undo 可）
```

**削除の不変条件（確定）:**
- 対象は `project.assets` の `kind === "audio" | "image" | "video"` のみ（font / other は将来）。
- **参照レイヤーのカスケード削除**: 全 timeline comp を走査し、`audio` / `image` / `video` コンポーネントの `props.asset` が一致する `SceneObject` をまとめて削除する（1 command = 1 undo）。
- 使用中の場合は Project パネルで確認ダイアログを表示する（レイヤー数を明示）。
- FS の `assets/` ファイルは best-effort で削除する。audio の場合は decode バッファ・波形キャッシュも evict する。
- 削除したレイヤーが選択中なら選択を解除する。

### §20.3 アクティブコンポジションの明示（確定）

「いま編集している comp」を常に視覚的に明示する:

- **Preview パネル上部のコンポタブ**: 全 **timeline comp** をタブとして並べる（AE のコンポビューア相当）。アクティブタブをハイライトし、`name` を表示。タブクリックで `setCurrentComp`。
- Preview / Timeline のヘッダにアクティブ comp の `name` と `width×height @ fps` を表示する。
- Project パネルのアクティブ comp 行をハイライトする。

html comp はタブに出さない（編集対象の timeline ではないため。§20.1）。

### §20.4b プロジェクト切替時の保存確認ダイアログ（確定 2026-06-23・`⬆ zip` 追記 2026-06-29）

`New`（新規プロジェクト）および `⬆ zip`（プロジェクト zip のインポート＝別プロジェクトファイルを開く）操作は現在の作業内容を破棄するため、クリエイティブソフト一般の作法に倣い、**実行前に保存確認モーダルを表示する**。データモデル・store スキーマには新フィールドを足さない（UI 層の規約）。

- **表示条件**: `New` または `⬆ zip` を押したら**常に表示**する（dirty 判定は持たない。理由: 本アプリは §17 の `applyCommand` 経路で編集ごとに IndexedDB へ自動保存しており、「IndexedDB 基準の未保存」は常に無い。zip 基準の dirty 追跡は将来課題）。
- **モーダル見出し**: `New` →「新規プロジェクト」、`⬆ zip` →「プロジェクトを開く」。本文は共通（現在のプロジェクト名＋「保存しない変更は失われます」）。
- **選択肢（3 ボタン・AE 準拠）**:
  - **はい（保存）**: 現在のプロジェクトを zip 保存してから続行する。
    - **web 版**: zip ダウンロード（`exportZip` 経路。アプリ外への唯一の永続化）。
    - **デスクトップ版（Electron シェル起動のみ実装済み・ネイティブ保存ダイアログは未実装）**: `electron/` に開発起動用の Electron ラッパー（`frame:false` の自前タイトルバー、フィードバック送信はメインプロセス経由 IPC）を追加済み。ただし OS のファイルダイアログで保存先を指定して書き出す機能はまだ無く、Electron 上でも web と同じ zip ダウンロード経路にフォールバックする（TODO コメントは `ProjectPanel.tsx` に残置）。
    - 続行: `New` → `newProject()`、`⬆ zip` → OS ファイル選択ダイアログを開き、選択後 `importZip` → `loadFromFs`。
  - **いいえ**: 保存せず続行する（`New` → `newProject()`、`⬆ zip` → ファイル選択ダイアログのみ）。
  - **キャンセル**: 何もせずモーダルを閉じる（新規作成・インポートともに行わない）。
- モーダルは §11.2 ExportDialog と同じ overlay スタイルを踏襲する（中央・暗幕・`zIndex` 最前面）。Esc / 暗幕クリックは「キャンセル」と等価。
- zip 保存実行中（「はい」押下後）はモーダル内に §20.1 と同じ zip 前処理フェーズ文言を表示し、全ボタンを無効化する（二重実行防止）。

### §20.4 パネル責務の分離（確定・§19.2 の明確化）

| パネル | 責務 |
|---|---|
| `project` | プロジェクトに属する **comp 一覧 + 素材一覧 + plugins**（倉庫）。レイヤーは持たない。 |
| `timeline` | **アクティブ comp のレイヤー一覧**（`objects`）+ スクラバ + KF + レイヤー追加/削除/可視性。 |
| `preview` | アクティブ comp の描画 + コンポタブ + 再生コントロール。 |
| `inspector` | 選択レイヤーのプロパティ。 |

レイヤーの追加（solid/text 等）と削除は **Timeline パネル**で行う（AE と同じく「コンポを開いている状態でレイヤーを足す」モデル）。Project パネルからレイヤー一覧を撤去する。

### §20.5 Project Bin（仮想フォルダ・additive スキーマ・確定 2026-06-26）

AE の Project パネル相当の **整理用仮想フォルダ**。`resolve()` / export / 参照 id（INV-6）には**一切影響しない**（倉庫の棚ラベルのみ）。

**スキーマ（§5 additive・byte 等価）**:
- `Project.bins?: ProjectBin[]` — フォルダ定義（`parentId: null` = ルート直下のフォルダ行）
- `Project.treeOrder?: Record<string, ProjectTreeEntry[]>` — 各親内の表示順。キー `""` = ルート
- `CompositionMeta.binId?` / `AssetEntry.binId?` — 所属フォルダ（省略 = ルート）

**正準化**:
- `bins` は id 昇順ソート
- `treeOrder` の各配列は**ユーザー順を保持**（id ソートしない）
- `binId` / 空 `bins` / 空 `treeOrder` は省略（既存 project.json と byte 等価）

**load 時**:
- 未知 `binId` → root 扱い + warn
- bin 親循環 → `ProjectError`
- `treeOrder` 未設定 → id 昇順で自動生成

**store 操作（undo 可）**:
```ts
createBin(parentBinId?, name?): BinId
renameBin(id, name): void
deleteBin(id): void          // 中身を親へ移動してから削除
moveProjectEntries(entries, targetBinId, index): void
```

**UI**:
- Project パネルは **単一ツリー**（comp / footage / bin 混在）。Plugins は Bin 対象外（下部固定）
- 新規 import / `+Comp` / `+HTML` は **常にルート末尾**（v1）
- フォルダ開閉は **localStorage**（project.json 非直列化）
- 検索: 名前フィルタ + マッチ祖先 bin を自動展開
- ツリー内 DnD: フォルダ行へドロップで移動（`application/x-mafter-project-tree`）。Timeline 配置 DnD（`application/x-mafter-item`）とは別 MIME

---

## §21. Timeline パネル / AE 相当のタイムライン編集（UI 層・MVP 後の UX 拡張）

> §20.4 の Timeline パネル責務を AE に近づけるための詳細規約。**エンジン SSoT（§5 スキーマ）は変更しない** — `inPoint`/`outPoint`/各 `AnimatedProp`/`Keyframe`、および footage 系コンポーネントの源時刻オフセット（`video`/`audio` の `trimStart`、`html` の内部 `inPoint`）は**既存フィールド**である。本節は **UI 層と store 操作の規約**。

### §21.0 スコープ（段階導入・確定）

AE タイムラインの機能を **Tier A〜D** に分け、本リビジョンで **Tier A のみ**を実装する。B〜D は `progress.md` に優先度高めのバックログとして記録し、別リビジョンで §5 スキーマ拡張・INV 影響評価を伴って導入する。

| Tier | 内容 | スキーマ影響 | 区分 |
|---|---|---|---|
| **A** | プロパティツリー展開 / per-property ストップウォッチ＋値編集 / KF 行 / レイヤーバーの drag（in/out トリム・スライド）/ 時間ルーラー＋SMPTE タイムコード / レイヤー番号 | **なし**（既存スキーマで成立） | **本リビジョン** |
| **B** | **ラベル色（§21.10 部分実装済み）** / **lock（§21.11 部分実装済み）** / solo / shy / **親とリンク(parent) ドロップダウン UI（§21.8 部分実装済み）** | additive（`SceneObject` にフラグ追加） | 将来（優先度高） |
| **C** | **ブレンドモード（§5.4d 実装済み）** / **トラックマット（§5.4f 実装済み）** | renderer(INV-3)＋export 経路拡張 | 本実装（live SVG mask） |
| **D** | モーションブラー / フレームブレンド / 3D レイヤー / 調整レイヤー | 大規模・決定論モデル評価要 | 将来 |

### §21.1 タイムコード表示（確定）

- **正準単位は整数 `Frame`（INV-5 不変）**。タイムコードは**派生表示のみ**で、内部状態・直列化には一切影響しない。
- 表示形式は **AE 既定 `H:MM:SS:FF`（non-drop）**。`f = round(fps)` とし、`FF = frame % f`、`SS = floor(frame/f) % 60`、`MM = floor(frame/(f*60)) % 60`、`H = floor(frame/(f*3600))`。`MM`/`SS`/`FF` は 2 桁ゼロ埋め、`H` は非ゼロ詰め（§5.6 Duration と同一フォーマット）。実装は `src/editor/timecode.ts` の `framesToTimecode` を**唯一の共有実装**として使う（タイムライン toolbar・ルーラー目盛り・現在時刻／尺の右上表示・Inspector Duration がすべて一致）。
- **現在時刻／尺の右上表示（確定・2026-06-25）**: タイムラインパネル右上は従来の生フレーム `F{frame} / {duration}` ではなく `framesToTimecode(frame) / framesToTimecode(duration)` を表示する（クリック編集は持たない純表示）。
- ドロップフレーム（`0;00;00;00`）は §16 将来（整数 fps では non-drop と一致するため MVP 不要）。

### §21.1b BPM 併記表示（確定・2026-06-29）

- **目的**: 音楽 MV 等で「今が何小節目・何拍目か」を編集中に把握する**非破壊の編集補助**。`bpm` / `beatsPerBar`（§5.6 CompositionMeta）を読み、タイムコードに `Bar.Beat` を**併記**する。内部時間・直列化・resolve・export には一切影響しない（INV-5 不変）。
- **無効時（`bpm` 省略 or `0`）**: 従来どおりタイムコードのみ。表示は**完全無変更**（既存 verify 無回帰）。
- **変換（純関数・`src/editor/beatTimecode.ts`）**: `totalBeats = (frame / f) * (bpm / 60)`（`f = round(fps)`）。`bar = floor(totalBeats / beatsPerBar) + 1`、`beat = floor(totalBeats mod beatsPerBar) + 1`（ともに 1 始まり）。拍境界の浮動小数誤差を避けるため `totalBeats` に微小 epsilon を加えてから floor する（例: 120 BPM @ 30fps で frame 60 = `2.1`）。`beatsPerBar` 省略 = 4。`bpm <= 0` は `null` を返し UI 側で併記を省く。
- **併記形式（toolbar）**: `` `${framesToTimecode(...)} · ${bar.beat}` ``（` · ` 区切り）。タイムライン toolbar 現在時刻・右上 current/duration に適用。`framesToTimecode` は §21.1 の唯一実装を引き続き共有する。
- **ルーラー二段表示（bpm > 0 のとき）**: 時間ルーラーを上下に二分割し、**上段＝タイムコード目盛り（従来どおり）／下段＝Bar.Beat 目盛り**を表示。下段は**拍に整列した独自目盛り**（タイムコード間隔のままだと中途半端な拍値になるため、拍/小節単位で適応的に間引く。小節頭は明色）。`bpm` 無効時は従来どおり上段タイムコードのみ（分割なし）。これは**表示のみ**で、スクラブ・KF・in/out 等タイムラインの挙動は一切変えない（INV-5 不変）。
- **スコープ外（将来）**: 拍/小節へのスナップ、ルーラーの拍単位切替、Preview パネル併記、downbeat offset。

### §21.2 プロパティツリー（確定）

- 各レイヤー行は**展開トグル**（caret）を持ち、展開すると **トランスフォーム**グループ（anchor / position / rotation / scale）＋ **opacity** のプロパティ行を表示する。
- 各プロパティ行は次を持つ:
  - **ストップウォッチ**（KF 有効/無効トグル）:
    - OFF→ON: 現 frame に現在サンプル値で最初の KF を打つ（`keyframes` が 1 個になる）。
    - ON→OFF: `keyframes` を空にし、`value` を現 frame のサンプル値に固定（静的化）。
  - **値表示＋インライン編集**（現 frame の値）。編集時、その property が **animated（KF あり）なら現 frame に KF を打つ/更新**、static なら `value` を更新する。
  - **KF 行**（グラフ領域）: keyframe を frame 位置にダイヤで表示。
  - **KF ダイヤのドラッグで frame 移動**（確定）: ダイヤを左右ドラッグで `Keyframe.frame` を変更する。**delta ベース**（つかんだ位置からの相対）で `[0, duration]` にクランプ。`value` / `easing` は保持。移動先 frame に**別の KF が既に存在する場合は上書き**（KF は frame をキーとする）。ドラッグ中はライブプレビュー、mouseup で 1 command 確定（§17, undo 可能）。
- すべての編集は command 経由（§17, undo 可能）。

### §21.3 レイヤーバーの編集（確定・「どこから/どこまで描画するか」）

グラフ領域のレイヤーバーをドラッグして、長い素材/コンポの可視区間を AE 同様に操作する。frame↔px はトラック領域幅から導出（`comp.duration` を全幅にマップ）。ドラッグ確定時に 1 command を積む（ドラッグ中はプレビュー、mouseup で確定）。

- **右端ドラッグ → `outPoint`（どこまで）**。clamp `[inPoint+1, duration]`。
- **左端ドラッグ → `inPoint`（どこから, comp 時間）**。clamp `[0, outPoint-1]`。
  - **footage 系レイヤーは源時刻オフセットを連動**させる（AE と同じく、エッジ下の素材フレームを固定したままトリム = 「素材のどこから描くか」）。Δ = `newInPoint - oldInPoint` を、最初に該当する源オフセットプロップへ加算: `video`/`audio` は `trimStart += Δ`、`html` は内部 `inPoint += Δ`。clamp `≥ 0`。
- **バー本体ドラッグ → スライド**: `inPoint`/`outPoint` を Δ だけ平行移動（尺保持）。源オフセットは変えない。clamp `inPoint ≥ 0`。
  - **キーフレーム追従（確定・AE 準拠）**: スライドはレイヤーの**アニメーション全体を一緒に動かす**。すなわち当該オブジェクトの全 `AnimatedProp`（transform 各軸 / opacity / component props の Animated) の各 `Keyframe.frame` を **Δ だけシフト**する。キーフレームは comp 絶対 frame（§5.4-note）だが、スライド時のみまとめてシフトすることでレイヤーに対する相対タイミングを保つ。**トリム（in/out 端ドラッグ）はキーフレームを動かさない**（可視窓だけ変える）。
- **プレイヘッド / 時間ルーラー**: ルーラークリック・プレイヘッドドラッグで `currentFrame` を設定（clamp `[0, duration]`）。
- **テキスト選択抑止**: ドラッグ操作で文字列選択が走らないよう、Timeline パネルは `user-select: none`（数値入力欄のみ `user-select: text`）。

> 源時刻オフセット連動が「素材のどこから描画するか」、`outPoint` トリムが「どこまで描画するか」に対応する。`inPoint`/`outPoint` は既存スキーマ、`trimStart`/html `inPoint` は既存コンポーネントプロップであり、**Tier A はスキーマを一切変更しない**（§4 INV 保持）。

### §21.4 store 操作（Tier A）

既存 `updateObject`（command 経由）で `inPoint`/`outPoint`/`transform`/`opacity`/`components` を patch する。Tier A 専用の最小ヘルパーをパネル内に置く（store API を増やしすぎない）。`currentFrame` は既存 `setFrame`（エディタ状態, undo 対象外）。

**レイヤー選択解除（確定）**: `selectedObjectIds` が空のとき Inspector は **Composition** インスペクター（§5.6 背景編集等）を表示する。解除操作: **Escape**（入力欄フォーカス中は無効）、**タイムライン ruler 左のラベル列空白クリック**、`setCurrentComp` / 新規 comp 作成時の自動クリア。Ctrl/Cmd+クリックで最後の 1 レイヤーをトグル解除しても空になる。

**複数オブジェクト横断の 1-command 編集**（§21.5 用）: 複数の `SceneObject` への patch を**1 つの command（1 undo）**で確定する `updateObjects(patches, label)` を追加する。`patches` は `{ id, patch }[]`。内部は既存 command 層（before/after スナップショット, §17）で実装し、`withCompObjects` を 1 度だけ通して全 patch を適用する。スキーマには影響しない。

### §21.5 キーフレーム複数選択（確定・Tier A 拡張）

AE 同様、KF 行をまたいで複数キーフレームを選択し、まとめて移動・削除できる。**スキーマ・直列化には一切影響しない**（UI 選択状態はエディタの一時状態であり、undo 対象でも `project.json` 対象でもない）。

- **選択モデル**: 選択は `(objectId, propertyPath, frame)` の集合。`propertyPath` は Tier A で行表示される `transform.anchor` / `transform.position` / `transform.scale` / `transform.rotation` / `opacity`。選択状態は Timeline パネルのローカル状態（store にもプロジェクトにも載せない）。アクティブ comp 切替時にクリアする。
- **ラバーバンド選択（ドラッグ）**: グラフ領域の**空白部**（KF ダイヤ・レイヤーバー・ラベル列の上以外）で mousedown→ドラッグすると矩形選択を開始。**展開中の全レイヤー・全プロパティ行を横断**し、矩形に**中心が入る** KF ダイヤをすべて選択する。
  - 修飾なしドラッグ: 矩形内 KF で**置き換え**。空ドラッグ（矩形が KF を含まない）/ 空クリックは選択クリア。
  - `Shift`+ドラッグ: 既存選択へ**追加**。
- **KF クリック / Shift クリック**: KF ダイヤを単独クリックすると**その 1 個だけ**選択。`Shift`+クリックで選択に**トグル追加**。
- **まとめてドラッグ移動**: 選択中の KF ダイヤをドラッグすると、**選択中の全 KF を同じ Δframe で平行移動**する（§21.2 単独移動の一般化）。Δ は**選択集合の最小/最大 frame** が `[0, duration]` を超えないようクランプ。移動先 frame に非選択 KF があれば上書き（§21.2 と同じ frame=キー規約）。ドラッグ中はライブプレビュー、mouseup で **`updateObjects` による 1 command** を確定（undo 可能、複数オブジェクトをまたいでも 1 undo）。移動後は選択を移動先 frame に追従させる。
  - 非選択 KF をドラッグした場合は、まずその 1 個を選択してから単独移動（= 選択置換）。
- **まとめて削除**: `Delete` / `Backspace` で選択中の全 KF を削除（入力欄フォーカス中は無効）。`updateObjects` で 1 command 確定。削除後は選択クリア。
- すべての確定編集は command 経由（§17, undo 可能）。**INV-5 不変**（frame は整数）。

### §21.6 U / UU キー（確定・AE 準拠、Tier A 拡張）

**スキーマ・直列化への影響なし**。展開状態はエディタの一時状態（store/project.json に載せない）。

- **U キー**: 選択レイヤーを「KF ありプロパティ行のみ」展開する。
  - 対象: `selectedObjectIds` に含まれるレイヤーのみ（選択がなければ無視）。
  - すでに KF モードで展開中 → 折りたたむ（toggle）。
  - それ以外（閉じ or 別モード）→ "kf" モードで展開し、KF を持つプロパティ行のみ表示する。
- **UU キー**（300ms 以内に U を 2 回）: 選択レイヤーを「デフォルト値から変更されたプロパティ行のみ」展開する。
  - 変更済み判定: **KF あり** OR **static value がデフォルト値と異なる**（anchor/position/rotation: `{x:0,y:0,z:0}`、scale: `{x:1,y:1,z:1}`、opacity: `1`）。
  - すでに UU モードで展開中 → 折りたたむ（toggle）。
  - それ以外 → "uu" モードで展開。
- **UU タイミング**: 2 回目の U キー押下が 1 回目から 300ms 以内なら UU として扱う。1 回目の U が "kf" モードを設定した直後に 2 回目が来た場合は "uu" モードに上書き（1 undo にはならない：展開状態は undo 対象外）。
- **展開モード**: `"all"`（caret クリック, 全行）/ `"kf"`（U キー）/ `"uu"`（UU キー）。caret クリックは常に "all" に切替（"kf"/"uu" → "all" にアップグレード、"all" → 折りたたむ）。
- **アクティブ comp 切替**時に展開状態をすべてクリアする。
- 入力欄（input/textarea/contentEditable）フォーカス中は U/UU を無視する。

### §21.7 Duplicate / Split / コピペ（確定・Tier A 拡張）

**スキーマ・直列化への影響なし**。`Duplicate`（Ctrl+D）・`Split Layer`（Ctrl+Shift+D）・レイヤー/KF コピペ（Ctrl+C/X/V）は Timeline パネル + command 層で実装する。

- **Duplicate / Paste（レイヤー）**: 複製対象に新 ULID を振り `zOrder + 0.5` で挿入する（既存規約）。**複製セット内の `parent` 参照は旧 ID → 新 ID にリマップ**する（Null 親子をまとめてコピペしても階層が維持される）。複製セット外で comp 内に残る parent（子だけコピーした場合の既存 Null 等）は **ID を維持**。存在しない parent（カット後ペースト等で dangling になった参照）は **`null`（root）に正規化**する（load 時 validate と同趣旨）。
- **Paste 時間シフト**: クリップボード内の最も早い `inPoint` が現フレーム（再生ヘッド）に来るよう、全レイヤーの `inPoint`/`outPoint` とキーフレーム frame を同じ Δ で平行移動する（footage 源オフセットは変えない）。
- **KF コピペ**: KF 選択中は KF を、それ以外はレイヤーをクリップボード対象とする（AE 同様）。KF ペーストは現フレーム基準でオフセット。
- **実装**: [src/editor/duplicateObjects.ts](../src/editor/duplicateObjects.ts)（parent リマップ）/ [src/editor/commands.ts](../src/editor/commands.ts) `cmdDuplicateObjects` / [src/editor/panels/TimelinePanel.tsx](../src/editor/panels/TimelinePanel.tsx) クリップボード。

### §21.8 Parent リンク UI（Tier B 部分実装・確定）

AE の「Parent & Link」相当。**スキーマ不変** — 既存 `SceneObject.parent: ObjectId | null`（§5.4）を Timeline から編集する UI 層のみ。

#### §21.8.1 配置・選択肢

- 各レイヤー行ラベル列内、レイヤー名と削除ボタンの間に compact `<select>`（Parent プルダウン）。
- 選択肢: **`None`**（`parent: null`）+ comp 内他レイヤー。option ラベル = `name`。並び = タイムライン表示順（`zOrder` 降順）。
- **候補から除外**: 自分自身、自分の子孫（循環防止）。load 時 validate（§5.4-note）と整合。

#### §21.8.2 操作規約

- 確定は `updateObjects` 経由 **1 command / 1 undo**（§21.5）。
- **複数選択**: プルダウン操作行が選択集合に含まれるとき、**選択中の全レイヤー**に同一 `parent` を適用。含まれないときは操作行のみ。
- **world 保持（AE 準拠）**: 親変更時、world transform を維持するよう `transform`（position / rotation / scale）を補正。`anchor` は維持。編集時のみ行列計算（INV-1）。
- **animated（全 KF 補正・確定）**: KF あり Vec3 チャンネルは **現フレームだけでなく全 KF を各 frame で補正**する。各 KF frame `f` で `L_new(f) = invert(W_parentNew(f)) · W_childOld(f)` を decompose し、その frame の KF 値へ上書き（**KF 位置と easing は保持**、value のみ差し替え）。
  - **static 親（Null の常態 = 定数オフセット）** → 全フレーム厳密に world 保持（KF 間の補間結果も一致）。
  - **animated 親** → 各 KF frame では厳密保持・KF 間は近似（KF 表現の本質的限界・AE 同様）。
  - KF が無い（static）チャンネルは現フレームの decompose で `value` を更新。
  - ⚠ 旧実装は**現フレームの 1 KF のみ**補正していたため、KF 付きレイヤーを親付けすると他フレームで座標がずれるバグがあった（2026-06 修正）。`computeWorldTransforms` は対象 frame 集合（全 KF frame ∪ 現フレーム）に 1 回ずつ呼ぶ。
- 無効操作（循環・存在しない id）は UI で reject + ステータスフィードバック。project.json には書かない。

#### §21.8.3 実装タッチポイント

- [src/editor/parentLink.ts](../src/editor/parentLink.ts): 候補列挙・循環検証
- [src/editor/reparent.ts](../src/editor/reparent.ts): world 保持 reparent patch
- [src/editor/panels/TimelinePanel.tsx](../src/editor/panels/TimelinePanel.tsx): ParentSelect UI

### §21.9 レイヤー名リネーム（確定・Tier A）

**スキーマ不変** — 既存 `SceneObject.name`（§5.4）を Timeline / Inspector から編集する UI 層のみ。

- Timeline `LayerRow` のレイヤー名を **ダブルクリック → インライン編集**（§20.2 `renameComposition` と同パターン）。
- Inspector ヘッダでも編集可。
- `Enter` 確定 / `Escape` キャンセル / blur 確定。空文字（trim 後）は拒否（変更しない）。
- store: `renameObject(id, name)` — `renameComposition` と対称（§20.2）。command 経由で undo 可能（§17）。

```ts
renameObject(id: ObjectId, name: string): void  // 表示名変更（INV-6: 参照は id なので安全）
```

### §21.10 ラベル色 UI（Tier B 部分実装・確定）

AE のレイヤーラベル色相当。**additive スキーマ** — `SceneObject.labelIndex`（§5.4c）。**`resolve()` / export / preview には影響しない**（エディタ UI のみ、INV-1〜3 不変）。

#### §21.10.1 データモデル

```ts
/** ラベル色インデックス 0–16（0–15 = AE、16 = ベージュ）。省略 = 無色（既定グレー行）。 */
labelIndex?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;
```

- 直列化: `labelIndex` は **0–16 のときのみ** `project.json` に書く。`undefined` はキー省略（§5.6 正準化）。
- パレット: AE 16 色（0–15）+ **index 16 = ベージュ**（ラベル色導入前の LayerBar 既定 `#b89b6a`）。
- 17 色パレットは [src/editor/layerLabels.ts](../src/editor/layerLabels.ts) の `LAYER_LABEL_COLORS` 定数。

#### §21.10.2 UI 規約

- 各行左端に **12px の色ストリップ** を表示。`labelIndex` 省略時は**中立グレー**（種別既定には戻さない）。
- 色ストリップクリック → **17 色 + 「なし」** のパレットポップアップ。
- **タイムライン `LayerBar`（in/out バー）と `SourceGhostBars`** も `labelIndex` の色に連動する（選択時は明度アップ＋白枠で区別。固定の青/茶色は廃止）。
- **複数レイヤー選択時**: パレット選択で選択中全レイヤーに同一 `labelIndex` を適用（`updateObjects` 1 command / 1 undo）。
- Solid の塗り色チップ（§31）は **コンテンツ色**（`components[].props.color`）であり、ラベル色とは別物。ツールチップで区別する。
- キーボード `0`–`9` ショートカットは将来（本リビジョンではパレット UI のみ）。

#### §21.10.2b 種別既定ラベル色（確定）

新規レイヤー追加時（`cmdAddObject`）、`labelIndex` 未指定なら種別既定を **書き込む**（`project.json` に保存）。既存レイヤーのマイグレーションはしない。

| 種別 | 判定 | index |
|---|---|---|
| Solid | `components` に `solid` | 0（赤） |
| Text | `text` | 1（黄） |
| Footage | `image` / `audio` / `video` | 2（Aqua） |
| Camera | `camera` | 7（青） |
| Null | `isNull` | 4（ラベンダー） |
| Adjustment | `isAdjustment` | 5（オレンジ） |
| HTML / Precomp | `html` / `comp` | 9（紫） |
| Plugin / その他 | fallback | 14（Sandstone） |

実装: [src/editor/layerLabels.ts](../src/editor/layerLabels.ts) の `defaultLabelIndexForObject`。

パレット「なし」: `labelIndex` を `undefined` にし、UI は**中立グレー**（種別既定色には戻らない）。

#### §21.10.3 store 操作

```ts
setLayerLabelIndex(ids: ObjectId[], index: LabelIndex | undefined): void
```

- `index === undefined` でラベル色をクリア（「なし」→ 中立グレー表示）。
- command 経由で undo 可能（§17）。

### §21.11 レイヤーロック UI（Tier B 部分実装・確定）

AE のレイヤーロック相当。**additive スキーマ** — `SceneObject.locked`（§5.4e）。**`resolve()` / export / preview には影響しない**。

#### §21.11.1 操作（確定）

ロック操作の**唯一の入口**: タイムライン各行の**目アイコン**への **Shift+クリック**（独立ロック列・ショートカットは v1 では設けない）。

| 入力 | 効果 |
|------|------|
| 目アイコン **クリック**（Shift なし） | `enabled` トグルのみ（当該行）。`locked` 不変 |
| 目アイコン **Shift+クリック** | `locked` トグル。単独選択時はその行、**複数選択時は選択中全レイヤー**に一括適用（クリック行の `locked` を反転した値）。`enabled` 不変 |
| 目アイコン **右クリック** | コンテキストメニュー: **すべて表示** / **すべて非表示**。対象は**現在コンポ内のロックされていないレイヤーのみ**（ロック済みの `enabled` は変えない）。1 command / 1 undo |

4状態表示（`enabled` × `locked`）: 見える `👁` / 見えない `—` / 各ロック時は小さな `🔒` を併記。ツールチップで「クリック: 表示切替 / Shift+クリック: ロック切替 / 右クリック: 一括表示」を案内。

#### §21.11.2 ロック中の編集制限（AE 準拠）

- **ブロック**: 新規選択（行クリック・範囲選択の追加）・Inspector 編集・タイムライン KF/バー操作・リネーム・並べ替え・プレビューギズモ・削除・Duplicate / Split。複数選択にロック混在時は**ロック分をスキップ**して残りのみ操作。
- **許可**: 目アイコン（表示/ロック切替）、**ラベル色**（`labelIndex`）。
- **選択済みをロック**: 選択は**維持**（Inspector read-only・ギズモ非表示）。

#### §21.11.3 store / command

- `locked` / `enabled` / `labelIndex` の patch はロック中でも通過（exempt）。
- その他の patch は locked オブジェクトで no-op（command 不発行）。

---

## §22. グラフエディタ（値カーブ編集）— UI 層・MVP 後の UX 拡張

モーショングラフィックスの「詰め」に必須の、キーフレーム間カーブの視覚編集。**Phase 1 はスキーマ不変（Tier A）**で、Phase 2/3 は **additive スキーマ**（既存 project.json を破壊せずフォールバックで後方互換）として段階導入する。「先に全部」ではなく、データモデルを前方互換に保ちつつ UI を段階リリースする方針（再設計コスト最小）。

### §22.0 スコープ（段階導入・確定）

- **Phase 1（本リビジョン・スキーマ不変）**: 区間ごとの cubic-bezier ハンドルをドラッグ編集。値カーブ表示。対象は数値プロパティ（opacity / component scalar param）と Vec3（anchor/position/scale/rotation、**全成分が時間カーブを共有**＝§5.3 の現行モデル）。y∉[0,1] のオーバーシュート対応（[easing.ts](../src/runtime/easing.ts) は y をクランプしない）。
- **Phase 2（将来・additive）**: per-axis 値カーブ。`Keyframe<Vec3>` に**任意の per-axis easing override**（例 `easingX?/easingY?/easingZ?`）を追加し、無ければ §5.3 の共有 `easing` にフォールバック → 既存データはそのまま読める。
- **Phase 3（将来・additive + resolve 拡張）**: 空間モーションパス（position の Keyframe に任意の spatial tangent in/out Vec3 を追加、無ければ直線補間にフォールバック）と速度（speed）グラフ。`resolve()` の補間モデル拡張を伴うため INV-1/INV-2 の再検証が必要。

### §22.1 データモデル（Phase 1・スキーマ不変）

- 既存 `Keyframe.easing`（§5.3 `{type:"bezier", bezier:[x1,y1,x2,y2]}`）をそのまま編集対象とする。新フィールドを足さない。
- 区間 `[k_i, k_{i+1}]` の形は **`k_i.easing`** が決める（[interpolate.ts](../src/runtime/interpolate.ts) `segmentT`）。bezier の `(x1,y1)` は `k_i` の「出ハンドル」、`(x2,y2)` は `k_{i+1}` の「入ハンドル」に相当。
- x（時間軸）は `[0,1]` 単調・端は 0/1 固定。y は制限なし（オーバーシュート/アンティシペーション可）。
- `linear`/`hold` はハンドル編集開始時に bezier へ変換（linear→`[0,0,1,1]`）。

### §22.2 表示・操作（Phase 1）

- **トグル**: タイムラインツールバーの「📈 グラフ」ボタンで グラフモード ON/OFF（エディタ一時状態・project.json 非保存）。
- グラフモード中、展開中の数値プロパティ行のグラフ列を**背の高い値カーブレーン**に切替。Vec3 は x/y/z を色分けした 3 カーブで表示。
- 縦軸は表示中プロパティの値域に自動フィット（パディング付き）。横軸は既存 `viewRange`（§21 ズーム）に追従。
- **KF 点ドラッグ**: 時間（frame・整数=INV-5）と値の両方を移動（Vec3 は掴んだ軸の値）。
- **ハンドルドラッグ**: cubic-bezier 制御点を編集。out=`k_i.bezier(x1,y1)` / in=`k_{i+1}.bezier(x2,y2)`。x は当該区間内にクランプ、y はクランプなし。Vec3 は共有 easing を編集（Phase 1 の制約）。
- 1 操作 = 1 command（undo 可、§17）。

### §22.3 不変条件

INV-1〜6 を保持。Phase 1 は resolve・スキーマ・直列化に影響しない（既存 easing をそのまま使う）。KF の frame は整数を維持（INV-5）。

---

*v0.9 / MVP scope = M0–M4（Web Bundle Export は M5）。§20–§25 は MVP 後の UX 拡張（UI 層）。§22/§24 Phase 1 はスキーマ不変、Phase 2/3 は additive 拡張として将来。§25 Preview ビューア編集はスキーマ不変（既存 Transform への書き戻し・既存 mat4 ヘルパ利用）。このファイルが「エンジンを作るための SSoT」。`claude.md` が「エンジンを使うための SSoT」。*

---

## §23 コンポジション・レイヤー（comp layer / precomp）

timeline composition を別の timeline composition のレイヤーとして配置する機能（AE の precomp 相当）。

### §23.0 スコープ（Phase 1・スキーマ不変）

- **Phase 1（本リビジョン・スキーマ不変）**: `SceneObject.components[].type = "comp"` を新種として使用。スキーマ側は `Component.type: string` が任意文字列を許容しているため **追加型定義不要**。
- **Phase 2（将来）**: Inspector から `trimStart` を編集可能にする。子コンプのダブルクリックで切替（§20.3 準拠）。時間リマップ（AnimatedProp として `timeRemap` を追加）。
- **Phase 3（将来）**: ネスト内の html/plugin component のフル対応（現状は solid/text/image のみ正式サポート）。

### §23.1 データモデル（Phase 1）

```
SceneObject.components = [
  {
    type: "comp",
    props: {
      compId: string,    // 参照先 TimelineComposition.id（ULID, INV-6）
      trimStart: Frame,  // 子コンプの再生開始オフセット（デフォルト 0）
    }
  }
]
```

`compRef` は将来の仮名であったが、実装は `Component.type = "comp"` として統合した（`Component.type` は open-string なので既存スキーマに変更なし）。

### §23.2 時間マッピング（Phase 1・fps 対応 2026-06-24）

```
parentTimeSec = (parentFrame - layer.inPoint) / parentFps
childFrame     = clamp(round(parentTimeSec * childFps) + trimStart, 0, childComp.duration - 1)
```

- **秒ベースのマッピング**（AE 既定 ＝ "Preserve frame rate when nested" OFF 相当）。親と子の fps が異なっても**実時間で等速**に再生される。子は自身の fps グリッドでサンプルされる（INV-5: 正準単位は整数 Frame、秒は導出値）。
- **fps 一致時は従来式と完全に同一**: `round((pf-in)/fps*fps)+trim = pf-in+trim`。既存プロジェクト（親子 fps 一致）は描画・キャッシュキー（`precomp:{compId}:f{childFrame}`）ともにビット単位で不変＝後方互換。
- `trimStart` は引き続き**子コンプの frame 単位**。本コンポ（親）の fps 変更の影響を受けない。
- 親フレームが子コンプの `duration` を超えた場合は **最終フレームで停止（Freeze）** — AE のデフォルト同等。
- `layer.inPoint` と `parentFps` は DomRenderer が `resolve()` を通じて受け取る（resolved component props に `_inPoint` / `_parentFps` として注入）。`childFps` は `childComp.fps`。**`parentFps` は `resolve()` する comp の fps をその場で焼くため、DomRenderer の mount 時スナップショット（`this.currentComp`）に依存しない**（マウント後の fps 変更や comp 切替でも常に最新の親 fps が使われる）。
- AE の "Preserve frame rate when nested"（子を自身の frame 境界でのみ更新＝スタッター）個別トグルは将来（§23.0 Phase 2）。

### §23.3 レンダリング（Phase 1）

**nest アプローチ（AE の non-collapse 相当）**: 各 comp レイヤーに対してコンテナ div を作り、子コンプの objects をその内部に描画する。

- `DomRenderer.renderNestedComp(container, childComp, childFrame, depth)` が担当。
- depth ≤ 4 の再帰ネストを許可（循環参照が追加時に排除されるが念のためガード）。
- Phase 1 制限: コンテナ内での html/plugin component は描画されない（Phase 3 で対応）。
- 親レイヤーの `opacity`（`entry.div.opacity`）は CSS opacity の継承で自動的に子全体に乗算される。
- **ラスター化対象 comp の例外（§28.11）**: 子コンプが `compNeedsAutoPreviewCache` を満たす（displacement/raster を含む）場合、Phase 1 のライブ再解決ではなく comp 単位ラスタ（オフスクリーンで画像化）を `<img>` として描く。これにより precomp 内の effect/raster がプレビューに反映され、かつ comp 単位でキャッシュ可能になる。

### §23.3a ネスト内の blendMode / live effect（Phase 1.5・ラスター無し・AE non-collapse 準拠）

ネスト comp 内の各オブジェクトに設定された **描画モード（`blendMode`）** と **live filter 系 effect** を、ライブ再解決経路（`renderNestedComp`）でも適用する。トップレベル描画（`applyObject` → `applyBlendMode` / `applyEffects`）と挙動を揃え、precomp の中身が「ブレンド・エフェクトが効いた状態」で外側 comp に現れるようにする。**ラスター化を一切伴わない**（純 CSS / SVG filter）。

- **blendMode**: 各内側 div に §5.4d と同じ方式を適用（16種は `mix-blend-mode`）。トップレベルと共有する純関数ヘルパ `setBlendModeStyle(el, blend)` を用いる。
- **isolation 境界（AE collapse OFF = non-collapse 固定）**: ネスト comp コンテナに `isolation:isolate` を付与する。これにより**内部レイヤーのブレンドは precomp 内（自分の背景・下位レイヤー）で閉じ**、precomp 全体が1ユニットとして外側 comp に合成される。AE の既定（collapse transformations OFF）と一致し、`isolation` グループがネイティブに1枚へ合成するため**ラスター無しで AE と同じ結果**が出る。collapse ON（内部ブレンドが外側背面へ貫通）は将来。
- **live filter 系 effect のみ**: `EffectDef.apply()` が返す `css` / `svg` ピースのみ内側 div の `filter` に適用する。`kind:"raster"` のピース、および **full displacement**（`wave`/`ripple`/`turbulentDisplace`）は raster 経路を要するため**ライブ経路では適用しない**（それらを含む comp は §28.11 の comp 単位ラスタ経路に乗せて反映する）。`Fast*` displacement は region クランプ済みの live filter なので適用対象。
- **export 整合（INV-2）**: コンテナを `isolation:isolate` にすることで、export の Canvas 合成（`exporter.ts` `getCompositeLayers`＝トップレベル entry 列挙）でも、コンテナ div を1枚 capture する際に内部ブレンドがネイティブに焼かれ、preview と一致する。

> **注意点（既知の制約・追って対応）**
> - **full displacement / raster 系 effect は live 非対応**: ネスト内の `wave`/`ripple`/`turbulentDisplace` や `processPixels` 系は §28.11 の comp 単位ラスタ経路に依存する（ブレンドモード自体は全てラスタ無し）。
> - **3D（preserve-3d）× mix-blend-mode**: CSS 仕様上、`mix-blend-mode` は 3D 描画文脈を flatten する。ネスト内に 3D レイヤー＋ブレンドが混在すると AE と差が出る場合がある（エッジケース・別途検討）。
> - **Fast\* displacement の region**: ライブ再解決は毎フレーム DOM を再構築するため、内側 div の実測サイズが取れないフレームでは SVG filter region クランプが甘くなる可能性がある（blur/色補正等の通常 filter には影響なし）。

### §23.3b ネスト comp のカメラ（live・AE non-collapse 準拠）

ネスト comp（`renderNestedComp` のライブ再解決経路）は、**自身の active camera** を §6.5b と同方式で適用する。`resolve(childComp, childFrame)` が算出した `childScene.camera` を、トップレベル `renderFrame` と共有ヘルパ `setupCameraRig` でコンテナへ反映する。

- **カメラあり**: ネストコンテナに `perspective` + `perspective-origin:50% 50%` を設定し、各オブジェクト div の transform を `threeD === true` の層のみ `translate(cx,cy,P)·view·world` に焼く（2D 層はカメラ免除・§6.5b と同一）。
- **カメラなし**: `perspective` を設定せず、従来どおり生の `worldTransform` のみ。カメラ無しネスト comp は無回帰。
- **ラスタ無し**: §28.11 の comp 単位ラスタ経路（`renderNestedCompRaster`）は従来どおり `renderFrame` 経由でカメラ適用済み。本節はライブ経路のみを対象とする。
- **再帰ネスト**: 各階層のコンテナが自分の `perspective` を持つため、深いネストでも各 comp が自分のカメラで描かれる（collapse ON＝親カメラ貫通は将来）。

> **既知の制約（§23.3a と共通）**: ネスト内に 3D 層＋`mix-blend-mode` が混在すると CSS が 3D 文脈を flatten し AE と差が出うる。

### §23.3c ネスト comp の expression（live）

`renderNestedComp` は子 comp を**自前で `resolve(childComp, childFrame, ctx)` する**ため、トップレベル描画（`resolve(comp, frame, { expressions })`）と違い、**ctx に evaluator を渡さないと nested comp 内の expression が評価されず静的化する**（`wiggle` 等が止まり、opacity / effect param を expression で駆動している場合もその値が固定される）。

- **evaluator は comp 固有**（`ExpressionEngine.makeEvaluator(comp)` が comp の fps とレイヤー参照に束縛される）。よって **comp ごとに 1 つ用意**し、`DomRenderer.setCompEvaluators(Map<compId, ExpressionEvaluator>)` で注入する。
- `renderNestedComp` は `this.pendingCompEvaluators?.get(childComp.id)` を `resolve` の `expressions` に渡す。
- **配線箇所**（preview / export / bundle で同一の evaluator マップを用意し INV-2 を保つ）:
  - preview: `PreviewPanel` がプロジェクト内全 timeline comp を `prepare` → `setCompEvaluators`。
  - export: `exporter.ts` が `timelineComps` を `prepare` → `setCompEvaluators`。
  - bundle: `BundlePlayer` が同上。
- §28.11 ラスタ経路（`renderNestedCompRaster` / `compFrameCapture`）は子 comp ごとに evaluator を生成する。**深い階層（depth 2+）の live ネスト comp も評価できるよう、`createCompFrameCaptureContext` は捕捉対象だけでなくプロジェクト内全 timeline comp を `prepare` → `setCompEvaluators` する**（§23.3c と同型・補完）。

### §23.3d ネスト comp の調整レイヤー（live・backdrop-filter・collapse OFF）

ネスト comp 内の **調整レイヤー（`isAdjustment`）** を、トップレベル「Live 調整」（§27.4）と**同一機構＝ CSS `backdrop-filter`** でライブ適用する。**ラスター化を一切伴わない**。狙いは「複数シーン(comp)を 1 つにまとめて HTML で live 再生する」用途で、precomp 内の調整がネスト先でも効くこと。

- **適用方式**: 調整レイヤーの div を **comp 全面サイズ**（`childComp.width × height`）・`background:transparent`・`pointer-events:none` で該当 z-index に置き、`EffectDef.apply()` の css/svg ピースを **`filter` ではなく `backdropFilter`（+ `-webkit-backdrop-filter`）** に積む。これにより div の**背後（同一コンテナ内の下位レイヤー）**にライブで効く。
- **スコープ（collapse OFF 維持）**: ネストコンテナの `isolation:isolate`（§23.3a）が backdrop のスコープ境界になり、**調整は自 precomp 内に閉じる**（外側 comp の下位レイヤーには染み出さない）。collapse ON（親へ貫通）はレイヤー単位のオプトインとして将来。
- **SVG filter region**: 調整 div は中身が空で実寸が取れないため、displacement 等の SVG filter region は **comp 寸法**（`childComp.width/height`）でクランプする。
- **displacement**: `Fast*`（`fastTurbulentDisplace` 等）は region クランプ済みで backdrop に積める → **live**。**full displacement（`wave`/`ripple`/`turbulentDisplace`）は live 不可**なので調整でも skip（§23.3a と同方針・raster 経路が要る）。
- **adjustmentMode**: ネスト live 経路では `"live"` / `"raster"` 双方を backdrop-filter で近似適用する。決定論ラスタが要る場合は将来の強制ラスタライズ opt-in で受ける。
- **export（mp4/png/precomp raster）での解決（確定 2026-06-26）**: preview の `backdrop-filter` は foreignObject ラスタ化で背面参照が欠落する（§27.4）。これは**ネスト comp 内の調整でも同じ**で、親 comp の単一 capture では子 comp の調整が消える。よって export 経路はネスト comp を **§27.4.1 軸1「precomp は1枚に合成・確定してから親が1レイヤーとして扱う」に従い、子 comp 自身の座標系でオフDOM・ステートレスに z 順合成**してから（子内の調整を背面 master に焼いてから）親へ1枚の画像として置く。`renderNestedComp` は export 時、調整 div の `backdrop-filter` を立てず**解決済み effect chain をレイヤメタとして付与**し、コンポジタ（[`exportComposite.ts`](../src/runtime/exportComposite.ts)）が**再帰的に**（depth ≤ 4・§23.4）子 comp を合成する。**何段ネストしても**各段で調整が確定するため、preview と export が一致する（INV-2）。調整も blend も持たないネスト comp は従来どおり親の単一 capture に含めて焼く（3D 文脈を保つ高速経路）。

> **既知の制約（ユーザー了承済み「全力 Live・破綻許容」）**
> - `backdrop-filter` は `transform-style:preserve-3d`（カメラ・§23.3b）/ `mix-blend-mode`（§23.3a）と CSS 仕様上 相互に flatten しうる。調整 + カメラ + 3D + blend が同一 comp に混在すると AE と差が出る場合がある。破綻ケースは将来の collapse ON / 強制ラスタライズ opt-in で受ける。

### §23.4 循環参照制御

- `store.addCompLayer(compId)` において BFS で循環を検出し、循環が生じる場合は追加を拒否する（`null` 返却）。
- FS インポート等で循環が混入した場合は、`renderNestedComp` の depth guard で深度 4 以上の再帰を打ち切る（最悪でも無限ループにならない）。

### §23.4a 初期配置時のレイヤーバー尺（確定 2026-06-25）

`addCompLayer` で comp をタイムラインに配置するとき、レイヤーの `inPoint`/`outPoint` は **子コンプの再生可能尺** を §23.2 の秒ベースマッピングで親 frame に換算した値で初期化する（AE 準拠: 配置直後のバー長 = ソース comp の duration）。

- `inPoint = 0`、`trimStart = 0`（Phase 1 既定）。
- `outPoint = clamp(inPoint + round((childDuration - trimStart) / childFps * parentFps), inPoint+1, parentDuration)`。実装は `compLayerDefaultOutPoint()`。
- 子 comp が親より長い場合は `parent.duration` で打ち切る。
- 配置後のトリム・スライドは §21.3 の既存規約どおり（ユーザー操作で `outPoint` を変更可）。

### §23.5 AE との比較

| 項目 | AE | Mafter Phase 1 |
|------|-----|---------------|
| 配置方法 | Project パネル → Timeline DnD | 同じ（DnD のみ） |
| time mapping | 1:1（デフォルト） | 1:1（trimStart オフセットのみ） |
| time remapping | AnimatedProp として設定可 | Phase 2 以降 |
| collapse / non-collapse | 2 モード切替 | 常に non-collapse 相当（`isolation:isolate`・§23.3a） |
| nested 内のブレンド/エフェクト | precomp 内で合成 → 1枚で配置 | live filter + blendMode を内部適用（ラスタ無し・§23.3a）。full displacement/raster 系は §28.11 ラスタ経路 |
| nested 内のカメラ | precomp 内カメラで合成 → 1枚で配置 | 自カメラを live で適用（§23.3b・§6.5b 同一リグ）。collapse ON は将来 |
| nested 内の調整レイヤー | precomp 内で合成 → 1枚で配置 | `backdrop-filter` で live 適用・自 precomp 内スコープ（§23.3d）。full displacement は §28.11 ラスタ経路。collapse ON は将来 |
| precomp opacity | レイヤー全体で適用 | 同じ（CSS opacity 継承） |
| 循環参照 | UI 拒否 | 追加時に BFS 検出・拒否 |
| nested html/plugin comp | 専用レンダラ | Phase 3 以降 |
| 調整レイヤーの作用範囲 | comp スコープ（collapse 時は親へ展開） | 自 comp スコープ（non-collapse 固定・§27.4.1 合成順序） |

---

## §24 Flow 風イージングプリセットパネル（Ease Panel）— UI 層・MVP 後の UX 拡張

AE プラグイン **Flow** 相当の、イージングプリセットのグリッド選択 + カーブプレビュー + 選択 KF への一括適用パネル。**Phase 1 はスキーマ不変**（§5.3 `Easing` / §10 preset 形式をそのまま使う）。データモデルは §10、適用先の区間モデルは §22.1 を正とする。本セクションは UI 層と適用セマンティクスのみを定義する。

### §24.0 スコープ（確定）

- **Phase 1（本リビジョン・スキーマ不変）**: 独立した常設パネル（§19 パネルレジストリに登録）。組み込みプリセットグリッド + カーブプレビュー/編集 + ★ユーザープリセット保存 + in/out/both 適用。プリセットは**単一 cubic-bezier で表現可能なもののみ**（後述 §24.4）。適用は選択 KF の `easing` を `{type:"bezier"}` に**ベイク**して上書き（preset への live link は張らない）。
- **Phase 2（将来・additive）**: bounce / elastic 等の多段イージング。`Easing` に名前付き関数型（例 `{type:"func"; id:string}`）を追加する additive スキーマ拡張 + `resolve()` 補間拡張を伴うため、**INV-1/INV-2 の再検証が必要**。Phase 1 とは分離する。

### §24.1 パネル UI（Phase 1）

- **登録**: `LayoutNode` レジストリに `ease` パネルとして追加（§19）。レイアウト状態は project.json を汚さない（§19.3, localStorage）。
- 構成（Flow 準拠）:
  - **カーブプレビュー/エディタ**: 現在選択中の bezier を 0..1 グリッド上に描画。制御点（out=`(x1,y1)` / in=`(x2,y2)`）はドラッグ編集可能。x は `[0,1]` クランプ、y はクランプなし（オーバーシュート可、§22.1 と同一規約）。
  - **数値表示**: `x1, y1, x2, y2` を表示・直接入力可（例 `0.41, 0.02, 0.88, 0.21`）。
  - **プリセットグリッド**: 組み込み + ユーザープリセットをサムネイル（ミニカーブ）で並べる。クリックでカーブプレビューに読み込み（＝選択状態）。
  - **プリセットセット切替**: 名前付きセットのドロップダウン（既定 `default`）。MVP は `default`（組み込み）+ `user`（★保存先）の 2 セット。
  - **★保存**: 現在のカーブを `presets/easing/<id>.json`（§10 形式）に新規保存。`id` は ULID（INV-6）、`label` はユーザー入力（既定は連番）。
  - **方向トグル**: `in` / `out` / `both`（§24.2）。
  - **APPLY ボタン**: 選択 KF 群へ現在のカーブを適用（方向トグルに従う）。1 操作 = 1 command（undo 可、§17）。

### §24.2 適用セマンティクス（in / out / both）

区間 easing は `k_i.easing` が区間 `[k_i, k_{i+1}]` の形を決める（§22.1）。プリセットの bezier を `B = [x1,y1,x2,y2]` とする。選択された各 KF `k` について:

| モード | 操作 |
|--------|------|
| **out** | `k.easing` ← `{type:"bezier", bezier:B}`（`k` から次 KF への区間）。`k` が最終 KF なら no-op。 |
| **in** | `k` の**直前** KF `k_{i-1}` の `easing` を bezier 化し、その `(x2,y2)` を `B` の `(x2,y2)` で置換。`k` が先頭 KF なら no-op。 |
| **both** | out + in を両方適用（AE の Easy Ease と同じ「入り＋出し」両ハンドル整形）。 |

- `in` モードで直前 KF の easing が `linear`/`hold` の場合は `[0,0,1,1]` に変換してから `(x2,y2)` を上書き（§22.1 規約）。
- `both` は「`k` の入りハンドル（前区間の `x2,y2`）」と「`k` の出しハンドル（自区間の `x1,y1`）」を整える操作であり、`B` の前半 `(x1,y1)` を out 区間の入口に、後半 `(x2,y2)` を in 区間の出口に割り当てる。
- 複数 KF 選択・複数プロパティ横断（§21.5）に対応。Vec3 は共有 easing を編集（Phase 1 の制約、§22.0）。
- **1 適用 = 1 undo**。`updateObjects` / `setPropByPath`（§21.5 / §22.2 既存）で複数オブジェクト 1 command にまとめる。

### §24.3 既存 UI との関係

- §21 P0 の KF 右クリックイージングメニュー（F9=Easy Ease 等）は**ショートカット系**として残す。本パネルは**ビジュアル選択系**として併存（AE の F9 と Flow パネルの関係と同じ）。
- §22 グラフエディタはカーブの**直接編集**、本パネルは**プリセット適用**。両者は同じ `easing` データを編集対象とし、相互に結果が反映される（同一 SSoT）。

### §24.4 組み込みプリセット（Phase 1・cubic-bezier のみ）

単一 cubic-bezier で表現可能なもののみ。`linear` は特例（`{type:"linear"}`）、`hold` はメニュー側に残しパネルでは扱わない。

| id | bezier (x1,y1,x2,y2) |
|----|----------------------|
| linear | 特例 `{type:"linear"}` |
| sineIn / sineOut / sine | `0.12,0,0.39,0` / `0.61,1,0.88,1` / `0.37,0,0.63,1` |
| quadIn / quadOut / quad | `0.11,0,0.5,0` / `0.5,1,0.89,1` / `0.45,0,0.55,1` |
| cubicIn / cubicOut / cubic | `0.32,0,0.67,0` / `0.33,1,0.68,1` / `0.65,0,0.35,1` |
| quartIn / quartOut / quart | `0.5,0,0.75,0` / `0.25,1,0.5,1` / `0.76,0,0.24,1` |
| quintIn / quintOut / quint | `0.64,0,0.78,0` / `0.22,1,0.36,1` / `0.83,0,0.17,1` |
| expoIn / expoOut / expo | `0.7,0,0.84,0` / `0.16,1,0.3,1` / `0.87,0,0.13,1` |
| circIn / circOut / circ | `0.55,0,1,0.45` / `0,0.55,0.45,1` / `0.85,0,0.15,1` |
| backIn / backOut / back | `0.36,0,0.66,-0.56` / `0.34,1.56,0.64,1` / `0.68,-0.6,0.32,1.6` |
| easeIn / easeOut / ease | `0.42,0,1,1` / `0,0,0.58,1` / `0.25,0.1,0.25,1` |

> 値は CSS easing 標準（Penner 近似）に準拠。`back` 系は y∉[0,1] のオーバーシュートを使う（easing.ts は y をクランプしない）。`bounce`/`elastic` は単一 cubic-bezier で表現不可のため **Phase 2**（§24.0）に分離。

### §24.5 不変条件

INV-1〜6 を保持。Phase 1 は resolve・スキーマ・直列化に影響しない（既存 `easing` をそのまま使う）。KF の frame は整数を維持（INV-5）。ユーザープリセット保存は `presets/easing/<id>.json`（§10）への FS 書き込みのみで project.json には触れない。

---

## §25 Preview / コンポジションビューア 編集機能（Viewer Editing）— UI 層・MVP 後の UX 拡張

> AE のコンポジションビューアに相当する「**見るだけ**」の現状 Preview（[PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx)）を、**ビューア上で直接編集できる**ワークスペースへ引き上げる。**§5 スキーマ・§6 座標モデル・INV-1〜8 は不変**。本節は UI 層・エディタ store 操作・座標逆算の規約のみを定義する。直接操作の値書き戻しは既存 command 層（§17）を通る。

### §25.0 スコープ（確定）

| 機能 | 区分 |
|---|---|
| **§25.1 ビューア制御**（手動ズーム %・Ctrl+スクロールズーム・スペース/中ボタン パン・Fit / Fit≤100% / 100%） | 本リビジョン |
| **§25.2 ガイド・オーバーレイ**（セーフマージン・グリッド・中心十字・定規・透明チェッカーボード・解像度プロキシ表示倍率） | 本リビジョン |
| **§25.3 キャンバス直接操作**（選択ハイライト + バウンディングボックス + 8 ハンドル scale + 回転 + 移動 + アンカー点ドラッグ） | 本リビジョン |
| ガイド線（ドラッグ作成・スナップ）/ マスク・シェイプのオンキャンバス編集 / モーションパス表示・編集 / チャンネル表示・スナップショット / ROI | 将来（§16） |

### §25.1 ビューア制御（確定）

- **表示倍率 `viewZoom`（>0）** と **パンオフセット `viewPan: {x,y}`（comp px）** をビューア状態に持つ。現状の scale-to-fit は `Fit` モードの導出値として残す。
  - **Fit**: `viewZoom = min(aw/comp.width, ah/comp.height)`、`viewPan = {0,0}`（既定）。
  - **Fit up to 100%**: 上記を `min(…, 1)` で頭打ち。
  - **100% / 任意 %**: ユーザー指定の固定倍率。
- **ズーム操作**: Ctrl+ホイールで `viewZoom` を乗算（例 1.1^Δ）。**カーソル位置をアンカーに**ズーム（カーソル下の comp 点が固定されるよう `viewPan` を補正）。倍率ドロップダウン（10%〜400% + Fit）も提供。
- **パン操作**: スペース+ドラッグ または 中ボタンドラッグ（ハンドツール）。`viewPan` を加算。
- ステージ合成は `transform: translate(viewPan) scale(viewZoom)`（`transform-origin: 0 0`）に統一。**ラスタライズには影響しない**（ビューア表示のみ。INV-2 を維持）。

### §25.2 ガイド・オーバーレイ（確定）

すべてビューア表示専用のオーバーレイで、**`resolve()` の解決値・export・ラスタには一切影響しない**（INV-2/3 不変）。トグルで個別 ON/OFF:

- **透明チェッカーボード**: comp 背景が**未設定**のときの stage 背景（コンテンツの**背後**に描画）。トグル ON でチェッカー、OFF で黒。comp に背景色がある場合はそれを優先（チェッカーは出ない）。export は従来どおり comp 背景/アルファに従う（不透明 export は黒マット、alpha export は透明）。**`⬚` トグルはビューア設定**（localStorage 永続・§25.7）であり、`comp.background` の編集 UI ではない（背景色編集は Inspector の Composition セクション — §5.6）。
- **セーフマージン**: action-safe（外周 5%）/ title-safe（外周 10%）の枠。
- **グリッド / 中心十字 / 定規**: comp 座標基準。グリッド間隔は既定値（例 comp 幅の 1/10）固定で可。
- **解像度プロキシ**: Full/Half/Quarter（描画解像度を落として軽量プレビュー）。**scene 解決値は不変**で、DomRenderer のラスタ近似/プレビュー品質のみに作用させる（best-effort、INV-2 は scene 値の一致のみを要求）。

### §25.3 キャンバス直接操作（確定）

選択中レイヤー（§21 の選択状態を共有）に対し、ビューア上にコントロールを重ねて直接編集する。**すべてドラッグ中はライブプレビュー、mouseup で 1 command 確定（§17, undo 可）**。

- **バウンディングボックス**: 選択レイヤーのローカル境界（コンテンツの px サイズ）を world 変換でビューア座標へ投影して矩形＋8 ハンドル＋アンカー点（◎）を描く。
- **移動（body ドラッグ）** → `position`。
- **scale（角/辺ハンドル）** → `scale`。角は縦横、辺は片軸。Shift で縦横比固定。
- **回転（ハンドル外側 / 専用ハンドル）** → `rotation.z`。Shift で 45° スナップ。ピボットは `anchor`。
- **アンカー点ドラッグ（◎）** → `anchor` と `position` を**同時更新**して見た目を保つ（AE と同じく「アンカーを動かしてもレイヤーは動かない」）。
- 複数選択時は Phase 1 では**先頭 1 レイヤーのみ**ハンドル表示（一括変形は将来）。
- 直接操作は §25.1 の `viewZoom`/`viewPan` と独立に正しく動く（座標逆算は §25.4）。

### §25.4 座標逆算（確定・直接操作の核）

ビューアのマウス座標から Transform 値へ書き戻す経路を一意に定める。INV-1（resolve 純粋性）には触れない — 逆算は**エディタ層のみ**で行い、`resolve()` は変更しない。

```
screen px → (− stage 原点, ÷ viewZoom, − viewPan) → comp px
comp px → 親 world 行列の逆（invert(W_parent)）で local 空間へ
local 空間で position/anchor/scale/rotation の delta を解く
```

- `W_parent` は `resolve(comp, frame)` が各オブジェクトに焼いた world 行列から導出（親なし=identity）。逆行列は [mat4.ts](src/runtime/mat4.ts) の `invert` / `transformPoint` を使う。
- **2.5D 前提**（z=0 平面でドラッグ）。3D レイヤーの z 方向ドラッグは将来。
- **scale はゼロ割回避**（現 scale が 0 の軸は等倍として扱う）。**rotation は atan2 ベース**でピボット（anchor）周りの角度差を加算。
- 書き戻し値は §6.3 の合成順 `L = T(position)·R·S·T(-anchor)` と無矛盾であること（往復で見た目が保たれる）をテストで保証する。

### §25.5 animated プロパティへの書き戻し（確定）

直接操作の対象プロパティが **animated（KF あり）なら現 frame に KF を打つ/更新**、static なら `value` を更新する（§21.2 インライン編集と同一規約）。これにより AE の「自動キーフレーム」的挙動になる。frame は整数（INV-5）。すべて command 経由（§17）。

### §25.6 再生コントロール拡張（確定）

ツールバーに次を追加（決定論 frame ステップ・§11.2 を維持）:

- **1 フレーム前 / 後**（◀ / ▶|）、**末尾へ**（⏭ = `duration-1`）、**ループ ON/OFF**（再生終端で 0 に戻り継続）。
- タイムコード表示は §21.1 の SMPTE と併記可。**クリックで frame 直接入力**（派生表示であり内部は整数 frame、INV-5）。
- 既存の ▶/⏸・⏮ は維持。←→ / J/K は §21 P0 と共有。

### §25.7 ビューア設定の永続化（確定）

`viewZoom` / `viewPan` / 各オーバーレイ ON/OFF / 解像度プロキシ / ループ は **localStorage に永続化**し、**project.json には書かない**（§19.3 と同方針 — エディタの見え方であって作品データではない）。comp ごとに保持してよい（キーに compId を含める）。スキーマ・INV 不変。

### §25.8 不変条件

INV-1〜8 を保持する。

- §25.1/§25.2 はビューア表示専用で **scene 解決値・export・ラスタに影響しない**（INV-2）。`resolve()` は不変（INV-1）。
- §25.3〜§25.5 の編集はすべて既存スキーマの Transform プロパティへの書き込みのみ（§5 不変）で、command 経由（§17, undo 可）。KF frame は整数（INV-5）。
- 逆行列・座標変換はエディタ層のみ。runtime（INV-7 の核）には新 API を足さない（既存 `invert`/`transformPoint` を利用）。

---

## §26 テキストレイヤー（Text）— 文字機能の本実装

### §26.0 スコープ（確定）

現状の `text` component は DOM 上の 5 属性（`text`/`font`/`size`/`color`/`align`）を**描画できるだけ**で、編集 UI が全パネルに無く、builtin ComponentDef も未登録（→ Timeline で `kind` が scalar にフォールバックし color/string 編集が壊れている）。本節はこれを「ユーザが作品として触れる」水準まで引き上げる。**AE 100% 一致は非目標**。下表の範囲のみを正式サポートとする。

| 機能 | 採否 | 根拠（このリビジョンの確定） |
|---|---|---|
| 基本 5 属性（内容/フォント/サイズ/色/整列） | ✅ | 最低限 |
| 字間 `tracking` / 行間 `leading` | ✅ | アニメ効果大・CSS で安価 |
| ウェイト `weight` / イタリック `italic` | ✅ | フォント対応前提で安価 |
| ストローク `strokeColor` / `strokeWidth` | ✅ | AE 頻用。厳密モード（§26.4）で正確 |
| 編集 UX | **Inspector フォーム**（AE Character パネル相当） | §26.3 |
| テキストアニメーション | **グリフ分解（GG 分解）**（§26.5） | 専用エンジン不要・既存 Transform/KF を最大活用 |
| プレビュー品質 | **グローバル 1 ボタンで 軽量⇄厳密 切替**（§26.4） | Draft/Best 相当 |
| 厳密描画 | **SVG アウトライン**まで今回実装（キャッシュ基盤は将来・IF だけ確保） | §26.4 |
| 段落（ボックス）テキスト + ワードラップ（`boxWidth`）| ✅ | 固定幅で折返し。justify の前提。`boxWidth=0` で従来 point text |
| 整列 `justify`（両端揃え）| ✅ | `boxWidth>0` 時に語間を均等配分。`boxWidth=0` では left |
| 文字単位の混在スタイル / パステキスト / 範囲セレクター式アニメーター | ❌ 将来（§16） | グリフ分解で代替できるため MVP 外 |

### §26.1 データモデル（スキーマ確定）

`text` component の props を以下に確定する。`animatable: true` のものは `AnimatedProp<T>`、`false` のものは素の値で `props` に格納する（`Component.props` は `AnimatedProp<unknown> | unknown` の両対応・§5.5 不変）。

```ts
// text component props（builtin ComponentDef として登録する。§26.2）
interface TextProps {
  text:        AnimatedProp<string>;  // Source Text。補間は hold のみ（文字列は連続補間しない・§26.6）
  size:        AnimatedProp<number>;  // px, > 0
  color:       AnimatedProp<RGBA>;    // 塗り
  tracking:    AnimatedProp<number>;  // 字間 px（CSS letter-spacing）。0 = 詰めなし
  leading:     AnimatedProp<number>;  // 行間 px（CSS line-height）。0 = normal（size×1.2 相当）
  strokeColor: AnimatedProp<RGBA>;    // 縁取り色
  strokeWidth: AnimatedProp<number>;  // px, 0 = ストロークなし
  boxWidth:    AnimatedProp<number>;  // px。0 = point text（折返しなし・既存挙動）, >0 = 固定幅ボックスで折返し
  boxHeight:   AnimatedProp<number>;  // px。boxWidth>0 のときのみ意味を持つ。0 = 内容から自動算出, >0 = 固定高さでクリップ

  font:   string;                     // family 名（assets フォント §11.6 or system）。animatable: false
  align:  "left" | "center" | "right" | "justify"; // animatable: false。justify は boxWidth>0 のみ有効（0 では left 扱い）
  weight: number;                     // 100..900（CSS font-weight）。animatable: false
  italic: boolean;                    // animatable: false
}
```

- 既定値（`addText` が積む初期 props）: `text="Text"`, `size=48`, `color=白`, `tracking=0`, `leading=0`, `strokeColor=黒`, `strokeWidth=0`, `boxWidth=0`, `boxHeight=0`, `font="sans-serif"`, `align="left"`, `weight=400`, `italic=false`。
- 単位の確定: `tracking`・`leading` は **px**（AE の 1/1000 em 方式は将来）。`leading=0` は CSS `line-height: normal`。
- **`boxWidth` セマンティクス**: `0` = point text（明示改行のみで折返さない＝従来挙動）。`>0` = 段落（ボックス）テキストで、行幅が `boxWidth` を超えると空白境界でワードラップ（収まらない単一トークンは文字境界で分割）。レイアウトは決定論（INV-1）で、注入された `measureChar`/`font` のみで幅を測る。`boxWidth` 欠落の旧プロジェクトは `0` とみなす（完全後方互換）。
- **`boxHeight` セマンティクス**: `boxWidth>0` のときのみ有効。`0` = ボックス高さは内容（折返し行数）から自動算出。`>0` = 固定高さで、はみ出したテキストは下端でクリップ（CSS `overflow: hidden`）。ボックスの bounds（ギズモ枠）は `[0,boxWidth] × [0, boxHeight>0 ? boxHeight : 内容高さ]`。`boxHeight` 欠落の旧プロジェクトは `0`。
- **ボックスのビューポート編集（§26.3.3）**: `boxWidth>0` のテキスト選択時、ギズモは scale ではなく**ボックスリサイズ**として働き、8 ハンドルが `boxWidth`/`boxHeight` を編集する（反対辺を comp 空間で固定し、左/上辺ドラッグ時は position を補正）。`boxWidth=0`（point text）や text 以外は従来通り scale。Inspector の Box Width/Height 近くの **「Box Edit」トグル**（store `boxGizmoEnabled`・既定 ON・非直列化）で、ボックスリサイズ ⇄ 通常 scale を明示的に切替えられる。破線枠＝ボックスリサイズモード。
- **`justify`**: `boxWidth>0` のとき各行（最終行・明示改行の直前行を除く）の語間スペース幅を `boxWidth` まで均等配分する。`boxWidth=0` では `left` にフォールバックする。
- ストローク描画順: 塗りの**外側**にストローク（CSS `paint-order: stroke fill` / SVG も同順）。`strokeWidth` は中心揃えではなく外側基準とする（厳密モード基準・§26.4）。

### §26.2 builtin ComponentDef 登録（バグ修正含む・確定）

`text`（および将来は `solid`/`shape` 等の builtin）を **`ParamDescriptor[]` 付きで `globalPluginRegistry.registerComponent` に登録**する。これにより Timeline の KF 行（[TimelinePanel.tsx:1381](../src/editor/panels/TimelinePanel.tsx#L1381)）が正しい `kind`/`label` を引け、現状の **scalar フォールバック不具合が解消**する。登録は plugin ロードと独立に、エディタ初期化時（store 初期化）に行う。

```ts
registerComponent({
  type: "text", label: "Text",
  params: [
    { key: "text",        label: "Source Text", kind: "string", default: "Text", animatable: true },
    { key: "font",        label: "Font",        kind: "string", default: "sans-serif", animatable: false },
    { key: "size",        label: "Size",        kind: "scalar", default: 48, animatable: true, min: 1 },
    { key: "color",       label: "Fill",        kind: "color",  default: { r:1,g:1,b:1,a:1 }, animatable: true },
    { key: "align",       label: "Align",       kind: "enum",   default: "left", animatable: false, options: ["left","center","right","justify"] },
    { key: "tracking",    label: "Tracking",    kind: "scalar", default: 0, animatable: true },
    { key: "leading",     label: "Leading",     kind: "scalar", default: 0, animatable: true, min: 0 },
    { key: "boxWidth",    label: "Box Width",   kind: "scalar", default: 0, animatable: true, min: 0 },
    { key: "boxHeight",   label: "Box Height",  kind: "scalar", default: 0, animatable: true, min: 0 },
    { key: "weight",      label: "Weight",      kind: "enum",   default: 400, animatable: false, options: ["100","200","300","400","500","600","700","800","900"] },
    { key: "italic",      label: "Italic",      kind: "bool",   default: false, animatable: false },
    { key: "strokeColor", label: "Stroke",      kind: "color",  default: { r:0,g:0,b:0,a:1 }, animatable: true },
    { key: "strokeWidth", label: "Stroke Width",kind: "scalar", default: 0, animatable: true, min: 0 },
  ],
});
```

> 既存 `ParamKind`（§5.5）に `string` / `enum` / `color` / `bool` は既に在る。Timeline / Inspector の汎用 PropRow がこれら kind を編集 UI として描けるよう拡張する（color は §26.3 のスウォッチ、enum はセレクト、bool はトグル、string はテキスト入力）。

### §26.3 編集 UX — Inspector フォーム（確定）

選択オブジェクトが `text` component を持つとき、Inspector（[InspectorPanel.tsx](../src/editor/panels/InspectorPanel.tsx)）に **"Text" セクション**を表示する（AE Character パネル相当）。フィールド:

| フィールド | UI | KF |
|---|---|---|
| Source Text | 複数行 textarea | ◇（hold） |
| Font | **ドロップダウン（一般 web フォント）＋「Custom…」で任意 family 入力**（§26.3.1）。将来: assets フォントのセレクト, §11.6 | — |
| Size | ScrubNumber | ◇ |
| Fill / Stroke 色 | **カラースウォッチ + ピッカー**（新規 UI） | ◇ |
| Align | 3 ボタン（L/C/R） | — |
| Tracking / Leading | ScrubNumber | ◇ |
| Stroke Width | ScrubNumber | ◇ |
| Weight | セレクト（100–900） | — |
| Italic | トグル | — |

- 各 animatable フィールドは既存 PropRow と同じ **ストップウォッチ（◇）で keyframe 化**でき、書き込みは command 経由（undo 可・§17）。値・KF 書き込みは既存 `updateObject` / `setKeyframe` 経路を流用し、`components[i].props[key]` を更新する（[store.ts](../src/editor/store.ts) のパターン）。
- **カラーピッカーは新規コンポーネント**（現状エディタに無い）。最小実装は `<input type="color">` + alpha スライダで可。
- **編集中フォールバック（§26.4 連動）**: Source Text の textarea / 数値・色フィールドに**フォーカスがある間はプレビューを軽量モードに自動降格**し、blur で元の品質へ戻す（タイプごとの SVG 再生成を避ける）。

#### §26.3.1 Font ドロップダウン（確定）

`font` は引き続き **`kind: "string"` の静的プロパティ**（§26.1・スキーマ不変）。UI のみ自由入力テキストボックスから**プルダウン＋カスタム入力**へ置換する。

- **候補リスト（`WEB_SAFE_FONTS`）**: 一般的なブラウザで追加インストール無しに開ける family。CSS 総称（`sans-serif` / `serif` / `monospace` / `cursive` / `system-ui`）＋クロスプラットフォームで概ね利用可能な定番（`Arial`, `Helvetica`, `Times New Roman`, `Georgia`, `Courier New`, `Verdana`, `Trebuchet MS`, `Tahoma`, `Impact`, `Comic Sans MS`）。各 option の表示テキスト自体をそのフォントで描く（`style.fontFamily`）ことで見本になる。
- **アップロード（確定・2026-07 更新）**: プルダウンには Bundled / Web safe に加えて **Uploaded**（`project.assets` の `kind:"font"`）optgroup を出す。任意フォントの追加はテキスト入力ではなく **「⬆ Upload font…」ボタン**（隠し `<input type="file">`）で行う。アップロードは `importFontAsset(file)`（[store.ts](../src/editor/store.ts)）が opentype.js でパースして family 名を取得し、`assets/font/<id>.<ext>` へ書き込み（フォントは `assets/font/` 配下。旧プロジェクトの `assets/<id>.<ext>` は `asset.path` をそのまま読むので互換） `AssetEntry{kind:"font", meta:{family}}` を追加、[assetFontFaces.ts](../src/runtime/assetFontFaces.ts) の `registerAssetFonts` が `@font-face` を注入して即座に 2D 描画へ反映する。現状値が候補に無ければ select に読み取り専用の追加 option として表示する（既存プロジェクトの非標準 family を壊さない）。
- 書き込みは他の静的プロパティと同様 `writeStatic("font", value)` 経由（`components[i].props.font` を更新、undo 可）。`addText` の既定（`font="sans-serif"`）も候補リストに含まれる。
- リストは `src/editor/fontList.ts` 等の単一定数として持ち、Inspector が参照する。**描画経路（DomRenderer / SVG）には影響しない**（family 文字列をそのまま `font-family` に渡す既存挙動を維持）。

#### §26.3.2 ビルトイン同梱フォント（Noto Sans / Noto Sans JP）— 確定

システム依存の Web セーフフォント（§26.3.1）は環境ごとに有無・字形が変わり、**preview と export の一致（INV-2）を保証できない**。これを解消するため、アプリに**実フォントファイルを同梱**して環境非依存で使える family を提供する。

- **同梱対象**: `Noto Sans`（ラテン, 3 ウェイト）/ `Noto Sans JP`（日本語グリフ, 3 ウェイト）に加え、3D Extrude の選択肢を増やす目的で OSS フォントを追加（2026-07）: `Roboto` / `Tinos`(Times 互換) / `Cousine`(Courier 互換) / `Anton`(Impact 風) / `Dancing Script`(Cursive 風)（各 1〜2 ウェイト）。実体は `public/fonts/*.ttf`（完全版 TTF、サブセットしない、ライセンス OFL/Apache）。
- **登録の単一情報源**: `src/runtime/builtinFonts.ts` に `BUILTIN_FONTS`（family・label・weights→ファイル名）を定義。`registerBuiltinFonts(baseUrl)` が family×weight 分の `@font-face`（`src: url(<baseUrl>/<file>) format('truetype')`、`font-display: swap`）を 1 つの `<style>` として `document.head` に注入する（冪等）。ブラウザはグリフ使用時のみ遅延ロードするため、起動コストは増えない。
- **適用範囲（INV-2 を満たすための配線）**:
  - **エディタ + ブラウザ export**: `main.tsx` 起動時に `registerBuiltinFonts("/fonts")` を 1 回呼ぶ。WebCodecs / PNG 連番 export は**同一 document 内**で走るため、これだけで preview と export が同じ実フォントを使う。
  - **Web Bundle（§11.7）**: bundle は file:// 自己完結のため、使用された built-in family×weight の TTF を zip に同梱し、`BundleManifest.builtinFonts: { family, weight, path }[]` に列挙する。`BundlePlayer` が `FontFace(family, url(path), { weight })` で登録する。未使用ウェイトは同梱しない（サイズ最適化）。
- **ウェイトの扱い**: `font` は family 文字列のみを持つ既存仕様を維持し（スキーマ不変・§26.1）、太さは既存の静的プロパティ `weight`（§26.1）で選ぶ。`@font-face` を 400/500/700 で宣言してあるため、`weight` 値に応じて CSS が対応するフェイスを選択する（draft の DOM / precise の SVG `<text>` 双方で `font-weight` として反映）。
- **outline（§26.4.1）との関係**: built-in フォントは `@font-face` で document に実ロードされるため、precise モードの **SVG `<text>` フォールバックでも正確に描画**でき、export と一致する。opentype による per-glyph アウトライン化は将来の最適化（必須ではない）。
- Inspector のドロップダウンでは Web セーフ群と分けて先頭の optgroup（"Bundled"）に出す。`isKnownFont` は built-in family も既知として扱い、Custom 入力に誤って落とさない。

### §26.4 プレビュー品質モード（軽量 / 厳密）— 確定

プレビューに**グローバル 1 ボタン**（AE の Draft/Best 相当）を置き、レンダリング品質を切り替える。粒度はグローバルのみ（レイヤー個別フラグは将来）。

| モード | 描画 | 用途 |
|---|---|---|
| **軽量（draft）** | 現状の **DOM テキスト**描画（[DomRenderer.ts:302](../src/runtime/DomRenderer.ts#L302)）。CSS の `letter-spacing`/`line-height`/`font-weight`/`font-style`/`-webkit-text-stroke`(or `paint-order`) を全属性に反映 | 高速・編集追従用の近似プレビュー |
| **厳密（precise）** | **SVG アウトライン**描画（§26.4.1）。塗り・ストロークを path で正確に。**最終 export と一致する基準**（§26.7） | 仕上がり確認・書き出し基準 |

- ボタン状態は**ビューア設定**として永続化（§25.7 と同じ機構）。**project.json は汚さない**（INV-3/§19.3）。
- store に `previewQuality: "draft" | "precise"` を持つ。`§26.3` の編集中フォールバックはこの値を一時上書きする（永続値は変えない）。

#### §26.4.1 SVG アウトライン描画（今回スコープの上限）

- 文字を**グリフのアウトライン path** に変換して `<svg><path fill stroke paint-order="stroke">` で描く。フォント実体に依存せず per-glyph 変形・正確なストロークが可能になり、**Web Bundle export（§11.7）でのフォント埋め込みが不要**になる（§26.7 と synergy）。
- アウトライン抽出は**フォントバイナリのパースが必要**。実現方針:
  - **assets として取り込んだフォント**（§11.6, `.ttf/.otf/.woff`）: フォントパーサ（推奨 `opentype.js`、差し替え可）でグリフ path を取得 → 正確なアウトライン。**これが厳密モードの正路**。
  - **system フォント**（アセット実体なし）: ブラウザは外形 path を公開しないため正確なアウトライン化は不可。**SVG `<text>`（ベクタだが font 依存）にフォールバック**し、ストロークは `paint-order` で近似する。→ 「厳密モードを正確に使うにはフォントを asset として取り込む」を UX 上の前提とする（Inspector / export ダイアログに注記）。
- 文字レイアウト（advance/改行/align/tracking/leading）の算出は**決定論**であること（INV-1）。パーサのメトリクスのみを用い、`Math.random`/`Date.now`/DOM measureText を resolve 経路に持ち込まない。アウトライン生成はレンダラ層（`ResolvedScene` 受領後）で行い、`resolve()` 自体は不変。
- **§5.5f（3D 押し出し）も同じ制約を継承する（2026-07 更新）**: 3D Extrude はアウトライン抽出可能なフォント（**Bundled 同梱 + assets として取り込んだフォント**）でのみ有効。
  - **Bundled フォント**（[builtinFonts.ts](../src/runtime/builtinFonts.ts) の `BUILTIN_FONTS`）は `geomEnabled` を ON にした瞬間（または 3D ON 中に Bundled family へ変更した瞬間）、`ensureBundledFontAsset`（[store.ts](../src/editor/store.ts)）が `public/fonts/*.ttf` を fetch して自動的に `project.assets`（`kind:"font"`）へ取り込む（FS 書き込み先は `assets/font/<id>.ttf`）。ユーザー操作は不要。
    - **Project パネル上の置き場**: 自動埋め込みフォントはユーザーが意識して作った素材ではないため、ルート直下に並べず **ルート直下の `fonts` フォルダ（bin）** へ入れる（§11.2b `pre-rendered` と対称。[fontBin.ts](../src/editor/fontBin.ts) の `addFontAssetToProject`）。アップロード（`importFontAsset`）も同じフォルダへ入る。フォルダは最初のフォント取り込み時に自動作成し、以後は再利用する。ユーザーが手動で別フォルダへ移したフォントは移送対象にしない（`binId` を持つため）。
  - **web-safe / システムフォント**（`WEB_SAFE_FONTS`, [fontList.ts](../src/editor/fontList.ts)）は実ファイルをブラウザから取得できず原理的に 3D 化不可。ドロップダウンの label に `(no-3D)` を明示し、`geomEnabled=true` かつ非対応フォント時は Inspector に警告文を表示した上で 2D 描画へフォールバックする（サイレントフォールバックにしない）。`is3DCapableFont(font, project)`（[fontList.ts](../src/editor/fontList.ts)）が判定を持つ。
  - **アップロード済みフォント**は他の asset フォントと同様アウトライン抽出可能なため 3D 化できる。
  - **weight は family と対等な識別子（2026-07 追記）**: アウトラインは family だけでなく **weight ごとに別ファイル**（`NotoSans-Regular.ttf` / `NotoSans-Bold.ttf` 等）である。したがって次を守る。
    - font asset は `meta: { family, weight }` を持ち、**重複判定・埋め込みは family×weight 単位**で行う（family だけで判定すると最初に埋め込んだ weight が居座り、以降の weight 変更が 3D に反映されない）。`meta.weight` を持たない旧 project の asset は `400` として扱う。
    - `FontOutlineCache`（[fontOutlineCache.ts](../src/runtime/fontOutlineCache.ts)）は **family×weight** で引く。完全一致が無い場合のみ同 family の最近傍 weight にフォールバックする。
    - `ensureBundledFontAsset` は `geomEnabled` ON 中の **weight 変更時にも**呼ぶ（該当 weight の実ファイルを取り込むため）。
    - 同 family の複数 weight を同梱しうるため、asset の `@font-face` には **`font-weight` 記述子が必須**（省略すると全 face が normal を名乗り 2D 側が誤った face を選ぶ）。
    - **メッシュキャッシュのキーは「要求 weight」ではなく「実際に使われた font インスタンスの同一性」**とする（[geom3dDomApply.ts](../src/runtime/geom3d/geom3dDomApply.ts)）。asset フォントは非同期ロードのため、要求 weight が未ロードの間は近傍 face で描画されうる。要求 weight をキーにするとその暫定メッシュが本来の weight のキーで焼き付き、後からフォントが届いても永久にキャッシュヒットする。

#### §26.4.2 レンダーキャッシュ（将来・IF のみ今回確保）

将来「重いポストエフェクトのフレーム描画をキャッシュして厳密プレビューを軽くする」ための**インターフェースだけ**今回切る（実体は no-op）。

```ts
// 将来拡張用。MVP は get() が常に miss を返す no-op 実装。
interface FrameRenderCache {
  get(key: { objectId: ObjectId; frame: Frame; propsHash: string }): CachedFrame | null;
  put(key: { objectId: ObjectId; frame: Frame; propsHash: string }, value: CachedFrame): void;
  invalidate(objectId: ObjectId): void;
}
```

- キャッシュキーは決定論的（INV-1/2）に算出可能なものに限る（frame は整数・INV-5、props は正準ハッシュ）。**キャッシュは描画の高速化のみで scene 解決値・出力ピクセルの正には影響しない**。
- **実装（§28.10）**: `key.frame` は **layer-local frame**（`compFrame − inPoint`）を用いる。スライド不変・comp 全体キャッシュとは別同一性モデルである点は §28.10 を正とする。

### §26.5 グリフ分解（GG 分解）— テキストアニメーションの代替（確定）

AE のテキストアニメーター＋範囲セレクターは実装せず、**「1 文字 = 1 SceneObject」に分解する破壊的コマンド**で代替する。各グリフは独立した `text` レイヤーになり、**既存の Transform + キーフレーム機構だけ**で個別アニメーション（文字送り・タイポアニメ等）が作れる。

#### §26.5.1 コマンド仕様（共通）

「Decompose Glyphs（グリフ分解）」は **2 方式**を Inspector から選択できる（undo 可）。いずれも:

1. **現在フレームの Source Text とスタイル**（font/size/tracking/leading/weight/italic）から**文字レイアウトを測定**する。測定は**エディタ層**で Canvas 2D `measureText`（または §26.4 のフォントパーサ）を用いる。→ **`resolve()` の純粋性（INV-1）を保つため、測定は編集時に一度だけ行い、結果の座標を静的 Transform に焼き込む**（resolve 経路では測定しない）。
2. 改行・align・tracking・leading を考慮し、各グリフの**ブロック内原点 (x, y)** を算出。
3. グリフ 1 つにつき `SceneObject` を 1 つ生成:
   - `text` component に**その 1 文字**を格納。font/size/color/stroke/weight/italic を元レイヤーからコピー。
   - `zOrder` は元レイヤー近傍に連番付与（fractional・§5.4）。新 ID は ULID（INV-6）。
   - 空白文字は**レイヤーを作らず advance（送り幅）だけ**反映。
4. 分解前の SceneObject を **`{name} (source)`** として複製保存（`enabled: false`）。二重描画回避・参照用。
5. 全変更を **1 command（1 undo）**で確定する（§17, §21.5 の複数オブジェクト patch と同様）。

#### §26.5.1a Decompose with keyframes on null（既定・現行）

1. グリフの `transform.position` に焼き込んだ原点、`anchor` をグリフ基準点 `(0,0,0)` に設定（静的）。
2. グリフの `parent` = **元レイヤー ID**（下記 3 でコンテナ化）。→ ブロック全体の Transform/アニメをグリフが継承（§5.4 parent 継承）。
3. **元レイヤー**は Source Text を空にして**トランスフォーム専用のコンテナ**（= 実質 null/group）として残す。ブロック単位の移動・回転・スケールが 1 箇所で効き、各文字は個別 KF で動かせる。

#### §26.5.1b Decompose with keyframes on child

1. **コンテナ（元レイヤー）は生成しない**（元 ID のオブジェクトは削除）。
2. グリフの `parent` = **分解前の `obj.parent`**（上位階層は維持）。
3. 各グリフの Transform を **`inPoint`〜`outPoint-1` の全整数フレーム**でサンプルし KF 化:
   - `L_baked(f) = L_original(f) · T(gx, gy, 0)`（§6.3 の行列合成）
   - `L_original(f)` は KF + expression を編集時サンプル（焼き込み後は expression 除去）
   - `L_baked` を `anchor=0` の `{ position, rotation, scale }` に分解し、フレーム間 easing は **linear**
4. `opacity` / text component のアニメ可能 props / `effects` は各グリフへコピー（effect `id` は新 ULID）。

**トレードオフ**: project.json が `glyphs × frames × channels` 分肥大化。密サンプル + 行列分解により null 方式と world 一致を目指すが、euler 分解の数値誤差がありうる。

#### §26.5.1c 方式比較

| 項目 | keyframes on null | keyframes on child |
|------|-------------------|-------------------|
| コンテナ | 元 ID・text 空・残す | なし |
| グリフ parent | コンテナ（元 ID） | 元の parent |
| Transform | 静的 offset のみ | 全整数フレーム KF 焼き込み |
| ブロック一括アニメ | コンテナの KF で | 各グリフに同型 KF が既に付く |
| `(source)` | 両方式共通 | 両方式共通 |

#### §26.5.2 性質・トレードオフ（明記）

- **破壊的・一方向**: AE の非破壊アニメーターと異なり、分解後は「文字列の編集」が各グリフ個別になる。元に戻すのは undo のみ（再結合コマンドは将来）。
- 分解時点のスタイルで焼き込むため、**分解後のフォント/サイズ変更は再レイアウトされない**（各グリフを個別調整）。これを許容コストとして受け入れる。
- INV-1/5/6 を保持（測定は編集時のみ・frame 整数・新規 ULID）。

### §26.6 補間規則（確定）

- `text`（Source Text, string）の KF 補間は **hold のみ**（連続補間しない）。frame ≥ 直近 KF の値を表示。これにより差し替え式テキストアニメが書ける。
- `color`/`strokeColor`（RGBA）は各成分を §6.4 の補間規則で連続補間。
- `size`/`tracking`/`leading`/`strokeWidth`（number）は通常の数値補間。
- `font`/`align`/`weight`/`italic` は非アニメーション（静的値）。

### §26.7 Export との関係（INV-2 の扱い・確定）

- **厳密モード（SVG アウトライン）が最終出力の基準**。`§26.4` の厳密プレビューと export のテキスト描画は一致する。
- **HTML / 映像書き出し時にテキスト描画方式を選択可能**にする（export ダイアログ）:
  - **厳密（SVG アウトライン）のみ** — フォント非依存・埋め込み不要・per-glyph 正確（既定）。
  - **可能な限り軽量（DOM テキスト）** — 出力サイズ/速度優先。フォント実体が要る場合は §11.6 の埋め込みを併用。
- **INV-2 の解釈**: 不変条件が要求する「同一 frame の preview / browser export / headless export の一致」は **`resolve()` の scene 解決値の一致**を指す。軽量・厳密は同一 `ResolvedScene` の**ラスタライズ方式の違い**であり、`resolve()` は不変（INV-1）。ピクセル一致の基準は**厳密モード**とし、軽量モードは高速近似プレビュー（サブピクセル差を許容）と位置づける。

### §26.8 影響ファイル（実装の入口・参考）

- スキーマ/登録: [src/core/schema.ts](../src/core/schema.ts)（ParamKind は既存で足りる）, builtin ComponentDef 登録（store 初期化, [src/editor/store.ts](../src/editor/store.ts)）。
- 描画: [src/runtime/DomRenderer.ts](../src/runtime/DomRenderer.ts)（軽量: 全属性反映）, 新規 SVG アウトラインレンダラ（厳密）, [src/editor/previewViewer.ts](../src/editor/previewViewer.ts)（サンプリング）。
- UI: [src/editor/panels/InspectorPanel.tsx](../src/editor/panels/InspectorPanel.tsx)（Text セクション + カラースウォッチ）, [src/editor/panels/TimelinePanel.tsx](../src/editor/panels/TimelinePanel.tsx)（kind 別 PropRow 拡張）, [src/editor/panels/PreviewPanel.tsx](../src/editor/panels/PreviewPanel.tsx)（品質トグルボタン）, [src/editor/ExportDialog.tsx](../src/editor/ExportDialog.tsx)（テキスト描画方式）。
- コマンド: [src/editor/commands.ts](../src/editor/commands.ts)（Decompose Glyphs）。
- 既定値: [src/editor/store.ts](../src/editor/store.ts) `addText`。

### §26.9 不変条件

INV-1〜8 を保持する。

- `resolve()` は不変。グリフ分解の測定・SVG アウトライン化はすべて **編集時 or レンダラ層**で行い、resolve 経路に DOM/measure/乱数を持ち込まない（INV-1）。
- 軽量/厳密は同一 `ResolvedScene` のラスタライズ違い。scene 解決値は一致（INV-2）。基準は厳密モード（§26.7）。
- 品質トグルはビューア設定で project.json を汚さない（INV-3, §19.3）。
- 焼き込み座標・新規オブジェクトは整数 frame / ULID（INV-5/6）。
- レンダーキャッシュ（§26.4.2）は将来 IF のみ。導入時もキャッシュは高速化専用で出力の正に影響しない。

---

## §27 エフェクト & 調整レイヤー（Effects / Adjustment Layer）

> **状態**: 仕様確定（本リビジョン v0.11）。実装は **エフェクト基盤 + builtin 7 種 + 調整レイヤー最小実装**。役割分担に従い**設計=Claude Code / 実装=Cursor**（§27.10 に作業分解）。
> **スキーマ**: §5.5b（additive・既存 project.json byte 等価）。**AE 100% 一致は非目標**。下記の範囲のみ正式サポート。
> Timeline Tier D（§21.0 / L825）の「調整レイヤー（将来）」マーカーは、**基盤については本節が supersede** する（モーションブラー/フレームブレンド/3D レイヤーは引き続き将来）。

### §27.0 モデル：エフェクト ≠ コンポーネント（確定）

- **`components[]`** はレイヤーの**描画内容**（solid/text/image/html…）を与える（§5.5）。
- **`effects[]`** はそのレイヤーの**描画結果に対する後処理**（AE のエフェクト相当）。任意のオブジェクトに 0..n 個追加でき、`effects[]` の**配列順**に適用する（先頭→末尾。AE のエフェクトリスト上→下と一致）。
- エフェクトは独立画面を持たず、**Inspector で管理**する（§27.6・現行 Unity 風 foldout に統合）。各エフェクトの animatable param は **キーフレーム可能**（§27.5・既存の component prop KF 機構を再利用）。
- 将来の buffer→buffer WASM エフェクト（§14）と I/O 契約を揃える（§27.2 の `EffectDef`）。

### §27.1 適用パイプライン（DOM レンダラ・確定）

DomRenderer は各 `ResolvedObject` を root の兄弟 div（host div）として描画する（§8）。エフェクトはその **host div への CSS `filter` 連結**で適用する。

```
content components → host div の子要素として描画（既存）
effects[]          → host div.style.filter = (順序付きフィルタトークン列)
```

- 各 effect は `EffectDef.apply(resolvedProps, ctx)` で **フィルタ片**を返す（§27.2）。`enabled === false` のエフェクトは無視。
- フィルタ片は 3 種:
  - `{ kind: "css", fn }` … CSS `<filter-function>` トークン（例 `"blur(4px)"`）。
  - `{ kind: "svg", primitives }` … SVG filter primitive 群。DomRenderer が `<svg><filter id="fx-{objId}-{i}">…</filter></svg>` を host に紐づけ、`url(#fx-{objId}-{i})` トークンを生成。
  - `{ kind: "raster" }` … buffer→buffer エフェクト（§27.3 `pixelSorter` 等）。DomRenderer がレイヤーを raster 化し `EffectDef.processPixels` を呼ぶ（§27.1 raster パイプライン）。
- DomRenderer は effect 配列順にトークンを連結して **1 本の `filter` 文字列**にする（CSS `filter` は関数と `url()` を**混在・左→右順適用**できる）。例: `filter: blur(2px) url(#fx-abc-1)`。raster effect は filter トークンではなく **canvas overlay** 経路（下記）。
- **raster パイプライン（additive・Phase 1）**: `effects[]` を配列順に走査する。
  1. レイヤー content を DOM に描画（既存）。
  2. **css/svg**: トークンを蓄積し host div の `filter` / `backdrop-filter` に適用（raster 到達前の分はキャプチャに焼き込まれる）。
  3. **raster**: その時点の見た目を [`rasterCapture`](../src/runtime/rasterCapture.ts)（foreignObject 経路・exporter と共有）で `ImageData` 化 → `processPixels`（純関数）→ 結果を host div 内 **overlay `<canvas>`** に描画。元 component 子要素は `visibility:hidden`（レイアウト寸法は維持）。以降の css/svg は host div の filter で canvas にも作用する。
  4. 複数 raster effect は配列順に buffer 連鎖。
  5. **調整レイヤー + raster**: Phase 1 **非対象**（恒等フォールバック・preview 注記）。
  6. **INV-2**: export は各 frame で `await renderer.flushRasterEffects()` 後に root capture（[`exporter.ts`](../src/runtime/exporter.ts)）。
  7. リアルタイム再生時、async capture により最大 1 フレーム遅延しうる（許容済み既知差）。
- **reconcile**: host div の filter 文字列と svg `<filter>` defs は、effect の型/順序/有効状態が変わったときだけ作り直す（既存 `childSig` と同様の `fxSig`）。毎フレームは解決済み値で filter 文字列を更新するのみ。
- **filter region**: 各 `<filter>` には `x/y=-25% width/height=150%` を付与し、displacement / feather がレイヤー端でクリップされないようにする。`feImage` は `(0,0,w,h)` に固定（`x/y/width/height` 明示）するので region を広げても map/mask 画像は歪まない。
- **displacement filter region（§27.3 wave / turbulentDisplace / ripple）**: `feDisplacementMap` を含む filter は **`filterUnits="userSpaceOnUse"` + `primitiveUnits="userSpaceOnUse"`** とし、`x/y=-pad`, `width/height=layer+2·pad`（`pad = ceil(maxScale·0.5)+2`）でレイヤー `(0,0,w,h)` と noise/map の座標系を一致させる（Amount 比例スライド回避）。`feTurbulence` は `x/y=0 width/height=w/h` + `stitchTiles="stitch"`。host div は displacement 有効時に **コンテンツ実寸 `width/height`** を設定する。

> **なぜ CSS filter か**: HTML comp が主役の DOM レンダラ（§8）と最も整合し、preview と foreignObject export（§11.4・テキスト export が既に使用）で**同一経路でラスタライズ**される＝ INV-2 を素直に満たす。`url(#)` SVG filter も foreignObject に内包できる。

### §27.2 EffectDef（§12 `registerEffect` の具体化・確定）

§12 で予約済みの `registerEffect(def: EffectDef)` を以下で確定する。**component の `ParamDescriptor[]` 契約を共有**する（Inspector / Timeline / KF / 補間 / expression を再利用するため）。

```ts
type EffectFilter =
  | { kind: "css"; fn: string }          // 例: "blur(4px)"
  | { kind: "svg"; primitives: string } // <filter> の中身（feColorMatrix 等）。SourceGraphic を入力に取る
  | { kind: "raster" };                  // DomRenderer が buffer→buffer を実行

interface RasterBuffer {
  data: Uint8ClampedArray; // RGBA row-major
  width: number;
  height: number;
}

interface EffectRenderCtx {
  width: number;    // レイヤー実寸（tint blend / raster 単位換算用）
  height: number;
  frame: number;    // raster の決定論 seed 用（INV-1）
}

interface EffectDef {
  type: string;                       // "blur" | "tint" | "pixelSorter" | "pixelSortLite" | plugin
  label: string;
  category?: string;                  // Inspector ピッカー見出し
  /** §28 RAM Preview: comp 内に enabled な1つでもあれば強制 non-realtime。registry メタのみ（project.json 非保存）。必須明示。 */
  previewBakeRequired: boolean;
  /** §27.4 実行経路。"live" = DOM filter/backdrop-filter を同期適用（軽量）/ "raster" = canvas でピクセル処理（高精度・確実）。
   *  kind（css/svg/raster）とは独立: full displacement（wave/ripple/turbulentDisplace）は kind:"svg" でも executionPath:"raster"。
   *  registry メタのみ（project.json 非保存）。必須明示。 */
  executionPath: "live" | "raster";
  params: ParamDescriptor[];          // §5.5 と同契約（animatable param は AnimatedProp で props に入る）
  bundleExportDefault?: "live" | "bake"; // 既定: builtin=live / plugin=bake（§12 安全側）
  // 純関数。resolve 済み props（具体値）→ フィルタ片。null = 何もしない（恒等）。
  // DOM/乱数/Date 禁止（INV-1 相当。値は resolve() で焼き済み）。
  apply(props: Record<string, unknown>, ctx: EffectRenderCtx): EffectFilter | null;
  /** raster effect のみ。純関数・副作用なし。apply が { kind:"raster" } を返すときのみ呼ぶ */
  processPixels?(input: RasterBuffer, props: Record<string, unknown>, ctx: EffectRenderCtx): RasterBuffer;
}
```

- `pluginRegistry` に `registerEffect` / `getEffectDef(type)` / `listEffects()` を追加。DomRenderer と Inspector/Timeline は registry を lazy 参照（component と同じパターン）。
- builtin（`blur`/`tint`）も **エディタ初期化時に登録**する（§26.2 の builtin ComponentDef 登録と同じ場所・[store.ts](../src/editor/store.ts)）。
- **EffectDef I/O 契約**は §10/§14 の将来 WASM effect（buffer→buffer）と整合させる方針を維持（現状は DOM フィルタ片を返すが、`apply` は純関数で副作用なし）。

**登録 INVARIANT（effect / component）**: `registerEffect` / builtin `EffectDef` を追加・変更するとき、**必ず `previewBakeRequired` と `executionPath` を両方リテラルで明記**する。未指定・`kind` からの自動推論は禁止。

- `{ kind: "raster" }` / `processPixels` を持つ effect → 原則 **`previewBakeRequired: true`**
- `{ kind: "css" | "svg" }` のみ → 原則 **`previewBakeRequired: false`**
- `ComponentDef` も `previewBakeRequired` を必須明示（現行 builtin はすべて `false`）

**`executionPath` の確定割り当て**（§27.4 Live/Raster 調整レイヤーの effect 振り分けに使用。`kind` とは独立軸）:

| executionPath | builtin effect | 経路 |
|---|---|---|
| **`"live"`** | `blur` / `tint` / `linearWipe` / `angularWipe` / `pixelSortLite` / `mosaicLite` / `opticsCompensation` / `fastWave` / `fastRipple` / `fastTurbulentDisplace` | DOM `filter` / `backdrop-filter` を同期適用（中間 raster 化なし・軽量） |
| **`"raster"`** | `wave` / `turbulentDisplace` / `ripple` / `pixelSorter` / `mosaic` | canvas でピクセル処理（full displacement はドリフト対策で raster 必須・§27.1） |

- **Live調整レイヤー**の effect ピッカーは **`executionPath === "live"` のみ列挙**（§27.4 / §27.6）。**Raster調整レイヤー**と**通常レイヤー**は両方可。
- plugin effect は `executionPath` を必須明示。`processPixels` を持つなら原則 `"raster"`。

**§28 との二層ゲート**（2026-06 確定）:

| レイヤ | 制御 | 役割 |
|---|---|---|
| L1 | `PreviewCacheSettings.enabled`（ユーザー Caching チェックボックス、§28.5） | scrub/playback/background cache のマスタースイッチ |
| L2 | `compRequiresPreviewBake(comp)` — enabled effect/component の `previewBakeRequired` 集約 | Caching ON 時に Realtime 判定をバイパスしキャッシュ優先 |
| L3 | `RealtimeDetector` 中央値ヒューリスティック | baker 無し comp でユーザーが Caching ON にした場合のみ |

`exportStrategy: 'bake'`（§11.7 bundle export）とは **独立**（preview 専用メタ）。

**builtin 初期値**: `pixelSorter` / `mosaic` → `true`。その他 builtin（blur/tint/wave/turbulentDisplace/ripple/wipe/pixelSortLite/mosaicLite/fast*）→ `false`。

### §27.3 builtin エフェクト（確定）

#### `blur` — Gaussian Blur

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `blurriness` | Blurriness | scalar | `0` | min 0, max 500, step 0.1 | ✅ |

- `apply` → `{ kind: "css", fn: "blur(" + max(0, blurriness) + "px)" }`。`blurriness === 0` は `null`（恒等）。
- MVP は等方ブラーのみ（AE の Dimensions=Horizontal/Vertical は将来）。

#### `tint` — Tint（白黒 → 2 色マップ）

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `mapBlack` | Map Black To | color | `{r:0,g:0,b:0,a:1}` | — | ✅ |
| `mapWhite` | Map White To | color | `{r:1,g:1,b:1,a:1}` | — | ✅ |
| `amount` | Amount to Tint | scalar | `1` | 0..1, step 0.01 | ✅ |

- `apply` → `{ kind: "svg", primitives }`。SVG filter レシピ（SourceGraphic 入力）:
  1. `feColorMatrix type="saturate" values="0"` → 輝度グレースケール `L`。
  2. `feComponentTransfer` の `feFuncR/G/B type="linear" slope=(white.c - black.c) intercept=black.c"`（各チャンネル `c∈{r,g,b}`、0..1 を 0..1 で）→ `tinted = black + L·(white - black)`。アルファは SourceGraphic を保持（`feFuncA` は素通し or `feFuncA type="linear" slope=1`）。
  3. `amount` ブレンド: tinted を `feComponentTransfer feFuncA slope=amount` で不透明度 `amount` にし、`feMerge`（in=SourceGraphic, in=tinted-with-alpha）で原画の上に重ねる。`amount=1` で完全 tint、`0` で原画。
- 色値は 0..1（RGBA, §5.1）。slope/intercept は 0..1 空間でそのまま使える。

> **`amount` ブレンドの厳密性**は MVP では上記 feMerge 近似で可（AE の正確な線形補間と微差を許容・**AE 100% 一致は非目標**）。厳密合成（`feComposite arithmetic` で `out = src·(1-amount) + tint·amount`）が必要なら Phase 2。

#### `wave` — Wave（手続き型ディストーション）

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `amplitude` | Amplitude | scalar | `20` | min 0, max 500, step 0.1 | ✅ |
| `wavelength` | Wavelength | scalar | `50` | min 1, max 500, step 0.1 | ✅ |
| `direction` | Direction | enum | `"horizontal"` | `horizontal` / `vertical` | ❌ |
| `phase` | Phase | scalar | `0` | 0..360, step 1 | ✅ |
| `quality` | Quality | scalar | `1` | 0.1..1, step 0.05 | ✅ |

- `apply` → `{ kind: "svg", primitives }`。**真の正弦波** displacement map（`feImage`(data URI linearGradient) → `feDisplacementMap`）。AE Wave Warp のクリーンな正弦に合わせ、ノイズ（`feTurbulence`）は使わない。
- **`quality`（軽量化ノブ・§27.4）**: gradient サンプル数に乗算（`round(cycles·8·q)`、下限 2）。`q=1` で従来出力と一致。低 `q` ほど stop が粗く軽い（wave は元々軽量で効果は小さい）。
- `amplitude === 0` は `null`（恒等）。
- displacement map の各 stop 色 = `0.5 + 0.5·sin(2π·pos/λ + phase)` を片チャンネルに載せる（他チャンネルは中立 128）。`feDisplacementMap scale = 2·amplitude`（変位 = `scale·(channel−0.5)` ゆえ振幅 `amplitude` px）。
- **横波（transverse）**: AE Wave Warp 同様、波の**進行方向に垂直**に変位する（旗のはためき・tearing なし）。`direction=horizontal`（X 方向に進む波）は **Y 方向変位を G チャンネル**に（X 軸 linearGradient）、`vertical`（Y 方向に進む波）は **X 方向変位を R チャンネル**に載せる（他チャンネルは中立 128）。
- `phase` は data URI 内の正弦位相に直結 → **滑らかにスクロール**（seed 跳躍なし）。純関数の文字列生成のみ、乱数禁止（INV-1）。

#### `turbulentDisplace` — Turbulent Displace（Phase 1: Turbulent タイプのみ）

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `amount` | Amount | scalar | `50` | min 0, max 500, step 0.1 | ✅ |
| `size` | Size | scalar | `100` | min 1, max 2000, step 0.1 | ✅ |
| `complexity` | Complexity | scalar | `2` | 1..6, step 1 | ✅ |
| `evolution` | Evolution | scalar | `0` | 無制限（360°=1 revolution 相当）, step 1 | ✅ |
| `offsetX` | Offset X | scalar | `0` | 任意 px, step 1 | ✅ |
| `offsetY` | Offset Y | scalar | `0` | 任意 px, step 1 | ✅ |
| `randomSeed` | Random Seed | scalar | `0` | 0..9999, step 1 | ❌ |
| `quality` | Quality | scalar | `1` | 0.1..1, step 0.05 | ✅ |

- `apply` → `{ kind: "svg", primitives }`。`feTurbulence type="turbulence"`（`stitchTiles="stitch"`・レイヤー `(0,0,w,h)` に固定）→ optional `feOffset`（Offset + Evolution パン）→ `feDisplacementMap`。
- `amount === 0` は `null`。
- **Size**: AE Size ≈ feature wavelength（px）。`baseFrequency = 1 / size`（`ctx.width/height` と userSpace 整合）。
- **Complexity**: `numOctaves`（1..6、低=滑らか）。
- **`quality`（軽量化ノブ・§27.4）**: 実効 `numOctaves = max(1, round(complexity·q))`。`feTurbulence` の支配コスト=octave を削減するため**最も効く**。`q=1` で complexity 維持。低 `q` ほど粗く軽い（ガビガビ）。
- **Evolution**: `feOffset` による noise 場パン（連続）。`seed` 跳躍は使わない（AE 同様 Evolution をアニメ、Random Seed は static）。
- **Evolution 換算**: `dist = (evolution/360)·size`、`dx=cos(evolution°)·dist`、`dy=sin(evolution°)·dist`（近似・Cycle Evolution は Phase 2）。
- **filter region / host 寸法**: §27.1 displacement filter region 規約に従う。
- **非目標（Phase 1）**: Bulge / Twist / Vertical / Horizontal / Cross / Smoother 系、Pinning、Resize Layer、Cycle Evolution。**AE 100% 一致は非目標**。

#### `ripple` — Ripple（放射状近似）

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `radius` | Radius | scalar | `100` | min 0, max 1000, step 0.1 | ✅ |
| `amplitude` | Amplitude | scalar | `10` | min 0, max 200, step 0.1 | ✅ |
| `frequency` | Frequency | scalar | `5` | min 0.1, max 50, step 0.1 | ✅ |
| `centerX` | Center X | scalar | `0.5` | 0..1, step 0.01 | ✅ |
| `centerY` | Center Y | scalar | `0.5` | 0..1, step 0.01 | ✅ |
| `quality` | Quality | scalar | `1` | 0.1..1, step 0.05 | ✅ |

- `apply` → `{ kind: "svg", primitives }`。**真の放射方向**同心円 displacement map（`feImage`(**PNG data URI**) → `feDisplacementMap`）。各ピクセルで変位ベクトルを**半径方向の単位ベクトル** `(dx,dy)/dist` に向け、`mag = (1 − dist/radius)·sin(2π·frequency·dist/radius + phase)` を載せる（R=X 変位 / G=Y 変位・中立 128）。`radius` 外と中心は無変位（段差なし）。`center` は中心 px、`frequency` = `radius` 内のリング数。
  - **放射方向ベクトル `(cosθ, sinθ)` は radialGradient（半径方向にしか変化できない）では表現できない**ため、2D 場をピクセル単位で計算した PNG map を使う（純関数 `rippleDisplaceMap`／PNG エンコードは無圧縮 `rgbaToPngDataUri`・INV-1）。map は `RIPPLE_MAP_MAX_DIM`(=256) 以下に縮小生成し `feImage` がレイヤー実寸へ引き伸ばす（場は滑らかなので劣化しない・PNG 肥大化を防ぐ）。
  - **`quality`（軽量化ノブ・§27.4）**: 実効マップ長辺 = `max(16, round(RIPPLE_MAP_MAX_DIM·q))`。`q=1`→256（従来と一致）, 低 `q` ほど PNG セル数が二乗で減り生成＋`feImage` デコードが軽くなる（`feImage` 拡大でガビガビ化）。場が滑らかなので低 `q` でも放射方向・重心は保たれる。
  - 旧実装（radialGradient に sin/cos を載せ変位ベクトルを半径で回転）は**リングではなく渦（spiral）**になっていた回帰。`rippleDisplacementSample` は変位ベクトルが `(dx,dy)` と平行であることを単体テストで固定。
- 単一スカラ map ではなく per-pixel ベクトル map なので AE Ripple に近い同心円が出る（**AE 100% 一致は非目標**・現状 `phase` は内部既定 0・UI param 未公開）。
- `amplitude === 0` は `null`。`feDisplacementMap scale = 2·amplitude`（変位 = `scale·(channel−0.5)` ゆえ半径方向振幅 `amplitude` px）。
- **preview↔export 一致（INV-2）**: displacement raster パイプライン（`runDirectSvgDisplacePipeline` → `rasterizeFilteredImage`）で先に displaced canvas を焼き、export はその canvas を `inlineCanvasBitmaps` で bake するため**同一ピクセル**（実測 alpha-coverage diff 0）。

#### `opticsCompensation` — Optics Compensation（AE 相当・live）

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `fieldOfView` | Field Of View | scalar | `50` | 0..170, step 0.1 | ✅ |
| `reverse` | Reverse Lens Distortion | bool | `false` | — | ❌ |
| `centerX` | Center X | scalar | `0.5` | 0..1, step 0.01 | ✅ |
| `centerY` | Center Y | scalar | `0.5` | 0..1, step 0.01 | ✅ |
| `quality` | Quality | scalar | `1` | 0.1..1, step 0.05 | ✅ |

- `apply` → `{ kind: "svg", primitives }`。ripple 同型の **2D ベクトル PNG map**（`opticsCompensationDisplaceMap` → `feImage` → `feDisplacementMap`）。**等距離 fisheye ↔ rectilinear** 写像（半角 `θ = fieldOfView·π/360`）:
  - forward（`reverse=false`）: `rn' = tan(θ·rn)/tan(θ)`（fisheye 付与）
  - reverse（`reverse=true`）: `rn' = atan(rn·tan(θ))/θ`（fisheye 除去）
  - 変位は半径方向 `(dx,dy)/dist · (rn'−rn)·rMax`。`scale = 2·rMax·max|rn'−rn|`（rn∈[0,1] の解析最大・四隅 rn=1 では 0）。
- **`executionPath`: `"live"`** / **`previewBakeRequired`: `false`** / **`LIVE_DISPLACEMENT_EFFECT_TYPES`**（§27.12・raster capture 対象外）。
- filter region = layer bounds `(0,0,w,h)` クランプ（§27.12 改定3）。
- **非目標**: AE ピクセル完全一致、**Resize**（reverse 時のレイヤー拡大・端クリップは Phase 2）、色収差、カメラプロファイル。
- `fieldOfView === 0` は `null`（恒等）。

#### §27.4 ディストーション軽量化ノブ（`quality`）— 確定

HTML（live）再生でディストーション 3 種（`wave` / `ripple` / `turbulentDisplace`）の SVG フィルタは視聴者ブラウザで毎フレーム評価されるため、低スペック端末向けに「ガビガビだが軽い」描画へ落とせる per-effect ノブを持つ。

- **param**: `quality`（scalar・animatable・既定 `1`・min 0.1 / max 1 / step 0.05）。各エフェクトに追加。
- **写像（quality `q`）**: ripple = マップ長辺 `max(16, round(256·q))`、turbulentDisplace = `numOctaves max(1, round(complexity·q))`、wave = gradient サンプル数 `round(cycles·8·q)`（下限 2）。いずれも `q=1` で従来出力と完全一致（**後方互換**。`project.json` に未設定の既存作品は `1` フォールバックで挙動不変）。
- **INV-2 の扱い**: `quality` は `resolve()` の解決値に乗る通常プロパティであり、preview / browser export / HTML player の全経路へ**同一に**効く（解決値が一致するため INV-2 を満たす）。低 `q` による粒状感はラスタライズ品質差であって scene 解決値の差ではない（§26.7 のラスタライズ品質カーブアウトと整合）。
- **animatable だが非推奨**: フレーム間で `quality` が変わると特に turbulent は octave 数が跳ね popping するため、原則 static 運用とする（静的既定 1.0）。
- **重心不変**: 低 `q` でもディストーションの重心はドリフトしないことを実機計測で固定する（map 粗化が画像位置を動かさない）。

#### §27.5 Fast ディストーション（近似・Web/編集 UX 向け）— 確定

低スペック PC での編集スムーズ化・HTML/live 配布向けに、フル版（§27.3 `wave` / `ripple` / `turbulentDisplace`）と**共存**する超軽量近似 builtin エフェクトを提供する。カテゴリ **`ディストーション（軽量）`**。label は **`Mosaic (Lite)` / `Fast Wave` / `Fast Ripple` / `Fast Turbulent Displace`**（type: `mosaicLite` / `fastWave` / `fastRipple` / `fastTurbulentDisplace`）。

- **使い分け**: 編集中・Web 配布・プレビュー重視 → Fast。最終仕上げ・AE 近似 → フル版 + `quality`。
- **`quality` param は持たない**（Fast 自体が常時低品質）。
- **INV-2**: Fast も resolved props の通常 effect。`resolve()` 解決値は preview / export / HTML player 全経路で同一。**描画経路**は §27.12 参照（**raster 無し・live CSS filter 直適用**、filter region = layer bounds (0,0,w,h) クランプ。フル版 displacement のみ raster）。
- **改定4（2026-06-21）— Fast 3 種すべて `feImage` 廃止 / `feTurbulence` 直結に統一**: `fastWave` / `fastRipple` はかつて linearGradient / radialGradient の `feImage`（data URI）displacement map を**毎フレーム文字列生成→ブラウザで再デコード**していた（`fastTurbulentDisplace` だけが GPU ネイティブな `feTurbulence` 直結で軽かった）。ユーザー要請（2026-06-21・「Fast Turbulent と同等の軽さ」「Fast 系は Web で動く前提」）により、`fastWave` / `fastRipple` も **`feTurbulence`（`type="fractalNoise"`・`numOctaves=1`）直結の純 SVG filter primitive へ置換**。`feImage` も PNG も生成しない。3 種すべて per-frame コストが同等（小さな primitive 文字列 + GPU ノイズ）になり、Web bundle / HTML player でも `feImage` data URI のデコードを伴わず軽量に動く。
- **非目標（改定4）**: AE 100% 一致、ripple 真の同心円、wave 真の正弦。**`fastWave` の正弦 / `fastRipple` の同心円という見た目は意図的に放棄**し、`feTurbulence` ベースの方向性 / 等方ノイズ歪み近似とする（ユーザー承認済みトレードオフ）。`wavelength` / `frequency`・`radius` は noise の特徴サイズ（`baseFrequency`）へ、`direction` は周波数の異方軸へ、`phase` / `center` は noise 場のパン（`feOffset`）へマップ。**実体（host rect）の amplitude/amount 比例スライドを禁止**（Draft/Best/export 共通）。ink centroid は 3 種とも `feTurbulence` + bias（`skipBias: false`）で host 安定が正準（強い amount でエッジクリップにより centroid がわずかに動くことはある）。真の正弦 / 同心円が要るときは**フル版 `wave` / `ripple`**（§27.3・`feImage` / PNG map・raster）を使う。
- **filter region は (0,0,w,h) クランプが正準（§27.12 改定3）**: live CSS filter で displacement を適用する際、filter region を pad せず layer 実寸に固定する。`feTurbulence` は全域定義（`stitchTiles="stitch"`）なので改定3 の pad 帯ドリフト（`feImage` 未定義域の定数変位）は構造的に発生しないが、クランプは raster（出力を W×H へクリップ）との pixel parity・フル版 displacement との一貫性のため維持する。
- **改定5（2026-06-21）— Fast 3 種の「見た目の動き」を滑らかに（内部既定・パラメータ不変）**: 改定4 で `feTurbulence` 直結にして軽くなったが、単一オクターブ noise を全帯域のまま `feDisplacementMap` に通すためエッジ変位が粒状で、動きがカクついて見えた。ユーザー要請（2026-06-21・「軽量化を維持したまま見た目の動きを滑らかに」「制御面 A＝内部既定・パラメータ追加なし」）により、**effect params を一切変えず builder 内部だけ**で 3 点を改善する。**`feImage` 復活なし・軽量維持・INV-2 維持（emit primitives は全経路同一）・§5/INV/直列化 不変**。
  - **(1) feature-size 比例の map smoothing を常時適用**: noise map（`feTurbulence` 出力）の直後に `feGaussianBlur` を常時かけ、`stdDeviation = clamp(FAST_SMOOTH_FRACTION · 特徴サイズ, 0.75, ~12)` px とする（特徴サイズ＝`fastWave`: `λ` / `fastRipple`: `radius/frequency` / `fastTurbulentDisplace`: `size`）。高周波スペックルを均して「流れる」歪みにする。既定で flowing になり、`antiAlias` は **追加の増分**（`+1px`）として存続。blur は変位の山をわずかに均すため fraction は控えめにし、実機 verify で効果が消えない（edgeStd > baseline+2）範囲に保つ。
  - **(2) `fastWave` phase の段差ジャンプ解消**: phase の `feOffset` パンを `% 360` で折り返すと 1 周ごとに ~λ の段差ジャンプが出ていた。phase パンを **連続値 `(phaseDeg/360)·λ`（折返しなし・単調）** にして跳躍を消す。`fastWave` の `feTurbulence` は **`stitchTiles` を外し座標安定な無限ノイズ場**とするため、パンに合わせて生成域を広げてもノイズ値が変化せず（boiling せず）連続的に流れる。（`feOffset` は有限ラスタを平行移動するだけで wrap しないため、タイル周期化では seamless にできない。座標安定場＋生成域拡張が正しい解。）
  - **(3) パン露出ポップの解消**: `feOffset` 後にラグ側へ未定義域（channel≈0＝定数変位）が出て素エッジが歪んで露出するのを、`feTurbulence` の **生成領域**（primitive の x/y/width/height）を maxPan ぶん対称拡張して `feOffset` 後も layer (0,0,w,h) を被覆して防ぐ。`fastWave` は per-frame の `|pan|` ぶん拡張（stitch off で boiling せず）、`fastRipple` は center 範囲 `0.5·{w,h}` を**定数 pad**（生成域一定・stitch 維持）。`fastTurbulentDisplace` は **既存の region/pan を維持（blur のみ追加）** し、検証済みの ink centroid（≤2px）を保全する（evolution は元々連続パンで跳ばない）。**filter region 自体は改定3 のまま (0,0,w,h) クランプ**（出力に素矩形露出なし）。

**共通 param `antiAlias`**（3 種）:

| param key | label | kind | default | animatable |
|---|---|---|---|---|
| `antiAlias` | Anti Alias | bool | `false` | ❌ |

- 改定5: Fast 3 種は **既定で feature-size 比例の map smoothing（§27.5 改定5 (1)）が常時 ON**。`antiAlias` はそれに **+1px** を足す追加の増分（より滑らか）。`stdDeviation` 合計 = `smoothPx + (antiAlias ? 1 : 0)`、`>0` のとき noise / map 直後に `feGaussianBlur` 1 回 → `feDisplacementMap`。
- （フル版 displacement で本 param を使う場合は従来どおり ON で固定 1px）。

##### `mosaicLite` — Mosaic (Lite)

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `blockSize` | Block Size | scalar | `16` | `2..256`, step 1 | ✅ |

- **目的**: 真のブロック平均化ではなく、各出力ピクセルのサンプリング位置を `blockSize` グリッドのブロック中心へスナップする軽量近似ピクセレート。多くの pixelate shader と同じ「代表点サンプル」方式で、`mosaic`（下記）の正確な平均化とは見た目が一致しないことを許容する。
- **描画**: `apply` → `{ kind: "svg", primitives }`。`feImage` に block×block の変位マップタイル（R/G で X/Y の中心スナップ量をエンコード）を渡し、native `feTile` で filter region 全域へ敷き詰めてから `feDisplacementMap` へ入力する。filter region は既存 Fast* と同じく layer bounds `(0,0,w,h)` にクランプする。
  - **改定6（2026-07-12）**: タイル内部は当初 2×`linearGradient` + `mix-blend-mode:screen` を `<pattern>` でブラウザに解決させていたが、compositor の per-draw コストが実測で極端に重い（`MainFrame.Draw` が feTurbulence 系 Fast* 比で約200倍）ことが判明したため、gradient ランプを JS 側で事前計算し `rgbaToPngDataUri()` で焼いた PNG タイルに変更した。GPU 側コスト（`SwapBuffers`/`Present`）は大幅減（約17〜25倍）したが、`MainFrame.Draw` 自体は 60→54ms とほぼ残存した。
  - **改定7（2026-07-12）**: 改定6 で残った `MainFrame.Draw` 54ms の実体は、**PNG タイルを敷くために使っていた `feImage`(ネスト SVG 文書内の `<pattern>`) を、backdrop-filter 下で Chrome が毎フレーム再ラスタライズしていた**こと（実測で確定）。ネスト SVG 文書 + `<pattern>` を捨て、`feImage`(block×block の生 PNG 1枚) + native `feTile` に置換したところ、`MainFrame.Draw` は 54ms → **0.4ms（97%減・ほぼベースライン同等）**になった。視覚的な意味・見た目は改定6と完全一致（export ink 数一致）。詳細: `doc/cloudplan/mosaic-lite-phase-a-bench-report.md` §6.7。
- **経路**: `executionPath: "live"` / `previewBakeRequired: false` / `LIVE_DISPLACEMENT_EFFECT_TYPES`。通常レイヤーは `filter: url(#fx)`、Live調整レイヤーは `backdrop-filter: url(#fx)` に同期適用する。Auto Preview Cache 対象外。
- **恒等**: `blockSize <= 1` は `null`（filter なし）。
- **既知差**: 端の半端なブロックは full block tile の中心スナップ近似になる。厳密な端ブロック平均が必要な場合は raster 版 `mosaic` を使う。

##### `fastWave` — Fast Wave

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `amplitude` | Amplitude | scalar | `20` | min 0, max 500, step 0.1 | ✅ |
| `wavelength` | Wavelength | scalar | `50` | min 1, max 500, step 0.1 | ✅ |
| `direction` | Direction | enum | `"horizontal"` | `horizontal` / `vertical` | ❌ |
| `phase` | Phase | scalar | `0` | 0..360, step 1 | ✅ |
| `antiAlias` | Anti Alias | bool | `false` | — | ❌ |

- `apply` → `{ kind: "svg", primitives }`。**改定4: `feTurbulence` 近似（`feImage` なし・`fastWaveDisplace`）**。`type="fractalNoise"`・`numOctaves=1`。`wavelength` → 進行方向軸の `baseFrequency = 1/λ`、直交軸は `1/(4λ)`（低周波で稜線を伸ばし波 train 風に）。`direction` でどちらの軸を進行方向にするか切替。`phase` → 進行方向の `feOffset` パン（`(phase/360)·λ` px）でスクロール再現。`scale = 2·amplitude`。正弦 map（`waveDisplaceMapSvg`）は**フル `wave` 専用**となり Fast からは不参照。**改定5: noise map に feature-size 比例 blur（`stdDev ≈ FAST_SMOOTH_FRACTION·λ`）を常時適用。phase パンは連続値 `(phase/360)·λ`（`% 360` 折返し撤廃で段差解消）、`stitchTiles` を外した座標安定場とし生成域を `|pan|` ぶん対称拡張して露出ポップを防ぐ。**
- `amplitude === 0` は `null`。

##### `fastRipple` — Fast Ripple

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `radius` | Radius | scalar | `100` | min 0, max 1000, step 0.1 | ✅ |
| `amplitude` | Amplitude | scalar | `10` | min 0, max 200, step 0.1 | ✅ |
| `frequency` | Frequency | scalar | `5` | min 0.1, max 50, step 0.1 | ✅ |
| `centerX` | Center X | scalar | `0.5` | 0..1, step 0.01 | ✅ |
| `centerY` | Center Y | scalar | `0.5` | 0..1, step 0.01 | ✅ |
| `antiAlias` | Anti Alias | bool | `false` | — | ❌ |

- `apply` → `{ kind: "svg", primitives }`。**改定4: `feTurbulence` 近似（`feImage`/PNG なし・`fastRippleDisplace`）**。`type="fractalNoise"`・`numOctaves=1`・等方 `baseFrequency = frequency/radius`（リング間隔 `≈ radius/frequency` px を特徴サイズとみなす）。`centerX`/`centerY` → noise 場の `feOffset` パン（`(center−0.5)·{w,h}` px）で中心位置を近似。`scale = 2·amplitude`。`radialGradient` map（`rippleDisplaceMapSvg`）は**削除**（フル `ripple` は per-pixel PNG `rippleDisplaceMap` を継続使用）。同心円ではなく等方ノイズ歪み近似。**改定5: noise map に feature-size 比例 blur（`stdDev ≈ FAST_SMOOTH_FRACTION·(radius/frequency)`）を常時適用し、center パン量 `|center−0.5|·{w,h}` を `feTurbulence` 生成域の maxPan として拡張し露出ポップを防ぐ。**
- `amplitude === 0` は `null`。`phase` param なし。

##### `fastTurbulentDisplace` — Fast Turbulent Displace

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `amount` | Amount | scalar | `50` | min 0, max 500, step 0.1 | ✅ |
| `size` | Size | scalar | `100` | min 1, max 2000, step 0.1 | ✅ |
| `complexity` | Complexity | scalar | `2` | 1..6, step 1 | ✅ |
| `evolution` | Evolution | scalar | `0` | 無制限, step 1 | ✅ |
| `offsetX` | Offset X | scalar | `0` | 任意 px, step 1 | ✅ |
| `offsetY` | Offset Y | scalar | `0` | 任意 px, step 1 | ✅ |
| `randomSeed` | Random Seed | scalar | `0` | 0..9999, step 1 | ❌ |
| `antiAlias` | Anti Alias | bool | `false` | — | ❌ |

- `apply` → `{ kind: "svg", primitives }`。`feTurbulence` 直結、`type="fractalNoise"`（WIP の `turbulence` 型は CSS filter 直適用 path で centroid ≤2px を満たせないため Fast は fractalNoise + G bias を採用）、`numOctaves = max(1, min(2, complexity))`。Evolution/Offset は WIP / フル版同様 `feOffset`。**改定5: noise map に feature-size 比例 blur（`stdDev ≈ FAST_SMOOTH_FRACTION·size`）を常時適用（既存の region/stitch/pan は維持し検証済み centroid ≤2px を保全。evolution は従来どおり連続パンで跳躍なし）。**
- preview/bundle 直適用 path の受け入れ条件: amount 5/20/50/100 スイープで ink centroid delta **≤ 2px**（comp 座標）。
- `amount === 0` は `null`。

##### `glitchSlice` — Glitch Slice（§2.2 4 配線点 + §2.5 生 PNG マップ）

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `intensity` | Intensity | scalar | `0.5` | 0..1, step 0.01（= slice ごとの jump 発生密度） | ✅ |
| `maxShift` | Max Shift | scalar | `60` | 0..500 (px), step 1 | ✅ |
| `sliceHeight` | Slice Height | scalar | `24` | 2..256 (px), step 1 | ✅ |
| `evolution` | Evolution | scalar | `0` | 無制限（度）, step 1 | ✅ |
| `seed` | Seed | scalar | `0` | 0..9999, step 1 | ❌ |

- `apply` → `{ kind: "svg", primitives }`（`intensity === 0` または `maxShift === 0` → `null`）。
- **技法（§2.5・SVG `<rect>` マップは使わない）**: `glitchSliceDisplaceMapPng()` が変位マップを**生 PNG に焼く**（スライスごとに値が異なりタイル化不可のため `feTile` は使わない・`feImageLayer` で `(0,0,w,h)` へ引き伸ばして渡す）。スライス `y∈[k·sliceHeight,(k+1)·sliceHeight)` ごとに `seededRandom((seed·1000003 + k·97 + phaseToSeed(evolution)) >>> 0)` から jump 判定（`< intensity`）と変位量（R チャンネル `0.5 + shift/2`、未変位帯は R=0.5）を決定。G は中立 0.5 固定（水平スライスのため Y 変位なし）。`displaceWithMap(uri, maxShift, w, h)` で `feDisplacementMap` に接続。
- **改定1（重さ対策・2026-07-13）**: 変位は x に依存しない（同一スライス内は全 x で同一値）ため、生成 raw buffer は `w×h` ではなく **`1×h`**（水平方向は `feImage` の `width` 引き伸ばしに委譲・1 列複製なので補間誤差ゼロ）。初版は 1920×1080 で 8.3MB の raw buffer を毎 `apply()` 呼び出しで生成しており、これが実測の重さの主因だった（§2.5 の「feImage ネスト文書」問題とは別軸の JS 側ラスタ生成コスト）。垂直方向は `h=h` のまま（スケーリングなし）でスライス境界の離散性を維持。
- **§2.2 の 4 配線点（すべて対応済み）**: `effectSvg.ts` の `DISPLACEMENT_EFFECT_TYPES` / `FAST_DISPLACEMENT_EFFECT_TYPES` / `LIVE_DISPLACEMENT_EFFECT_TYPES` に `"glitchSlice"` 追加済み（region クランプ + Draft Preview Fast Path + live 判定）、`effectChain.ts` の scale 分岐に `glitchSlice` → `maxShift` 追加済み（`fxMaxDisplaceScale` へ反映）。
- **カテゴリ**: `"ディストーション（軽量）"`（`fastEffects.ts` に登録）。
- **経路**: live SVG（`executionPath: "live"`）。map smoothing（`fastSmoothPx`）は**掛けない**（グリッチは離散が正）。`chromaOffset` 連結は初版で未実装。
- **human 受け入れ**: ① preview/export の 1 フレーム画素一致（INV-2）、② amount 大での重心ドリフトが raster 版と小数2桁一致、③ §2.5 の重さ（実 Chrome + CDP Tracing で `MainFrame.Draw` がベースライン同等）— いずれも本セッション未実施（票の完了条件から自動宣言は除外）。
- **非目標**: raster 版の並行提供。真のピクセル並び替え（引き延ばし/オフセット近似のみ）。

##### `pixelStretch` — Pixel Stretch（Directional Line Stretch・§2.2 4 配線点）

> **由来 / 改定2（2026-07-13）**: 初版（D-1 spike）は pivot 中心の対称線形ランプ（`dy=-(y-pivot)`）で、pivot 近傍が単色スミア・遠方は量子化された剛体シフトコピー、という「切ってずらす」見た目だった。ユーザーの意図（参照画像＝**あるラインを境に、そのライン上の色を一方向へそのまま塗り延ばす**）と別物と実機判断で確定したため、**Directional Line Stretch** へ全面再設計。独立作業票 [pixel-stretch-directional-line-stretch.md](../cloudplan/pixel-stretch-directional-line-stretch.md) を正とする（acid-digi プランとは切り離した独立エフェクト）。前回フィードバックの「ランダム長・複数ライン・残像/前フレーム混合＝datamosh 系」は**別エフェクト**（`pixelSmear` 候補・保留）へ分離。

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `direction` | Direction | enum | `"right"` | `right` / `left` / `down` / `up` | ❌ |
| `linePos` | Line Pos | scalar | `0.5` | 0..1, step 0.01（ソースライン位置） | ✅ |
| `lineBias` | Line Bias | scalar | `8` | -200..+200 (px), step 1（サンプル元ラインの手動オフセットのみ。帯/エフェクト開始位置は linePos のみで決まる。default=8 は box-vs-ink オフセットの実測近似値・PLAN-ALT-1 WP-3。根治ではないため content 次第で手動微調整が必要） | ✅ |
| `length` | Length | scalar | `300` | 0..2000 (px), step 1（引き伸ばし帯の長さ＝`scale`） | ✅ |
| `density` | Density | scalar | `1` | 0..1, step 0.01（1=完全ストレッチ / 下げるとスライス反復） | ✅ |

- `apply` → `{ kind: "svg", primitives }`（`length === 0` → `null`）。`pixelStretchPrimitives()` が `feImage`(生 PNG)＋`feDisplacementMap` の 1〜2 段チェーン（改定3）を返す。マップ生成の純関数は `pixelStretchDisplaceMaps()`（`scale1 = 2·length`）。
- **技法（pull 型 displacement）**: `feDisplacementMap` は出力ピクセル `p` が入力 `p + scale·(ch − 0.5)` をサンプルする pull 型。`(ch − 0.5) ∈ [−0.5, +0.5]` なので変位量の最大は `scale·0.5`。
  - 帯（エフェクト適用領域）の開始位置は `base = round(linePos · n)` のみで決まる（`length` で帯長を張る）。
  - サンプル元ラインは `src = clamp(base + lineBias)`（`lineBias` はサンプル元だけをずらす。帯位置は動かさない）。
  - 帯内の各ピクセルは `src` を厳密にサンプルするよう `ch = 0.5 + (src − p)/(2·length)` を焼く（density=1 の完全ストレッチ時）。`scale=2·length`。
  - 帯外は `ch=0.5`（無変位）。結果、**ライン上の色が帯全域へ塗り延ばされる有限帯ストレッチ**。
  - 方向は軸（X→R / Y→G）と符号で切替（`right`/`down` は base の後方へ帯を張り、`left`/`up` は前方へ）。`displaceWithMap` 固定規約に合わせ横は R・縦は G。`effectChain.ts` の region クランプは `length` を参照。
  - `lineBias` の典型用途：実機で「奥がサンプルされる」ズレを逆方向に詰める手動補正（PLAN-ALT-1）。
- **冗長軸圧縮（軽量ライブの担保）**: 値は変位軸のみに依存するため、生 PNG バッファは横 `w×1` / 縦 `1×h`（もう一方は `feImage` の width/height 引き伸ばしに委譲・1 列/行複製なので補間誤差ゼロ）。plain `feImage` stretch のため `feTile`-1px 縮小罠（scanlines 改定1）には非該当。glitchSlice の 1×h 最適化と同型。
- **精度メモ**: 帯内で使う ch レンジは `right`/`down` が `[0.5,0]`、`left`/`up` が `[0.5,1]`（無変位域を厳密 0.5 に固定する制約上、方向ごとに半分だけ）。1 階調あたりの変位 = `scale/255 = 2·length/255` px。`length > 128` では 8-bit 量子化により約 `2·length/255` px 幅の**プラトー**（同一コード連続域）ができ、プラトー内は剛体コピー＝スライス反復に見える（改定3 で解消）。
- **改定3（2026-07-13・`density` + 2 段残差補正）**: ユーザー要望「密度を弄れるように」（低密度=スライス反復の質感 / density=1=帯全域がライン 1 列の色で塗り延ばされる完全ストレッチ）に対応。
  - **`density` → スライス幅**: `sliceW = max(1, round((1 − density) · 64))` px。帯内のターゲットは `t(i) = line ± ((|i−line|) mod sliceW)`（ライン起点の `sliceW` 幅ストリップを反復コピー）。`density=1` で `sliceW=1` ＝全ピクセルが `t(i)=line` を狙う完全ストレッチ。
  - **2 段目（残差補正）**: `scale1 = 2·length > 255` のとき 8-bit 量子化プラトーが 1px を超え、1 枚のマップでは `t(i)` に届かない。そこで stage1 の**実際の 8-bit 到達位置** `achieved(y) = y + scale1·(c1(y)/255 − 0.5)` を JS 側で厳密に計算し、各出力 `i` について `|achieved(y) − t(i)|` を最小化する**整数** `y`（探索窓 ±(⌈scale1/255⌉+2)）を選び、`δ2(i) = y − i` を第 2 マップ（`scale2 = 2·(max|δ2|+1)`・同じく生 PNG `w×1`/`1×h`）に焼く。primitives は `feImage+feDisplacementMap` を 2 連結（stage2 の `in` は stage1 の `result`）。**整数着地**にすることで stage2 の線形補間が異なるソース由来のピクセルをブレンドするのを回避（残差 ≤ ~0.5px + stage2 自身の量子化 `scale2/510` ≪ 1px）。`scale1 ≤ 255`（`length ≤ 127`）または全 `δ2 = 0` のときは stage2 を省略（1 段のまま）。
  - **重さ**: stage2 は同じ `w×h` 領域への feDisplacementMap 1 パス追加＋JS 探索 `O(n·⌈scale1/255⌉)`（1920px・length=2000 でも ~2 万 op）で、ライブ性は維持。`length` を超える変位は引き続き表現不可（有限帯の設計上の上限）。
- **§2.2 の 4 配線点（すべて対応済み）**: `DISPLACEMENT_EFFECT_TYPES` / `FAST_DISPLACEMENT_EFFECT_TYPES` / `LIVE_DISPLACEMENT_EFFECT_TYPES` に `"pixelStretch"` 登録済み、`effectChain.ts` の scale 分岐に `pixelStretch` → `length` を追加（旧 `amount` 廃止に伴い generic フォールバックに任せられないため明示分岐）。
- **カテゴリ**: `"ディストーション（軽量）"`（`fastEffects.ts` に登録）。**経路**: live SVG（`executionPath: "live"`）。
- **human 受け入れ**: ① 実機で参照画像の見た目（ラインから色が一方向へ引き伸ばされる）、② preview/export の 1 フレーム画素一致（INV-2）、③ ライブ性（実 Chrome + CDP Tracing で `MainFrame.Draw` がベースライン同等）。
- **非目標**: ランダム長・複数ライン・残像/前フレーム混合（＝別エフェクト `pixelSmear`）。raster 版。

##### `liquidChrome` — Liquid Chrome（Y2K 液体クローム・fill 方式・§2.2 配線点）

> **作り直し（2026-07-14）**: 初版は D-2 spike（`feSpecularLighting`）を経て「**コンテンツを turbulence で displace + specular + gradientMap(chrome)**」の 3 段合成で実装したが、下地（テキスト/背景）が主役のまま歪むだけの**低コントラストなパステル雲**にしかならず、リファレンス（研磨金属が流れる pic1）の液体クロームにならなかった（ユーザー実機判断）。技法を **fill 方式**へ全面作り直し。旧実装の feSpecularLighting / gradientMapTable(chrome) 依存は撤去。
>
> **正しい技法の要点**: pic1 の質感 =「**シャープな金属環境の縞グラデ**を流体 turbulence で歪ませたもの」。縞がシャープなので歪めても鋭い反射線が残る。滑らかなノイズ値をバンド化する方式（旧案）は「バンド自体がボケて大理石/雲」になり不可。

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `size` | Size | scalar | `140` | 1..2000, step 0.1（turbulence 特徴サイズ＝流れの大きさ） | ✅ |
| `warp` | Warp | scalar | `160` | 0..500, step 1（1 段目 displacement scale＝渦の骨格） | ✅ |
| `detail` | Detail | scalar | `45` | 0..200, step 1（2 段目 curl displacement scale＝eddy/閉ループ） | ✅ |
| `bands` | Bands | scalar | `6` | 1..24, step 1（金属縞グラデの周期数＝反射線の密度） | ✅ |
| `evolution` | Evolution | scalar | `0` | 無制限 (deg), step 1 | ✅ |
| `seed` | Seed | scalar | `7` | 0..9999, step 1 | ❌ |
| `quality` | Quality | scalar | `1` | 0.1..1, step 0.05（0.5 未満で base turbulence を 2 octaves に低下） | ✅ |

- `apply` → `{ kind: "svg", primitives }`（常時適用・下地の色は捨てレイヤーのアルファ形状をクロームで塗る fill）。純関数 `liquidChromePrimitives()`（`effectSvg.ts`）が生成。
- **技法（fill 方式）**:
  1. `feTurbulence type="fractalNoise" stitchTiles="stitch"`（`baseFrequency = sizeToFrequency(size)`・`numOctaves`=quality依存・**生成域 `(0,0,w,h)` 固定**）→ `feTile` で `(−w,−h,3w,3h)` にシームレス展開 → `evolution` パンを周期 `(w,h)` で畳んだ `feOffset`（下記「動く四角枠対策」）。
  2. **金属縞グラデ**を `chromeStripPng(bands)`（純関数・生 PNG・縦 `bands` 周期のグラデ: 黒(青み)→スチール→鋭い白ハイライト→ピンク(イリデッセンス)→暗紫→黒。両端同色で縦タイル seam レス）で焼き、`feImage` で `(0,0,w,h)` に敷いて `feTile` で 3×3 展開（displacement が端で透明を引かない）。
  3. 縞を **2 段 `feDisplacementMap`** で歪ませる: 1 段目 `scale=warp`（大きく折る＝渦の骨格）→ 2 段目は `size·0.45` の細かい `feTurbulence type="turbulence"` を map に `scale=detail`（curl させ閉ループ/eddy を作る）。→ 鋭い反射線が流れる液体クローム。
  4. `feComposite operator="in" in2="SourceAlpha"` でレイヤー形状に閉じ込め（テキスト/shape/solid の中身がクローム化・下地の色は捨てる）。
- **evolution パンの「動く四角枠」対策（tile+mod 方式）**: 生成域 `(0,0,w,h)` 固定（`stitchTiles` で `(w,h)` 周期）のまま `feTile` でシームレス 3×3 展開し、パン先も縞も常に実データで被覆。`evolution` 生オフセットは `dist=(deg/360)·size` で無限に増えるが、場は周期 `(w,h)` なのでオフセットを **`mod (w,h)`** で `[0,w)/[0,h)` に畳んでも同一像（連続・シームレス）。**却下した padding 方式**は pan 量が毎フレーム変わり生成域サイズ変化 → `stitchTiles` の周波数が変わってノイズが沸き立つ（boiling）ため不採用。
- **§2.2 の配線点**: 内部で `feDisplacementMap` を使うため displacement 系として `DISPLACEMENT_EFFECT_TYPES` / `FAST_DISPLACEMENT_EFFECT_TYPES`（→ `LIVE_DISPLACEMENT_EFFECT_TYPES` に自動伝播）に `"liquidChrome"` 登録。`effectChain.ts` の scale 分岐は `liquidChrome` → `p["warp"]` を明示追加（region クランプ参照スケール）。出力は `SourceAlpha` に閉じるためレイヤー矩形を超えない。
- **カテゴリ**: `"スタイライズ"`（`fastEffects.ts` に登録）。**経路**: live SVG（`executionPath: "live"`）。
- **決定論（INV-1）**: `Math.random` 不使用。`seed` は `feTurbulence` に直接渡す。strip は純関数 `chromeStripPng` で deterministic。
- **INV-2**: `verify-liquidchrome-parity.mjs`（**実 DomRenderer 経路**で on-screen 合成 vs export capture）で evo 0/90/270 とも `maxDiff=0`。bundle player は preview と同じ live CSS filter 経路のため 3 経路担保。※手組み container + `captureElementToCanvas` は foreignObject シリアライズが黒落ちする既知のハーネス制約があり信頼できない。
- **テスト**: `test/liquidChrome.test.ts`（`chromeStripPng`/`liquidChromePrimitives` の決定論・fill 構造＝feImage strip + 2 displacement + SourceAlpha 閉じ込め・旧 feSpecularLighting 非残存・param 反映・tile+mod 枠対策・§2.2 3 Set 登録・EffectDef param キー）。
- **既知の制約**: 2 段目 displacement は warp1 出力を `(0,0,w,h)` クランプ後に detail(≤200px) で引くため、**レイヤー矩形いっぱいの solid** では端に最大 detail 幅の微小なにじみが出得る（マージンのあるテキスト/shape では不可視）。
- **非目標**: パレット/preset 選択（金属縞は固定・v1）。物理ベースの環境反射・AE 相当のフォトリアル金属シェーダ一致。`fill=false`（下地を歪ませる金属ガラス風）モードは将来課題。

#### `linearWipe` — Linear Wipe

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `completion` | Transition Completion | scalar | `0` | 0..1, step 0.01 | ✅ |
| `angle` | Wipe Angle | scalar | `0` | 無制限（AE 同様・負値・360 超可）, step 1 | ✅ |
| `feather` | Feather | scalar | `0` | min 0, max 200, step 0.1 | ✅ |

- `apply` → `{ kind: "svg", primitives }`。`feImage`（data URI linearGradient マスク・白=表示/黒=消去）→ **`feColorMatrix type="luminanceToAlpha"`**（luminance を alpha へ変換）→ optional `feGaussianBlur`（feather）→ `feComposite operator="in"`。
  - **重要**: `feComposite operator="in"` は in2 の **alpha** で切り抜くため、白黒 luminance を必ず `luminanceToAlpha` で alpha 化してから合成する（これを欠くとマスクが効かない）。
- **AE 準拠の極性**: `completion <= 0` は `null`（完全表示・恒等＝エフェクト追加直後は無作用）。`completion >= 1` は全消去（非表示）。表示領域 = `(1 − completion)`。`angle` で wipe の向きを回転。

#### `angularWipe` — Angular Wipe

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `completion` | Transition Completion | scalar | `0` | 0..1, step 0.01 | ✅ |
| `startAngle` | Start Angle | scalar | `0` | 無制限（AE 同様・負値・360 超可）, step 1 | ✅ |
| `centerX` | Center X | scalar | `0.5` | 0..1, step 0.01 | ✅ |
| `centerY` | Center Y | scalar | `0.5` | 0..1, step 0.01 | ✅ |
| `feather` | Feather | scalar | `0` | min 0, max 200, step 0.1 | ✅ |

- `apply` → `{ kind: "svg", primitives }`。`feImage`（data URI 扇形 wedge マスク・白背景＋黒扇形）→ **`feColorMatrix type="luminanceToAlpha"`** → optional `feGaussianBlur` → `feComposite operator="in"`。
- **AE 準拠の極性**: `completion <= 0` は `null`（完全表示）。`completion >= 1` は全消去。黒い扇形（= 消える領域）が `startAngle`（0 = 真上）から時計回りに `sweep = completion·360°` で広がる。

> **ワイプ共通**: エフェクト配列順を維持するため `clip-path` ではなく SVG filter 内マスク（§27.1）。AE Transition 100% 一致は非目標。

#### `ditherDissolve` — Dither Dissolve

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `completion` | Transition Completion | scalar | `0` | 0..1, step 0.01 | ✅ |
| `pattern` | Pattern | enum | `"ordered"` | `ordered` / `blueNoise` | ❌ |

- `apply` → `{ kind: "svg", primitives }`（**live**。wipe と同型: `feImage` タイル pattern マスク → `luminanceToAlpha` → `feComposite operator="in"`）。`feTile` は使わない。**ラスタ bake 経路は使わない**（`previewBakeRequired: false` 固定）。
- **`pattern`**: `ordered` = 8×8 Bayer 秩序ディザ（既定・旧 blendMode 互換）。`blueNoise` = 64×64 rank タイル（格子感を抑えた不規則ディザ）。いずれも SVG `<pattern>` + `feImage` のみ。
- **有効表示率**: `effectiveReveal = quantize(layerOpacity × (1 − completion))`（64 段量子化・[`ditherReveal.ts`](../src/runtime/ditherReveal.ts)）。`layerOpacity` は `EffectRenderCtx` で DomRenderer が `ResolvedObject.opacity` を注入。
- **恒等**: `effectiveReveal >= 1` → `null`（filter なし）。`effectiveReveal <= 0` → 全消去。
- **`executionPath`**: `"live"` / **`previewBakeRequired`**: `false` / **カテゴリ**: `"ワイプ"`。
- **描画**: `effectiveReveal < 1` の間、host div の CSS `opacity` は **1 に強制**（Bayer マスクが透明度を担う。CSS opacity との二重減衰を防ぐ）。
- **意味**: **マスク型ディザ dissolve**（レイヤー自己マスク）。AE Dither Dissolve **ブレンドモード合成の 100% 代替ではない**（下層との合成挙動は近似）。
- **旧 `blendMode: "ditherDissolve"`**: §5.4d から削除済み。`blendMode=normal` + 本エフェクトを使用。load 時 unknown blend は `missingBlendModes` UI のまま。
- **エフェクト順**: チェーン**末尾推奨**（blur 等の後ろだとエッジがぼける）。
- **既知制約**: ネスト内で full displacement と併用時は live effect skip（§23.3a）。

#### `pixelSorter` — Pixel Sorter（AEPS2 Phase 1 コア）

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `sortingMode` | Sorting Mode | enum | `"simple"` | `simple` / `highlights` / `shadows` / `random` | ❌ |
| `thresholdLow` | Threshold Low | scalar | `0.25` | 0..1, step 0.01 | ✅ |
| `thresholdHigh` | Threshold High | scalar | `0.75` | 0..1, step 0.01 | ✅ |
| `angle` | Angle | scalar | `0` | 無制限（度）, step 1 | ✅ |
| `length` | Length | scalar | `256` | min 0, max 4096, step 1 | ✅ |
| `offset` | Offset | scalar | `0` | min 0, max 4096, step 1 | ✅ |
| `feather` | Feather | scalar | `0` | min 0, max 200, step 0.1 | ✅ |
| `sortBlocks` | Sort Blocks | scalar | `1` | min 1, max 64, step 1 | ✅ |

- `apply` → `{ kind: "raster" }`（恒等時は `null`）。`processPixels` で [`pixelSort.ts`](../src/runtime/pixelSort.ts) を呼ぶ。
- **輝度**: `L = 0.2126R + 0.7152G + 0.0722B`（0..1）。
- **しきい値マスク**: `thresholdLow ≤ L ≤ thresholdHigh` がソート対象。`feather` はマスク端を線形ソフト化（AEPS2 近似）。
- **Sorting Mode**: `simple`=輝度昇順 / `highlights`=明部のみソート / `shadows`=暗部のみソート / `random`=seeded shuffle（`seededRandom(phaseToSeed(frame))`・INV-1）。
- **Angle**: バッファを `-angle` 回転 → 水平スキャンラインでスパン検出・ソート → 逆回転（バイリニアサンプリング）。
- **Length / Offset**: スパン内で `offset` ピクセルスキップ後、最大 `length` ピクセルに制限（`length === 0` = スパン全体）。
- **Sort Blocks**: `sortBlocks > 1` でブロック代表色をソートしブロック全体に適用（AEPS2 Sorting Blocks 近似）。
- **恒等**: `thresholdLow >= thresholdHigh` かつ `feather === 0`、または実質変化なし → `null`。
- **カテゴリ**: `"スタイライズ"`。
- **非目標（Phase 1）**: Gradients 出力 / Random Length / Noise / Mirror / Constraint masks / Stretch / v3+ 機能。**AEPS2 100% 一致は非目標**。

#### `mosaic` — Mosaic（正確なブロック平均）

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `blockSize` | Block Size | scalar | `16` | `1..512`, step 1 | ✅ |

- **目的**: `blockSize × blockSize` ごとに RGBA を平均し、その平均色でブロック全体を塗る正確なブロックピクセレート。右端・下端の半端ブロックは実在ピクセルだけを平均する。
- **経路**: `executionPath: "raster"` / `previewBakeRequired: true` / `processPixels` あり。通常レイヤー・Raster調整レイヤー・export composite は同じ buffer→buffer 処理を呼ぶ。
- **恒等**: `blockSize <= 1` は `null`（filter なし）。`processPixels` は入力を clone して返す。
- **使い分け**: 編集中・HTML/live 配布では `mosaicLite`、正確なブロック平均・端ブロックの厳密さが必要な場合は `mosaic`。

#### `pixelSortLite` — Light Pixel Sort（GPU 近似・§27.3 additive）

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `angle` | Angle | scalar | `90` | 無制限（度）, step 1 | ✅ |
| `threshold` | Threshold | scalar | `0.5` | 0..1, step 0.01 | ✅ |
| `streakLength` | Streak Length | scalar | `64` | min 0, max 512, step 1 | ✅ |
| `stripWidth` | Strip Width | scalar | `8` | min 1, max 64, step 1 | ✅ |
| `intensity` | Intensity | scalar | `1` | 0..1, step 0.01 | ✅ |
| `phase` | Phase | scalar | `0` | 無制限（度）, step 1 | ✅ |

- `apply` → `{ kind: "svg", primitives }`（`streakLength === 0` または `intensity === 0` → `null`）。
- **経路**: SVG `feDisplacementMap` + 輝度マスク（`feColorMatrix luminanceToAlpha` + `feComposite in`）。**raster パイプライン非使用**。
- **アルゴリズム（近似）**: `angle` に垂直なストリップ分割 → ストリップごとに `seededRandom(phaseToSeed(phase)+i)` で変位 map（R/G）を生成 → 輝度 ≥ `threshold` の領域のみ streak 適用。真のピクセル並び替えは行わない（引き延ばしストリーク近似）。
- **調整レイヤー**: `backdrop-filter` 経路で **軽量**（full-comp CPU raster 不要）。
- **カテゴリ**: `"スタイライズ"`。
- **非目標**: 厳密 sort / Sort Blocks / highlights-shadows / `pixelSorter` とのピクセル一致。**AEPS2 100% 一致は非目標**。
- **既知差**: 引き延ばしベース近似のため [`pixelSorter`](pixelSorter) と見た目・ピクセルは一致しない（許容）。

#### `chromaSplit` — RGB Split / Chromatic Aberration

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `amount` | Amount | scalar | `4` | 0..100 (px), step 0.1 | ✅ |
| `angle` | Angle | scalar | `0` | 無制限（度）, step 1 | ✅ |
| `mode` | Mode | enum | `"rgb"` | `rgb` / `rb`（Green 固定） | ❌ |

- `apply` → `{ kind: "svg", primitives }`（`amount === 0` → `null`）。
- **技法**: RGB チャンネル分離 → 指定角度方向へオフセット（G は原点固定・R/B を対称 ±amount でシフト）→ `feBlend mode="screen"` で再合成。アルファは SourceGraphic を保持（透明レイヤー縁の色暴れ防止）。
- **angle と amount**: `angle` の方向ベクトル `(cos(angle°), sin(angle°))` へ `amount` px ぶんオフセット。モード `"rgb"` のとき R=+amount, G=原点, B=−amount（対称）。モード `"rb"` のとき R/B のみ ±amount、G は常に原点固定。
- **offset 算出**: `dx = amount · cos(angle°)`、`dy = amount · sin(angle°)`（純関数 `chromaOffsetPx`）。filter region クランプにより offset で矩形外へはみ出す分は欠け（AE 同挙動）。
- **カテゴリ**: `"スタイライズ"`。
- **非目標**: AE Lens Distortion との物理的色収差完全一致。**見た目的な RGB separation effect で十分**。
- **リスク**: 低。全 primitive（`feColorMatrix` / `feOffset` / `feBlend` / `feComposite`）は既存 effect で使用実績あり。

#### `gradientMap` — Gradient Map / Acid Colorize

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `preset` | Preset | enum | `"thermal"` | `thermal` / `acid` / `cyber` / `chrome` / `duotone` | ❌ |
| `colorA` | Color A | color | 黒 | — | ✅（duotone 暗部） |
| `colorB` | Color B | color | 白 | — | ✅（duotone 明部） |
| `phase` | Phase | scalar | `0` | 0..360, step 1 | ✅ |
| `amount` | Amount | scalar | `1` | 0..1, step 0.01 | ✅ |

- `apply` → `{ kind: "svg", primitives }`（`amount === 0` → `null`）。
- **技法**: `feColorMatrix type="saturate" values="0"` で輝度化 → `feComponentTransfer type="table"` の R/G/B `tableValues`（N=17 点サンプル）でグラデーション写像 → `feComposite operator="arithmetic"`（k2=`amount`, k3=`1-amount`）で原色とミックス。
- **preset**: `thermal` / `acid` / `cyber` / `chrome` は固定 stop 配列（`GRADIENT_MAP_PRESETS`）。`duotone` のみ `colorA`→`colorB` 線形。`phase` はサンプル位置を `phase/360` 分巡回シフト（ヒュー・サイクル）。
- **カテゴリ**: `"カラー補正"`。
- **経路**: live SVG（`executionPath: "live"`）。非 displacement・region 自動 150%。
- **非目標**: AE Gradient Map の全プリセット一致。preset 追加はデータのみ。

#### `posterize` — Posterize / 階調量子化

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `levels` | Levels | scalar | `6` | 2..32, step 1 | ✅ |

- `apply` → `{ kind: "svg", primitives }`（常時適用・identity なし。AE 準拠）。
- **技法**: `feComponentTransfer` の R/G/B に `type="discrete"` と等間隔 `tableValues`（純関数 `posterizeTable(levels)`: `0, 1/(L-1), …, 1`、`L<2` は `L=2` にクランプ）。アルファは触らない。
- **カテゴリ**: `"カラー補正"`。
- **経路**: live SVG（`executionPath: "live"`）。非 displacement・region 自動 150%。
- **非目標**: AE Posterize の gamma / チャンネル別 levels 一致。

#### `noiseGrain` — Noise Grain / ゼロ平均フィルムグレイン

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `amount` | Amount | scalar | `0.15` | 0..1, step 0.01 | ✅ |
| `size` | Size | scalar | `1` | 0.5..8, step 0.1 | ✅ |
| `animated` | Animated | bool | `false` | — | ❌ |
| `monochrome` | Monochrome | bool | `true` | — | ❌ |
| `seed` | Seed | scalar | `0` | 0..9999, step 1 | ❌ |

- `apply` → `{ kind: "svg", primitives }`（`amount === 0` → `null`）。
- **技法**: `feTurbulence type="fractalNoise" numOctaves="1"`（`baseFrequency = 1/max(0.5, size)`）→（`monochrome` のとき輝度平均化 `feColorMatrix`）→ `feComposite operator="arithmetic"`（`k2=amount, k3=1, k4=-0.5*amount`）で `SourceGraphic + amount*(noise-0.5)` を float 演算後にクランプ合成（ゼロ平均加算。`feComponentTransfer` での -0.5 オフセットは負値クランプで平均が狂うため不使用）。
- **決定論（INV-1）**: `seed = animated ? (baseSeed + frame) % 65536 : baseSeed`。`Math.random` 不使用。
- **カテゴリ**: `"スタイライズ"`。
- **経路**: live SVG（`executionPath: "live"`）。非 displacement・region 自動 150%。
- **既知の受け入れ条件**: `amount` を振っても平均輝度・重心が不動（ゼロ平均性）。実 Chrome での目視確認を推奨。
- **非目標**: フィルム粒子の彩度分布・感光乳剤シミュレーション一致。

#### `hyperGlow` — Hyper Glow / 閾値グロウ

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `threshold` | Threshold | scalar | `0.7` | 0..1, step 0.01 | ✅ |
| `radius` | Radius | scalar | `24` | 0..200, step 0.1 | ✅ |
| `intensity` | Intensity | scalar | `1.5` | 0..8, step 0.01 | ✅ |
| `tint` | Tint | color | 白 | — | ✅ |
| `quality` | Quality | scalar | `1` | 0.1..1, step 0.05 | ✅ |

- `apply` → `{ kind: "svg", primitives }`（`radius === 0` または `intensity === 0` → `null`）。
- **技法**: `feComponentTransfer type="linear"`（純関数 `thresholdTransfer(t)`: `slope=1/(1-t), intercept=-t/(1-t)`）で `threshold` 未満を 0 にクランプしつつ明部を強調 → `feGaussianBlur stdDeviation="radius*quality"` → `feComponentTransfer type="linear" slope="intensity"` で強度調整 →（`tint` が白以外のとき `feColorMatrix` でチャンネル別乗算）→ `feBlend mode="screen"` で元画像に加算合成。
- **滲み範囲**: 非 displacement のため filter region は矩形の自動 150%（§2.1 訂正）。グロウはレイヤー矩形の外へ ~25% まで滲む（150% を超える分のみクリップ）。
- **カテゴリ**: `"スタイライズ"`。
- **経路**: live SVG（`executionPath: "live"`）。
- **非目標**: 2 層ハロー（コア+外側ハロー分離）は初版で省略。AE Glow の全モード（Add/Screen/Composite 選択等）一致。

#### `scanlines` — Scanlines / CRT 走査線（§2.5: 生 PNG タイル + `feTile`）

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `lineHeight` | Line Height | scalar | `3` | 1..64 (px), step 1 | ✅ |
| `duty` | Duty | scalar | `0.5` | 0.05..0.95, step 0.01 | ✅ |
| `opacity` | Opacity | scalar | `0.35` | 0..1, step 0.01 | ✅ |
| `direction` | Direction | enum | `"horizontal"` | `horizontal` / `vertical` | ❌ |
| `phase` | Phase | scalar | `0` | 0..360, step 1 | ✅ |

- `apply` → `{ kind: "svg", primitives }`（`opacity === 0` → `null`）。
- **技法（§2.5・`<pattern>` は使わない）**: 1 タイル分の明暗バンドを `scanlineTilePng()` で**生 PNG に焼き**（horizontal は `16×lineHeight`、vertical はその転置。改定1参照）、`feImage`(生 PNG) → native `feTile` でフィルタグラフ内でネイティブに全域反復 → `feBlend mode="multiply"` で暗バンドを乗算 → `feComposite operator="in"` でソースアルファへクリップ。`phase` はタイル周期 `lineHeight` を法にロール方向（horizontal は y、vertical は x）へオフセット。
- **既知の罠（implement-visual-effect §7c）**: `<pattern>`/`<linearGradient>` 等を含むネスト SVG 文書を `feImage` に渡すと `backdrop-filter` 下で毎フレーム再ラスタライズされ致命的に重い（mosaicLite 実測 ~200 倍）。生 PNG を渡す `feImage` はこの罠に該当しない。
- **改定1（描画されないバグの修正・2026-07-13）**: 初版は変化しない軸（horizontal なら x）を **1px** に切り詰めていたが、実 Chrome で「エフェクトを追加しても何も起きない」ことが判明。原因は **1px 幅の `feImage` を `feTile` で反復し、さらにその要素が祖先の CSS `transform: scale(...)`（Preview パネルの "Fit" ズームは常時これ）で縮小表示される**と、GPU のテクスチャ縮小サンプリングが破綻し縞が一切描画されない（`feBlend mode="multiply"` が事実上 no-op 化し原色がそのまま透過して見える）こと。`mosaicGridSnapFilter` が同じ `feImage`+`feTile` 構成で `MOSAIC_TILE_MIN_DIM = 16` を最小タイル寸法にしているのと同じ理由でタイルの静的軸を **最低 16px** に拡張して解消（`SCANLINE_TILE_MIN_STATIC_DIM = 16`）。データ量はわずかに増えるが §2.5 の「生 PNG + feTile」自体の軽さは変わらない。
- **カテゴリ**: `"スタイライズ"`。
- **経路**: live SVG（`executionPath: "live"`）。非 displacement・region 自動 150%。
- **human 受け入れ**: 実 Chrome + CDP Tracing で `MainFrame.Draw` がエフェクト無しベースライン同等であることの確認は未実施（票の完了条件から Codex/Claude 自動宣言は除外）。改定1修正後の実際の描画は Playwright + 実 Chrome（`channel:"chrome"`）で確認済み（Preview の Fit ズーム相当の `transform:scale(0.4136)` 下で再現・修正）。
- **非目標**: 走査線の彩度分離（NTSC/PAL 色収差）・インターレース疑似。

### §27.3.1 ルックプリセットレシピ（散文のみ・WP-E・確定）

「VHS」「CRT」「Acid Poster」等の完成ルックは、**新 effect 型やスキーマ・UI プリセット機構を作らず**、既存 builtin エフェクトを**エフェクト配列に順番通り積むスタック定型**として提供する（親ドキュメント `doc/cloudplan/acid-digi-hyper-live-effects-plan.md` §5.2 由来）。ユーザーは Inspector から個々のエフェクトを手動で追加する（自動プリセットボタンは将来課題・非目標）。

- **VHS** = `chromaSplit(amount:3)` → `scanlines`（既定値程度） → `fastWave(amplitude:2, wavelength: 大きめ)` → `noiseGrain`（既定値程度）
  - 色収差でにじませ、走査線でブラウン管質感を出し、緩い横波でトラッキングの揺れを、最後にグレインでテープノイズを足す。
- **CRT** = `scanlines` → `opticsCompensation(reverse: true)` → `hyperGlow`（`intensity` 弱め）
  - 走査線 + レンズの樽型歪みを逆方向にかけてブラウン管の湾曲を模し、弱いグロウで蛍光体の滲みを足す。
  - `opticsCompensation` は displacement 系（`executionPath: "live"`・§2.2 の配線済み既存エフェクト）。`reverse:true` で凸型ではなく CRT 特有の内側湾曲になる（親 §3.4 の訂正どおり、非 displacement な `scanlines`/`hyperGlow` はレイヤー矩形の自動 150% 領域内で完結）。
- **Acid Poster** = `posterize(levels:4)` → `gradientMap(preset:"acid")` → `noiseGrain`（粗め・`size` を大きく）
  - 階調を 4 段に落として版画調にし、`acid` プリセットのグラデーションマップで毒々しい配色に置き換え、粗いグレインでポスター印刷のザラつきを足す。

**適用順序が重要**: エフェクト配列は上から下へ順に適用される（§27.1）。上記のレシピは既存エフェクトの `apply()` 出力をそのまま連結した想定順序であり、順序を入れ替えると見た目が変わる（例: `posterize` を `gradientMap` の後に置くと量子化前の連続グラデーションが失われる）。各エフェクトのパラメータ既定値は §27.3 の該当項目を参照。数値の微調整（`amount`/`intensity` 等の具体的な「弱め」「粗め」の値）はユーザーの好みによるため本レシピでは固定しない。

### §27.4 調整レイヤー（Adjustment Layer・Live / Raster 2 モード・確定 2026-06-20）

**意味（AE 準拠）**: 調整レイヤーは自身の content を描画せず、`effects[]` を**その下（背面・低 zOrder）に重なる全レイヤーの合成結果**に適用する。

**2 モード（`SceneObject.adjustmentMode`）**: 同じ「背面に effect を適用」という意味を、2 つの合成方式で提供する。「軽量に作りたい層（web / モーションデザイン）」と「精度重視層（AE 代替）」の双方を受け入れる戦略（§29）であり、技術的必然（mp4 = ピクセル列、`backdrop-filter` は最終ラスタライズで欠落）に基づく。

| モード | preview | web bundle export | mp4 / png export | 載せられる effect |
|---|---|---|---|---|
| **`"live"`**（既定・軽量） | `backdrop-filter`（同期・軽量） | `backdrop-filter`（live DOM・中間 raster 化ゼロ） | **オフDOM z 順コンポジタで背面 master に自動 raster 化**して見た目維持（重い・UI 明示） | `executionPath === "live"` のみ |
| **`"raster"`**（高精度） | comp 背面 capture → canvas（cache 前提） | bake（raster） | raster（高精度・確実） | live + raster 両方 |

**DOM 実装**:
- どちらも `isAdjustment === true` の host div は **content components を描画しない**（透明）。
- **Live**: effects を §27.1 と同じ順序付きフィルタ文字列で **`backdrop-filter`** に適用。`backdrop-filter` は描画順で背面に既に描かれた内容に作用＝ DomRenderer の z-index(=zOrder) 順描画と一致し、低 zOrder レイヤーのみ対象（AE「下のレイヤーに効く」と一致）。
- **Raster**: comp 背面（低 zOrder の合成結果）を canvas にキャプチャし、effect chain をピクセル処理して overlay する。既存の `runAdjustment*Pipeline`（displacement/raster 用）を全 effect へ一般化する。
- **作用範囲 = host div の矩形**（transform 適用後）。既定サイズ = comp 全体（width×height）。transform で縮小/移動すれば作用領域を限定できる（マスク相当は将来）。

**mp4/png export での Live 自動 raster 化（= 旧 §27.4 注記の "Phase 2" を実装・確定）**:
- mp4/webm/png は**ピクセルのフレーム列**で、最終ラスタライズ（foreignObject→canvas）は不可避。**通常レイヤーの CSS/SVG filter は最終ラスタライズでブラウザが一括適用される**（実証済み）が、**`backdrop-filter` だけは foreignObject ラスタ化で背面参照が欠落して消える**（実証済み）。
- よって export 経路（exporter / `compFrameCapture`）では、Live調整レイヤーを **オフDOM・ステートレスな z 順コンポジタ**（[`exportComposite.ts`](../src/runtime/exportComposite.ts) `compositeExportFrame`）で焼く（`auto_raster_mp4`）。毎フレーム、**live render DOM を一切破壊操作せず**（`visibility` トグル・フレーム間 raster 使い回しを行わない）、z 昇順に累積 master canvas を組み、調整レイヤー到達点で「累積済み背面 = master」に effect chain（raster machinery 流用）を適用する。これで mp4/png でも Live調整の見た目を維持しつつ、フレーム間状態混入によるちらつきが原理的に発生しない。
- かつての実装は DomRenderer 側で live DOM を毎フレーム書き換える bake（`forceAdjustmentRaster`）だったが、非同期競合で**ちらつき**を生んだため、合成責務を exporter のオフDOM コンポジタへ移した（DomRenderer は preview の live `backdrop-filter` 経路のみ担う）。
- 帰結: **Live調整の「中間 raster 化ゼロ」の利点は web bundle（live DOM 再生）でのみ成立**。mp4 では実質 Raster と同コスト。この棲み分けは好みでなく技術的必然。

**store / 作成 UI**:
- `addLiveAdjustmentLayer()` / `addRasterAdjustmentLayer()`（共に isAdjustment=true・content なし・full-comp サイズ・zOrder 最前。前者は adjustmentMode 省略=live、後者は `"raster"`）。`setAdjustmentMode(objId, mode)` でモード切替（各 1 undo・§17）。旧 `addAdjustmentLayer()` は `addLiveAdjustmentLayer()` の別名として残す。
- **後方互換**: 既存 `isAdjustment: true`（adjustmentMode 省略）→ **live 扱い**。挙動は改善方向（従来 mp4 で消えていた effect が auto_raster_mp4 で見た目維持される）。

**Inspector / Timeline バッジ**: モード（Live / Raster）をバッジ表示（§27.6 / §27.7）。**Live調整選択時、effect 追加メニューは `executionPath === "live"` のみ列挙**し、raster 専用 effect（pixelSorter / wave / ripple / turbulentDisplace）は**出さない**（§27.6）。

### §27.4.1 合成順序（Live / Raster / 通常レイヤーの積み重ね・確定 2026-06-20）

複数の調整レイヤー・raster effect・precomp が混在したときの合成順序を確定する（multi-pass flush の基盤・§19.5 Pipeline パネルの算出根拠）。

- **不変原則（確定）**: canvas にラスタライズされた結果は、それ以降（高 zOrder）のレイヤー・調整レイヤーから見て、**通常の背面ピクセルと完全に等価**。これにより合成は **zOrder 昇順の単一規則**に閉じる。
- **軸1 — precomp 境界 = non-collapse 固定**: precomp（§23・`Component.type="comp"`）は1枚に合成・確定してから親 comp が1レイヤーとして扱う（§23.5 の non-collapse と一貫）。調整レイヤーの作用範囲は **自 comp スコープ**（precomp 内の調整は内で閉じ、precomp 外の調整は precomp を1枚の背面レイヤーとして参照）。collapse（境界透過）は将来。
- **軸2 — Raster 出力 = 確定境界（キャッシュ境界）**: Raster調整 / raster effect / Live調整の export 時 auto_raster が canvas に焼いた結果は**確定境界**。その上の live（通常レイヤーの `filter` / Live調整の `backdrop-filter`）は**背面の確定ピクセルに作用するだけで、確定済み部分を再計算しない**。重い Raster を一度焼けば、上に live を足しても再ラスタライズは走らない。
- **ラスタに live をかけられるか（確定）**: **かけられる**。canvas はピクセルなので CSS filter / backdrop-filter が作用する。preview は backdrop-filter が描画順で背面（canvas overlay 含む）を自動参照。export は下記 multi-pass flush で「Raster を先に確定 → その上の Live を背面 capture」する。
- **export = オフDOM ステートレス z 順合成（INV-2・§27.9）**: 単一 root capture（調整/ blend 無しの高速経路）か、または **zOrder 昇順に累積 master canvas を組む**コンポジタ（[`exportComposite.ts`](../src/runtime/exportComposite.ts) `compositeExportFrame`）。通常レイヤーは単体キャプチャを master へ `globalCompositeOperation`（blendMode）で重ね、各 raster ポイント（Raster調整 / Live調整の auto_raster）では **master（=それ未満の確定ピクセル）に effect chain を適用**して master を更新する。**live render DOM は変更しない**（ステートレス・毎フレーム fresh）。precomp は内側 depth から先に確定（depth ≤ 4・§23.4）: **子 comp が調整 / CSS blend を含む場合は、その子を子自身の座標系で同じ z 順コンポジタに掛けて1枚の画像へ確定してから**（§23.3d export）親レイヤーとして置く（再帰）。子 comp が調整も blend も無ければ親の単一 capture に含めて焼く（3D 文脈保持の高速経路）。これで多段 raster・調整レイヤー・precomp ネストが preview と一致し、かつちらつき無く焼ける。

### §27.5 解決（resolve）と ResolvedScene（確定・INV-1/3）

`resolve()` でエフェクト param を**焼き込み**、レンダラには具体値のみ渡す（INV-3）。`ResolvedObject` を additive 拡張:

```ts
interface ResolvedEffect {
  type: string;
  enabled: boolean;
  props: Record<string, unknown>;   // frame 解決済み（AnimatedProp → 値）。component props と同経路
}
interface ResolvedObject {
  // ...既存...
  effects?: ResolvedEffect[];       // 省略 = なし。配列順 = 適用順
  isAdjustment?: boolean;
  adjustmentMode?: "live" | "raster"; // isAdjustment 時のみ。resolve で透過（省略 = "live"）。レンダラの経路分岐に使用（§27.4）
}
```

- 各 effect の props は `resolveComponent` と**同一のサンプリング経路**（[resolve.ts](../src/runtime/resolve.ts) の `sampleAny` + `applyExpr`）で解決する。`enabled` はそのまま透過（レンダラ側で無効を skip）。
- `disabled` エフェクトも軽量に resolve してよい（props 焼きは安価）。最適化として skip も可（出力不変）。
- **expression on effect props**: 同じ評価 seam を通せる（additive）。MVP の付与 UI は将来、**KF アニメ可**が今回のスコープ（§27.6）。
- INV-1: `apply` も resolve も純関数。DOM/乱数/時刻を持ち込まない。

### §27.6 Inspector UI（確定・現行 foldout に統合）

[InspectorPanel.tsx](../src/editor/panels/InspectorPanel.tsx) に **"Effects" foldout グループ**を追加（Transform / Components / Expression … と並ぶ §26.3 / 2026-06-19 の foldout 体系に統合）。

- 各 `EffectInstance` を**サブ foldout**として表示: ヘッダに `enabled` トグル（◉/◯）・エフェクト名（label）・並べ替え（▲▼, 配列順が適用順）・削除（×）。
- 本体に param 行を `ParamDescriptor.kind` 別 PropRow で描画（既存 ScrubNumber / ColorSwatch / enum / bool を流用）。animatable param は**ストップウォッチ ◇ で KF 化**（書き込みは command 経由・undo 可・§17）。
- ヘッダの **「+ エフェクトを追加」**メニュー: `globalPluginRegistry.listEffects()`（builtin Blur/Tint + plugin）から選択 → `addEffect(objId, type)`。
- **調整レイヤー**: Inspector にモードバッジ（**Live / Raster**）と切替（`setAdjustmentMode`）。ON のとき content components セクションは「調整レイヤー（描画なし）」と注記。**effect 追加メニューは Live調整のとき `executionPath === "live"` のみ列挙**する（Raster調整・通常レイヤーは全列挙）。Live調整選択時は「mp4/png 出力では自動 raster 化されます（重くなります）」を注記（§27.4 auto_raster_mp4）。

### §27.7 Timeline UI（確定・Inspector と SSoT 共有）

[TimelinePanel.tsx](../src/editor/panels/TimelinePanel.tsx) のレイヤーツリーに **Effects グループ**を追加（component props の animatable KF 行 §21 P1 と同じ機構）。

```
Layer
 ▸ Transform
 ▸ Effects
    ▸ Blur
        ◇ Blurriness
    ▸ Tint
        ◇ Map Black To / ◇ Map White To / ◇ Amount
```

- PropPath を `effects.<effectId>.<key>` で addressable に拡張（現状 string PropPath を拡張・§21 P1 で component props も同様に拡張済み）。KF ダイヤ・グラフエディタ（§22）・Ease パネル（§24）と**同じ KF 機構を共有**。
- 調整レイヤーはレイヤーバーに**モードバッジ（Live / Raster）**を表示（AE のアイコン相当）。

#### §27.7.1 ScrubNumber 数値表示（確定 2026-06-24）

Inspector / Timeline の数値フィールド（[ScrubNumber.tsx](../src/editor/ScrubNumber.tsx)）は **表示のみ**適応桁数 + 末尾ゼロ除去（[formatScrubDisplay.ts](../src/editor/formatScrubDisplay.ts)）を用いる。**内部値・KF 値・project.json は表示桁で丸めない**。

- 大きい値（例 `1920`）は短く、微小値（例 `0.003`）は有効桁が見えるまで桁を増やす（上限 4 桁）。
- ホバー `title` とクリック編集時はフル精度を表示する。
- Transform 等は `sampleVec3` / `sampleScalar` の **number を直接** ScrubNumber に渡す（表示用文字列への round-trip 禁止）。

### §27.8 ストア / コマンド / Undo（確定）

すべて既存の command 経路（before/after スナップショット・immutable 編集・§17）を通す。新規 store アクション（各 1 undo）:

- `addEffect(objId, type)` / `removeEffect(objId, effectId)` / `reorderEffect(objId, effectId, dir)` / `toggleEffect(objId, effectId)`。
- effect param の値/KF 書き込みは既存 `setPropByPath` / `setKeyframe` を **PropPath 拡張**（`effects.<id>.<key>`）で流用。スクラブ中の即時反映は §（2026-06-18）`previewOverride` 経路を流用。
- `addLiveAdjustmentLayer()` / `addRasterAdjustmentLayer()` / `setAdjustmentMode(objId, "live"|"raster")` / `toggleAdjustment(objId)`。旧 `addAdjustmentLayer()` は Live 版の別名として残す。
- 新規 `EffectInstance.id` は ULID（INV-6）。既定 props は `EffectDef.params[].default` から生成。

### §27.9 不変条件（INV 影響評価・確定）

INV-1〜8 を保持。新規 INV は不要。

- **INV-1**: `resolve()` / `EffectDef.apply` は純関数。effect param は resolve で焼く。
- **INV-2**: 通常レイヤー effects は preview/export 一致。**Live調整レイヤー** = preview / web bundle export 一致（`backdrop-filter`）、mp4/png export は comp 背面 capture で**自動 raster 化**し見た目維持（近似・§27.4）。**Raster調整レイヤー** = preview / 全 export を raster で一致（精度基準）。いずれも `resolve()` の scene 解決値は同一＝ **INV-2 本体（解決値一致）は維持**（モード差はレンダリング方式の差）。export は §27.4.1 合成順序の **multi-pass flush**（zOrder 昇順・各 raster ポイントで背面 capture→確定・precomp は内側 depth 先・depth ≤ 4）で多段 raster を確定する。
- **INV-3**: レンダラは `ResolvedScene`（焼き済み）のみ受け取る。`effects`/`isAdjustment`/`adjustmentMode` は ResolvedObject に載る。
- **INV-4**: optional 省略で既存 project.json byte 等価（§5.6-canon）。
- **INV-5/6**: 整数 frame / ULID（`EffectInstance.id`）。
- **INV-7**: effect 解決・registry・apply は `@mafter/runtime` 側。Inspector/Timeline UI はエディタ側。

### §27.10 影響ファイル / 作業分解（実装の入口・Cursor 委任用）

**スキーマ/登録**
- [src/core/schema.ts](../src/core/schema.ts): `EffectInstance` 追加、`SceneObject.effects?` / `isAdjustment?` 追加（§5.5b）。
- [src/runtime/plugin.ts](../src/runtime/plugin.ts): `EffectDef` / `EffectFilter` / `EffectRenderCtx` 確定（§27.2）。
- [src/runtime/pluginRegistry.ts](../src/runtime/pluginRegistry.ts): `registerEffect` / `getEffectDef` / `listEffects`。
- builtin 登録（[src/editor/store.ts](../src/editor/store.ts) 初期化）: `blur` / `tint` の `EffectDef`（§27.3）。新規 [src/runtime/builtinEffects.ts](../src/runtime/builtinEffects.ts) に `apply` 実体。

**解決/描画**
- [src/runtime/resolved.ts](../src/runtime/resolved.ts): `ResolvedEffect` + `ResolvedObject.effects?` / `isAdjustment?`（§27.5）。
- [src/runtime/resolve.ts](../src/runtime/resolve.ts): effect props 解決（`resolveComponent` と同経路）+ `isAdjustment` 透過。
- [src/runtime/DomRenderer.ts](../src/runtime/DomRenderer.ts): filter 文字列組み立て + svg `<filter>` defs 管理 + `fxSig` reconcile + 調整レイヤー（content skip + `backdrop-filter`）（§27.1/§27.4）。

**UI/ストア**
- [src/editor/panels/InspectorPanel.tsx](../src/editor/panels/InspectorPanel.tsx): Effects foldout（§27.6）。
- [src/editor/panels/TimelinePanel.tsx](../src/editor/panels/TimelinePanel.tsx): Effects グループ + PropPath 拡張（§27.7）。
- [src/editor/store.ts](../src/editor/store.ts) / [src/editor/commands.ts](../src/editor/commands.ts): §27.8 のアクション。

**テスト（INV 優先）**
- resolve: effect KF 補間・expression seam・`isAdjustment` 透過（純関数・INV-1）。
- 正準化 roundtrip: effects 付き project.json の byte 等価 + effects 未使用の既存 byte 等価（INV-4）。
- builtin `apply`: blur/tint のフィルタ片生成（境界 0/amount）。
- **実機（Playwright・必須）**: Blur/Tint の preview 反映、KF アニメ、export 一致（INV-2）、調整レイヤーの背面作用（preview）+ export 再現性検証。

### §27.11 受け入れ条件

1. 任意のオブジェクトに Inspector から Blur / Tint を追加・削除・並べ替え・有効/無効でき、preview に反映される。
2. effect param が KF 可能で、Inspector と Timeline の両方で編集でき、グラフ/Ease パネルと KF 機構を共有する。
3. effects 付きプロジェクトが save→load→zip→reimport で byte 等価。effects 未使用の既存プロジェクトは byte 等価のまま（回帰なし）。
4. 通常レイヤー effects が export（mp4/webm/png-seq）で preview と一致（INV-2）。
5. 調整レイヤーが preview で背面（低 zOrder）レイヤーにのみ作用する。export 再現性は検証し、結果（一致 or 許容済み既知差）を progress に記録。
6. typecheck / 既存テスト / build が緑。新規 INV テスト追加。

---

## §28 Preview Cache / RAM Preview（確定・Phase 1）

AE の RAM Preview + Disk Cache に相当する**プレビュー専用**のフレームキャッシュ。export / bundle player / `resolve()` は参照しない（INV-2 の scene 解決値の正は不変）。

### §28.1 目的・スコープ

| 項目 | 内容 |
|---|---|
| 対象 | エディタ preview のコンポジション全体フレーム（ラスタ PNG） |
| 非対象 | export 経路、bundle player、`project.json` / zip への混入 |
| Phase 1 範囲 | comp 全尺 `[0, duration)`。ワークエリア連動は Phase 2（§21 バックログ P2-14 依存） |
| §26.4.2 との関係 | `FrameRenderCache`（レイヤー単位）は別キー空間。将来同一 `TieredCacheStore`（L1/L2）を共有 |

### §28.2 ティアードストレージ

- **L1 メモリ**: LRU + 明示バイト計上。上限は `maxRamMB`（既定 256）。
- **L2 ディスク（Web）**: 専用 IndexedDB `mafter-effect-preview-cache`（プロジェクト FS `mafter-effect-fs` とは別 DB・INV-4 非汚染）。
- **L2 ディスク（将来デスクトップ）**: `cacheRootPath` 配下のファイル。同一 IF の `NodeCacheFs` で差し替え。
- **退避**: L1 合計 > 上限 → LRU を L2 へ書き出し → L1 から削除。

### §28.3 キャッシュキー（決定論・INV-1/5）

```
comp:{compId}:f{frame}:rev{projectRevision}:q{draft|precise}:proxy{full|half|quarter}:w{width}:h{height}
```

- `projectRevision`: store の編集カウンタ（undo/redo・KF 変更で自動無効化）。
- 品質・解像度プロキシ・comp 寸変更で自然ミス。

### §28.4 再生経路

| 状況 | 経路 |
|---|---|
| スクラブ（再生位置バー移動） | **初回は live render**。表示完了後そのフレームをバックグラウンドでキャッシュ（緑バー反映）。リアルタイム不可時は再訪問でキャッシュ表示可 |
| 編集ドラフト / `previewOverride` | **常に live render**（キャッシュ書き込みなし） |
| 再生中・リアルタイム可能 | live render + UI に `Realtime` 表示。バックグラウンド build は起動しない |
| 再生中・リアルタイム不可・ワークエリア build **完了後** | キャッシュ bitmap（overlay）表示。書き込み・background build は休止（読み取りのみ） |
| 再生中・リアルタイム不可・build **未完了** | **常に live render**（Caching OFF に近い）。bake（background / miss capture）は休止し、メインスレッド競合で再生を悪化させない。停止後に build を再開 |

**再生中の bake 休止（確定）**: キャッシュ ON でも再生中は書き込みキューを pause する（進行中の 1 フレーム capture は完了してよい）。停止時に pending があれば pump 再開、未開始なら `startBackgroundBuildIfNeeded`。ヒット/ミス混在によるフレームコストばらつきと、live + capture の二重仕事を避ける。

**リアルタイム判定**（`settings.enabled === true` のときのみ §28.5 参照）: 直近 live render 時間の中央値 < `(1000/fps) * 0.85`。加えて **`compRequiresPreviewBake(comp) === true`**（enabled effect/component の `previewBakeRequired` 集約。旧「raster effect 推論」の明示フラグ化）、または `resolutionProxy !== "full"` ではリアルタイム不可（強制 non-realtime → キャッシュ優先）。`settings.enabled === false` のときは常に live（§28.5）。

### §28.5 設定（project.json 非汚染・§19.3）

`localStorage`（将来 OS 設定）:

```ts
interface PreviewCacheSettings {
  enabled: boolean;       // 既定 false（2026-06）。HTML/bundle 向けは OFF 推奨
  maxRamMB: number;         // 既定 256
  enableDiskCache: boolean; // 既定 true
  cacheRootPath?: string;   // 将来デスクトップのみ
}
```

**Preview ツールバー UI**（§28.8 Phase 2 と整合）:

- **Caching** チェックボックス — `enabled` の ON/OFF。`localStorage` キー `mafter-preview-cache-v1` に永続化（project.json 非汚染）。
- OFF 時: scrub / playback / background cache を一切実行せず常に live 描画。進行中 build は即 abort。`Clear` / `maxRamMB` 入力は非表示。ステータス badge は **Cache OFF**。
- ON 時: 従来どおり §28.4 の RAM Preview ポリシー。

### §28.6 不変条件

- INV-1〜8 を保持。キャッシュは描画高速化のみで scene 解決値・export 出力の正に影響しない。
- キャッシュヒット表示はラスタ近似（§27 pixelSorter 既知差と同型の残差を許容）。スクラブ初回表示は live が正。
- offscreen capture は exporter と共有の `compFrameCapture` 経路（INV-2 整合）。

### §28.7 受け入れ条件（Phase 1）

1. 軽量 comp（solid のみ・draft）で `Realtime` 表示。バックグラウンド build 非起動。
2. 重い comp（raster effect 等）で `Caching` → 完了後キャッシュ再生がフレーム落ちしない。
3. 編集後 `projectRevision` 変化で古いキャッシュ未使用。
4. export 結果がキャッシュ導入前後で変わらない。

### §28.8 Phase 2（確定）

| 項目 | 内容 |
|---|---|
| タイムライン緑バー（ルーラー） | comp 全体キャッシュ済みフレームをルーラー上に緑表示（AE RAM Preview 相当） |
| タイムライン緑線（レイヤーバー直上） | per-layer raster キャッシュ済み区間を**各レイヤー行のバーのすぐ上**に緑線表示（§28.10）。precomp レイヤーは comp 単位キャッシュ済み区間を同様表示（§28.11） |
| precomp comp 単位ラスターキャッシュ | comp(A) がラスター化を含むとき、comp(A) を comp 単位でラスタ化しキー `precomp:{compId}:f{childFrame}:hash{contentHash}` でキャッシュ（**content hash 基準**・§28.11）。comp(B) 編集で無効化されない |
| ワークエリア | comp ごと localStorage（§19.3 非汚染）。`B`/`N` で in/out 設定、`[`/`]` でジャンプ。RAM build はワークエリア内のみ |
| `FrameRenderCache` | `TieredCacheStore` 共有・レイヤー raster キー `layer:{objectId}:f{localFrame}:hash{propsHash}`（**local frame 基準**・§28.10）。DomRenderer raster パイプラインに配線 |
| `NodeCacheFs` | 将来デスクトップ用 L2。Web では `cacheRootPath` 入力は無効（表示のみ） |
| 設定 UI | Caching ON/OFF チェックボックス・Cache クリア・maxRamMB・disk トグル（disk は将来） |

**ワークエリア既定**: `in=0`, `out=comp.duration`（全尺）。再生ループはワークエリア内（Preview + Timeline 共有 store 経由）。

### §28.10 per-layer raster キャッシュ（local frame 基準・確定 2026-06-20）

自己 capture（§27.12 displacement self-capture raster）は重い。per-layer raster キャッシュ（§26.4.2 `FrameRenderCache`）を **comp 絶対フレームではなく layer-local frame** でキーすることで、レイヤーをタイムライン上で **スライド（move）しても内容不変なら再ラスタしない**。

**キー**: `layer:{objectId}:f{localFrame}:hash{propsHash}`
- `localFrame = max(0, compFrame − obj.inPoint)`（INV-5: 整数 Frame）。
- `propsHash = fxSig`（frame で解決済みの effect type/enabled/props 署名）。
- comp 全体キャッシュ（§28.3 `comp:…:rev{projectRevision}…`）とは**別キー空間・別同一性モデル**。per-layer キーは `projectRevision` を含まない。

**スライド不変性**: move は `inPoint`/`outPoint` とレイヤーのキーフレームを同量シフトする（`shiftObjectKeyframes`）。よってある `localFrame` の「子 DOM 内容 + 解決済み effect 値」はスライド前後で不変 → 同 `localFrame` かつ同 `fxSig` で正しく HIT。transform は capture 後に matrix3d で別途適用するため焼かれる buffer に無関係。

**comp 全体との関係**: per-layer 優先・comp 全体は補助（共存）。comp 全体キャッシュはスライドで `projectRevision` が変わり無効化されるが、再構築時に per-layer HIT を使うため重い再ラスタは走らない。

**正準性 / INV**: INV-1/2/3/5 保持（キャッシュは描画高速化のみ、scene 解決値・export 出力に不影響）。HIT 条件が一致したときの buffer は常に正しく、最悪ケースは「ミス＝再レンダ」で誤ピクセルは生じない。

**緑線 UI**: per-layer キーを prefix `layer:{objectId}:` で列挙し `localFrame` を抽出、`compFrame = localFrame + obj.inPoint` で comp 位置へ写像して `[inPoint, outPoint)` 内をレイヤーバー直上に緑表示。`fxSig` ハッシュは照合しないため内容編集直後に旧ハッシュ entry が LRU 退避されるまで僅かに over-report しうる（indicator として best-effort）。

### §28.11 precomp comp 単位ラスターキャッシュ（content hash 基準・確定 2026-06-20）

§28.10（per-layer）の概念を **precomp（comp(A) を comp(B) にネスト）** へ拡張する。**comp(A) がラスター化を含む**とき、comp(A) を **comp 単位**でラスタ化（オフスクリーンで画像化）してキャッシュし、**comp(B) を編集しても comp(A) の内容が変わらなければ再ラスタしない**。

**前提（現状の制約）**: ネスト comp のプレビュー描画（`DomRenderer.renderNestedComp`）は §23 Phase 1 で、毎フレーム再解決し effect/raster を焼いていない。本節は対象 comp(A) を `compFrameCapture`（オフスクリーン `DomRenderer` + `captureElementToCanvas`）でラスタ化し、ネストコンテナへ `<img>` として描く経路を追加することで成立する。

**対象**: comp(A) が `compNeedsAutoPreviewCache(compA)`（§28.9: `previewBakeRequired` / displacement / `processPixels` のいずれか）を満たすときのみ comp 単位ラスタ化＆キャッシュする。非該当のネスト comp は従来の Phase 1 ライブ再解決経路を維持。

**キー**: `precomp:{compId}:f{childFrame}:hash{contentHash}`
- `childFrame = compChildFrame(parentFrame, inPoint, trimStart, duration)`（§23.2）。INV-5: 整数 Frame。
- `contentHash` = comp(A) の **正準内容ハッシュ**（`canonicalStringify` した comp(A) の objects/effects/参照アセット ID から導出。ネスト comp を含む場合は被参照 comp のハッシュも depth≤4 で畳み込む）。**`projectRevision` を含まない** → comp(B) の編集では無効化されない。
- comp 全体 RAM Preview キャッシュ（§28.3 `comp:…:rev{projectRevision}…`）とは**別キー空間・別同一性モデル**（共存）。

**comp(B) 編集での不変性**: comp(B) のみを編集しても comp(A) の objects/effects/参照アセットは不変 → `contentHash` 不変 → 同 `childFrame` で正しく HIT。comp(A) を編集すると `contentHash` が変わり該当フレームは再ラスタ。

**正準性 / INV**: INV-1/2/3/5 保持。`resolve()` は不変（INV-1/2 の対象である scene 解決値に不影響）。`precompRasterService` の rasterizer は **ライブプレビュー（PreviewPanel）と RAM Preview（comp 全体キャッシュ / `ramPreview`）の両キャプチャ経路に注入**され、同一 `compFrameCapture` パイプラインで comp(A) をラスタ化するため両者は一致する。最悪ケースは「ミス＝再ラスタ」で誤ピクセルは生じない。precomp を `<img>` 化することで内部の 3D 透視/ブレンドは raster 境界で確定する（§27.4.1「precomp は確定ラスター境界」と整合）。

> **follow-up（export/bundle 経路）**: ファイル export（`exporter.ts`）・bundle bake（`bundleBake.ts`）への rasterizer 注入は未配線（runtime→editor 依存を避けるため optional param で後日配線）。現状これらのネスト comp は §23 Phase-1（effect 非焼き込み）のままで、`resolve()` 出力は一致するがネスト comp 内 effect のピクセル一致は §27.3 export parity と同じく tracked follow-up。

**緑線 UI**: precomp キーを prefix `precomp:{compId}:` で列挙し `childFrame` を抽出、`parentFrame = childFrame − trimStart + inPoint` で comp(B) 位置へ写像し `[inPoint, outPoint)` 内を precomp レイヤーバー直上に緑表示（§28.10 の `LayerCacheLine` を共有）。`contentHash` は照合しないため §28.10 同様わずかに over-report しうる（best-effort）。

### §28.9 Auto Preview Cache（確定・2026-06）

重い comp の再生開始時に **session 限定**で Caching を自動 ON にする（`localStorage` 既定値は変更しない）。

**`compNeedsAutoPreviewCache(comp)`** — enabled effect/component を走査し、次のいずれかが真なら `true`:

1. `previewBakeRequired === true`（`compRequiresPreviewBake` と同型）
2. **full** displacement 系（`DISPLACEMENT_EFFECT_TYPES` − `FAST_DISPLACEMENT_EFFECT_TYPES`）。Fast* は live のため対象外（§27.12 改定3）
3. `processPixels` を持つ effect（raster チェーン）

**挙動**:

- 再生開始（`isPlaying` が false→true）かつ上記 `true` → session フラグ `autoCacheSession` を立て、実効 `PreviewCacheSettings.enabled = true`（RAM Preview ポリシー §28.4 を適用）。同時に `startBackgroundBuildIfNeeded()`。
- ユーザーが Caching を手動 OFF → `autoCacheSession` 解除。以降は手動設定を尊重。
- UI badge: **`Auto Cache`**（session 中のみ。手動 ON とは区別）。
- export / bundle player / `resolve()` 非参照（§28.1 と同様）。

**`shouldPreferCacheDisplay` 拡張**: `autoCacheSession === true` かつ `compNeedsAutoPreviewCache` のとき、サンプル数不足でもキャッシュ優先（L2 + displacement/bake 即時）。

### §27.12 Fast* Displacement 描画経路（確定・2026-06-21 改定3）

**preview / HTML bundle 共通** — live displacement 近似（`mosaicLite` / `fastWave` / `fastRipple` / `fastTurbulentDisplace`）は **raster 無し・フォールバック無しの live CSS filter 直適用**で描く。通常レイヤーは `filter: url(#fx)`、Live 調整レイヤーは `backdrop-filter: url(#fx)`。いずれも **filter region を layer bounds (0,0,w,h) にクランプ**する（§27.5 改定3）。browser export の `exportCompositeMode` では、`mosaicLite` のみ foreignObject capture の空白化を避けるため `rasterizeFilteredImage` 経由で同じ SVG filter を焼く。

> **改定理由（旧 改定2 = 全経路 raster を覆す）**: 旧版はかつての「未エフェクトの素矩形が右下に露出する」ドリフトを raster で隠していた。実機計測スパイク（`verify-fast-drift-spike.mjs`）で**真因は raster の有無ではなく filter region の pad 帯**と判明。`feImage` map は (0,0,w,h) 外で未定義 → pad 帯で channel≈0 → 定数 `−scale/2` 変位が内容を引きずる。raster は出力を W×H にクリップするので隠れていただけ。**region を (0,0,w,h) にクランプすると live CSS filter の centroid drift は raster と小数2桁まで一致**（3 effect × amount 0/50/100/155・turbulent 含む）。よって Fast* は raster コスト（per-frame capture + readback）無しで同等のドリフト無しを達成できる。フル版 displacement（`wave`/`ripple`/`turbulentDisplace`）は raster 維持。

**経路判定 SSOT**: [src/runtime/effectRouting.ts](../src/runtime/effectRouting.ts) の `needsSvgDisplaceCapture()` / `hasEnabledFullDisplacement()`。capture 対象は **full displacement のみ**（`mosaicLite` / Fast* は除外）。DomRenderer・Pipeline 分析の双方がこれを参照する。

| 条件 | 経路 |
|---|---|
| 通常レイヤー・**`mosaicLite` / Fast* のみ** | **live** `filter: url(#fx)`（region = (0,0,w,h)・raster 無し。browser export の `mosaicLite` のみ capture 前に焼く） |
| 通常レイヤー・**full displacement 含む** | `runDirectSvgDisplacePipeline`（self-capture raster） |
| Live 調整・**`mosaicLite` / Fast* のみ** | **live** `backdrop-filter: url(#fx)`（region = (0,0,w,h)・raster 無し） |
| Live 調整・**full displacement 含む** | `runAdjustmentSvgDisplacePipeline`（comp 背面 capture raster） |
| Raster 調整（`adjustmentMode="raster"`）| comp 背面 capture（§27.4・明示モード。Fast* も焼く） |
| Raster 調整 + live effect tokens（blur/tint/wipe）| comp 背面 capture（§27.4） |
| export `auto_raster_mp4`（Live 調整 + blur 等）| comp 背面 capture（§27.4） |
| displacement なし・Live 調整 + blur のみ | `backdrop-filter` 直適用（従来） |

> Fast* は raster を**強制しない**（live 完結）。Raster 調整は明示的ユーザーモードであり Fast の「フォールバック」ではない（焼く挙動を維持）。

- **export/bundle 妥当性**: export は foreignObject `captureElementToCanvas` 経由だが、既存の live SVG filter 効果 `linearWipe`/`angularWipe`/`pixelSortLite`（`feImage`/`feDisplacementMap` 使用）と Fast* は**同じ経路で raster 化せず export 済み**。`mosaicLite` は map 形状の実機検証で direct foreignObject capture が空白化したため、browser export の通常レイヤーだけ composite capture 前に `rasterizeFilteredImage` で焼く。bundle player は実ブラウザ compositor（preview と同条件）なので live のまま描く。Fast* export-parity は実機検証で固定（`verify-fast-export-parity.mjs`）。
- **`fastDisplaceDirect`**: **撤去**（live が無条件・opt-in 不要。`setPreviewRenderOptions` から削除）。
- **Pipeline UI**: 通常レイヤー + `mosaicLite` / Fast* のみ → `live`。full displacement / `mosaic` → `raster`（reason: 自己 capture・ドリフト回避 / buffer 処理）。
- **`compNeedsAutoPreviewCache`**: `mosaicLite` / fast-only comp は **Auto Cache 対象外**（live・per-frame raster ではない）。full displacement / `mosaic` comp は対象。
- **再生 UX 補助**: `holdLastRaster` — raster 完了まで前フレームの canvas を保持（full displacement / raster 調整向け）。`draftPlayback` モード（RAF バイパス等）は §28.9 と独立。

### §27.13 Live / Raster 調整レイヤー — 実装作業分解（確定 2026-06-20）

§27.4 の 2 モードを実装するための変更点（spec 確定済み・Cursor 主導）。**先に spec（本節）、次に実装**の順を守る。

**スキーマ / 型**
- [src/core/schema.ts](../src/core/schema.ts): `SceneObject.adjustmentMode?: "live" | "raster"`（§5.5b）。
- [src/runtime/plugin.ts](../src/runtime/plugin.ts): `EffectDef.executionPath: "live" | "raster"` を必須化（§27.2）。
- [src/runtime/resolved.ts](../src/runtime/resolved.ts): `ResolvedObject.adjustmentMode?`（§27.5）。
- [src/runtime/resolve.ts](../src/runtime/resolve.ts): `adjustmentMode` 透過（省略 = `"live"`）。
- [src/core/validate.ts](../src/core/validate.ts): `adjustmentMode` は `isAdjustment` 時のみ有効、不正値は warn。canonical 直列化（`"live"` 省略・`"raster"` のみ書く・§5.6-canon）。

**effect メタ**
- [src/runtime/builtinEffects.ts](../src/runtime/builtinEffects.ts) / [src/runtime/fastEffects.ts](../src/runtime/fastEffects.ts): 各 `EffectDef` に `executionPath` をリテラル付与（live: blur/tint/linearWipe/angularWipe/pixelSortLite/mosaicLite/fastWave/fastRipple/fastTurbulentDisplace、raster: wave/turbulentDisplace/ripple/pixelSorter/mosaic）。

**描画**
- [src/runtime/DomRenderer.ts](../src/runtime/DomRenderer.ts):
  - `adjustmentMode` で分岐。**Live** = `backdrop-filter`（preview / bundle）、export 時のみ comp 背面 capture 自動 raster 化（auto_raster_mp4・§27.4）。**Raster** = 常に comp 背面 capture。
  - 既存 `runAdjustment*Pipeline` を全 effect chain に一般化（backdrop-filter 系 blur/tint/wipe も raster 経路で焼けるように）。
  - `DISPLACEMENT_EFFECT_TYPES` のハードコードを registry の `executionPath` / メタ参照へ寄せる（リファクタ）。

**UI / store**
- [src/editor/store.ts](../src/editor/store.ts): `addLiveAdjustmentLayer` / `addRasterAdjustmentLayer` / `setAdjustmentMode`（旧 `addAdjustmentLayer` は live 別名）。
- [src/editor/panels/InspectorPanel.tsx](../src/editor/panels/InspectorPanel.tsx): モードバッジ / 切替 + effect ピッカーの `executionPath` フィルタ + mp4 自動 raster 注記（§27.6）。
- [src/editor/panels/TimelinePanel.tsx](../src/editor/panels/TimelinePanel.tsx): Live / Raster バッジ（§27.7）。

**テスト（Playwright parity・必須）**
- Live調整: preview と web bundle が一致。mp4 / png export で auto_raster_mp4 により effect が**消えず**に出る。
- Raster調整: preview / mp4 / png / bundle が一致（精度基準）。
- 後方互換: 既存 `isAdjustment: true` が live として読み込まれ、project.json は byte 等価。

---

## §29 Monetization / 無料・有料差別化（licensing 層・additive・確定）

> **位置づけ（厳守）**: これは **licensing / entitlement 層**であり、スキーマ・INV・アーキテクチャを一切変更しない。単一 `@mafter/runtime`（INV-7）上の **feature-flag** として実現し、free/paid を別コードベースにしない（INV-2 / INV-7 維持）。entitlement は **account / app レベル**に保持し、**`project.json` には入れない**（§19.3 と同原則：作品データはライセンス状態から独立）。**engine マイルストーン（M0–M5）のブロッカーにしない。**
>
> 内部依存の対応: web bundle export = §11.7（M5） / local headless・canonical render = M3.5（§16）・§11 export / native effect・高速化 = §14（WASM/Rust/Go） / 開放 Plugin API = §12 / 設定の project.json 非汚染原則 = §19.3。

### §29.1 競合前提（確定・重要）

無料で強力な incumbent が存在する（例: 日本の **AviUtl** = 無料・no-watermark・25 年分の無料スクリプト/エフェクト生態系・Windows / desktop / raster）。帰結:

- **価格の床は $0**（趣味層）。**watermark で casual は変換しない**。価格では奪えない。
- 勝ち筋は ① UX / cross-platform / web で incumbent に不満な層と新規を取る ② incumbent が**構造的に出せない領域**で課金する。

### §29.2 ゲート原則（確定）

- **watermark の本職 = 商用出力の封じ**。client 納品不可にして commercial ユーザを変換する。casual 変換は期待しない（AviUtl が床を握っているため）。
- 編集・基本 effect・性能（WASM, browser）・file/git アクセスは **無料**（funnel + 開放 Plugin API §12 のアイデンティティ + incumbent に客を流さない）。
- **web bundle（§11.7）は目玉だが live DOM ゆえ watermark 不能**（devtools で除去可）→ 無料では bundle export を無効化、有料で解放 + 商用ライセンス。
- 金は **incumbent 不在領域**に置く: web bundle / cross-platform（Mac / web。AviUtl は Windows 専用） / 商用ライセンス / B2B・埋め込み / automation。

### §29.3 tier 表（構造は確定・価格は参考値で契約ではない。個人 $12–19/月, Team $25–40/seat）

| capability | Free | 個人 | Team/Studio | B2B/Embedding |
|---|---|---|---|---|
| web エディタ / object model / 性能(WASM) / 基本 effect / community plugin / 実フォルダ(git, File System Access API) | ○ | ○ | ○ | ○ |
| raster 出力(MP4/GIF/連番, §11/M3) | watermark 付 | watermark なし・4K・長尺 | 同 | 同 |
| **web bundle export（§11.7/M5）** | ✕ | ○ + 商用ライセンス | ○ | 埋め込み/配信ライセンス |
| ローカル headless / canonical render（pixel 完全・batch, M3.5） | ✕ | ○(desktop) | ○ | ○ |
| desktop（オフライン / 実FS / native multicore） | ✕ | ○ | ○ | ○ |
| 重い native effect（compute-gated, §14） | ✕ | ○ | ○ | ○ |
| premium effect / easing パック | ✕ | 一部同梱 + 購入 | 同 | 同 |
| team seat / 共有・コラボ | ✕ | ✕ | ○ | ○ |
| automation / API / プログラム的レンダー | ✕ | ✕ | △ | ○ |
| bundle player 商用埋め込み（広告/サイト/サイネージ at scale） | ✕ | △ | △ | ○（本命収益） |
| plugin marketplace | 出品/購入可 | 同 | 同 | 手数料 % が横断収益 |

### §29.4 effect 課金（確定）

カテゴリごとの paywall は禁止（§12 開放 API + JP の無料スクリプト文化に二重に負ける）。effect の課金は次の **3 経路のみ**:

1. **compute-gated な重い effect**（native / headless 能力で自然にゲート, §14 / M3.5）
2. **curated premium パック**
3. **marketplace 手数料**

基本 effect は無料。

### §29.5 ゲートしてはいけないもの（確定）

編集能力・object model・基本 effect・性能（WASM）・file/git（実FS・git アクセス）・決定論。funnel と「開放型・web-native・dev フレンドリー」アイデンティティ（§1 / §12）を毀損し、また incumbent に客を流すため。**実FS / git は Free に含める。**

### §29.6 COGS 規律（確定）

定額 × 無制限のクラウドレンダー禁止。クラウド提供時は使用量課金。ローカル headless（desktop 内, M3.5 / §14）は原価ゼロで安全。

### §29.7 段階化（確定）

- **ローンチ**: 無料 web（性能フル・watermark raster） + 有料 web（watermark なし・bundle export §11.7・4K・商用ライセンス）。
- **後続**: desktop（ローカル headless / 実FS / オフライン, M3.5）・native 高速化（§14）・B2B / 埋め込みライセンス・marketplace。

### §29.8 要判断（未確定・要ユーザ確認 — 推奨にマーク）

> 推奨案は §29.3 tier 表 / §29.5 に既に反映済み。確定化はユーザ承認待ち。

1. **実FS / git を Free に含めるか** — 推奨: **含める**（dev 客層獲得・§29.5）。
2. **web bundle（§11.7）を個人 tier で解放するか B2B 限定か** — 推奨: **個人 tier で解放 + 商用ライセンス**（§29.3 で個人 ○ として反映済み）。B2B は at-scale 埋め込み/配信ライセンスで上乗せ。
3. **premium パックの個人 tier 同梱範囲** — 推奨: **一部同梱 + 残りは購入**（§29.3 反映済み。同梱量は別途確定）。

---

## §30 Null Layer（確定・additive）

AE の Null Object 相当。Transform 専用の制御レイヤー。最終出力（preview / export / bundle player）に**ピクセルを出さない**。parent チェーンによる transform 継承のみが目的。

### §30.1 スキーマ（§5 additive）

```ts
interface SceneObject {
  // ...既存フィールド...
  isNull?: boolean;   // true = Null レイヤー。false/未設定 → キー省略（INV-4 byte 等価）
}
```

- **相互排他**: `isNull === true` と `isAdjustment === true` は同時不可。load 時 warn + store 作成時ガード。
  - **`toggleAdjustment(objId)` ガード**: 対象が `isNull` なら **no-op**（Null を調整レイヤーに変えない）。排他をストア操作でも担保する（2026-06 補記）。
- **content**: Null 作成時 `components: []` 固定。component を持たない。
- **Effects**: 許可（AE 同様。可視コンテンツがないため実質 noop。UI 制限なし）。

### §30.2 挙動（AE 準拠）

| 項目 | 挙動 |
|---|---|
| 描画 | DomRenderer / export は DOM entry を作らない（INV-2 維持） |
| Transform | 既存 `transform` / `opacity` / KF / expression をそのまま使用 |
| parenting | 既存 `parent` フィールド。`resolve()` の `worldOf` は **isNull も含め** parent チェーンを畳む（§6.3） |
| 可視性 | `enabled && inPoint <= frame < outPoint` のとき ResolvedScene に載るが DOM はスキップ |
| Preview | **editor のみ**: 有効な Null すべてに 100×100px 十字ワイヤーフレーム（§25 overlay・export 非経路） |

### §30.3 既定作成（store `addNullLayer`）

- 名前: comp 内既存 Null 数に応じ `Null` / `Null 2` …
- `position = (width/2, height/2, 0)`（comp 中心）
- `anchor = (0,0,0)`, `scale = (1,1,1)`, `opacity = 1`
- `zOrder`: 既存 `nextZOrder` 規約

### §30.4 グリフ分解との関係

- **Phase 1**: §26.5.1a `keyframesOnNull` は空 text コンテナのまま（既存分解結果を壊さない）。
- **Phase 2（将来）**: 分解出力を `isNull: true` コンテナへ移行可。

### §30.5 受け入れ条件（Phase 1）

- [ ] `+ Null` で comp 中心に editor ワイヤーフレーム表示
- [ ] Null を親にした子の worldTransform が AE 同型（parent チェーン）
- [ ] export / bundle で Null 追加前後の可視ピクセル一致
- [ ] 既存 project.json byte 等価 roundtrip
- [ ] `isNull + isAdjustment` 同時 → validate warn

### §30.6 実装タッチポイント

- [src/core/schema.ts](../src/core/schema.ts): `SceneObject.isNull?`
- [src/runtime/resolved.ts](../src/runtime/resolved.ts): `ResolvedObject.isNull?`
- [src/runtime/resolve.ts](../src/runtime/resolve.ts): components 空化 + フラグ透過
- [src/runtime/DomRenderer.ts](../src/runtime/DomRenderer.ts): isNull → DOM スキップ
- [src/editor/store.ts](../src/editor/store.ts): `addNullLayer`
- [src/editor/panels/TimelinePanel.tsx](../src/editor/panels/TimelinePanel.tsx) / Inspector / PreviewViewerOverlay

---

## §31 Solid レイヤー編集（色）— UI 層・additive

`solid` component は `color: AnimatedProp<RGBA>` / `size: AnimatedProp<vec3>` を持つ（§5.5 表）が、編集 UI が無く色を変更できなかった（Inspector は `text` 以外の component を `null` 描画し、Timeline は展開時の KF 行でしか色を出さない）。本節は **solid の色をインスペクターとタイムラインの両方から選択できる**ようにする。**スキーマ不変**（既存 `color` プロパティを既存 UI 部品で編集するだけ）。

### §31.1 Inspector — Solid セクション（確定）

選択オブジェクトが `solid` component を持つとき、Inspector（[InspectorPanel.tsx](../src/editor/panels/InspectorPanel.tsx)）に **"Solid" セクション**を表示する（現状 `comp.type !== "text"` で握り潰しているのを solid 対応に拡張）。

| フィールド | UI | KF |
|---|---|---|
| Fill（`color`） | カラースウォッチ + ピッカー（§26.3 と同一 `ColorSwatch`） | ◇ |

- `color` は **animatable**。既存 `ColorSwatch` + ストップウォッチ（◇）で keyframe 化でき、書き込みは `updateObject` / `setKeyframe` 経由（undo 可・§17）、`components[i].props.color` を更新する（Text の Fill 行と同型）。
- `size` 等の他プロパティは本節スコープ外（既存どおり Timeline の数値編集に委ねる。将来拡張可）。

### §31.2 Timeline — レイヤー行のカラースウォッチ（確定）

solid レイヤーの **Timeline 行ラベル列**（[TimelinePanel.tsx](../src/editor/panels/TimelinePanel.tsx) の `LayerRow`）に、現在色を示す**小さなスウォッチチップ**を表示する。クリックすると `<input type="color">` のネイティブピッカーが開き、選択で `color` を更新する。

- スウォッチは **現フレームでサンプルした `color`** を表示（KF があればその時点の補間色。`sampleAny`）。
- 確定書き込みは `onUpdate(obj.id, { components })` 経由（undo 可）。`color` に KF があれば現フレームへ `setKeyframe`、無ければ base `value` を更新する（Inspector と同じ分岐）。
- 表示条件: `obj.components` に `type === "solid"` があるレイヤーのみ。`isNull` / `isAdjustment` には出さない。
- アルファ編集は Inspector の `ColorSwatch` に委ねる（Timeline チップは RGB のクイック変更＝AE のレイヤー色相当の手早さを優先）。

### §31.3 受け入れ条件

- [ ] solid を選択 → Inspector に "Solid" セクションと Fill スウォッチが出て色を変更できる（undo 可）
- [ ] Timeline の solid 行ラベルに色チップが出て、クリック→ピッカーで色を変更できる（undo 可）
- [ ] `color` の◇でキーフレーム化し、Inspector / Timeline 双方が現フレーム色を反映する
- [ ] 既存 project.json byte 等価 roundtrip（スキーマ・直列化不変）
- [ ] text / image / null / adjustment レイヤーにはチップ・Solid セクションが出ない（回帰なし）

### §31.4 実装タッチポイント

- [src/editor/panels/InspectorPanel.tsx](../src/editor/panels/InspectorPanel.tsx): `solid` 用 content セクション（`SolidComponentFields`）
- [src/editor/panels/TimelinePanel.tsx](../src/editor/panels/TimelinePanel.tsx): `LayerRow` ラベル列にスウォッチチップ
- [src/editor/ColorSwatch.tsx](../src/editor/ColorSwatch.tsx): 既存部品を再利用（新規部品なし）
- [src/editor/fontList.ts](../src/editor/fontList.ts): §26.3.1 Font 候補リスト（新規・Inspector 参照）
