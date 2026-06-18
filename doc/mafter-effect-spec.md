# Mafter Effect — MVP 仕様書 v0.11

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
 ├ assets/                 # 画像・動画・フォント等のバイナリ
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
  name: string;                  // 表示専用
  parent: ObjectId | null;       // transform 継承のみ。描画順とは無関係
  zOrder: number;                // comp 内グローバル描画順。fractional（小→奥）。§5.4-note 参照
  enabled: boolean;
  inPoint: Frame;                // この comp 内での表示開始
  outPoint: Frame;               // 表示終了
  transform: Transform;
  opacity: AnimatedProp<number>; // 0..1, 全 Object 共通
  components: Component[];
}
```

> **§5.4-note（Object 格納形式 — 確定）**: オブジェクトは **flat list** で保持し、ツリーは `parent` 参照から導出する（`children[]` は持たない）。理由 = reparent が 1 フィールド変更で済み Git diff が最小、LLM 編集も局所化、かつ **描画順(`zOrder`) と transform 親(`parent`) を直交**させられる（AE 同様、子を親の裏に置ける）。
> - `parent` は **transform 継承のみ**。`zOrder` は comp 内グローバル描画順で **fractional index**（1.0 と 2.0 の間に挿す＝1.5、全体再採番不要、たまに rebalance）。
> - `project.json` 直列化時は `objects` を **id 昇順でソート**し配列順に意味を持たせない → 追加/削除/reparent/並べ替えのどれでも「変わったオブジェクトの行だけ」が diff に出る（§5.6 正準化）。
> - 整合性は **load 時 1 パス検証**: 存在しない `parent` id → root 扱い + warn、循環（A→B→A）→ プロジェクトエラー。
> - DomRenderer は **ネストしない**。`resolve()` が parent チェーンを畳んで各オブジェクトに **world transform を焼き込み**、全オブジェクトを 1 つの root の**兄弟**として `transform: matrix3d(world)` + per-object `opacity` で並べ、`zOrder` を DOM/z-index 順、root に `preserve-3d` をかける。これで zOrder⊥parent / opacity 非継承（CSS opacity は子に合成されない）/ 3D は z 深度でブラウザが合成、が同時に成立する。transform 数学が全部 `resolve()`（純関数）に寄るので §14 の WASM 化にも有利。これはレンダラ実装詳細でありデータは無傷（INV-3）。

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
```

**MVP built-in component types:**

| type        | 役割                              | 主な params                          |
|-------------|-----------------------------------|--------------------------------------|
| `solid`     | 単色塗り（AE Solid 相当）          | `color: RGBA`, `size: vec2`          |
| `text`      | テキスト（DOM/SVG レンダリング, §26） | `text`, `font`, `size`, `color`, `align`, `tracking`, `leading`, `weight`, `italic`, `strokeColor`, `strokeWidth` |
| `image`     | 画像アセット表示                   | `asset: AssetId`, `fit`              |
| `shape`     | rect / ellipse（最小図形）          | `kind`, `fill: RGBA`, `radius`, `size: vec2` |
| `html`      | HTML Composition（Model A, §7）     | `compId: CompId`, + comp が宣言した params |
| `video`     | 動画アセット（best-effort, §11.4）   | `asset: AssetId`, `fit`, `trimStart: Frame` |
| `audio`     | 音声アセット（最小, §11.5）          | `asset: AssetId`, `gain`, `trimStart: Frame` |
| `camera`    | カメラ（comp に最大 1 つ active）   | `fov`, （Transform で位置/向き）      |

plugin はここに新しい type を追加できる（§12）。

> **決定（覆し可）**: `video` と `audio` を MVP に入れた（音楽 MV 用途を想定）。ただし `video` は決定論シーク制約があり browser は best-effort（§11.4）。`audio` は最小（gain 静的・mix なし・export で mux、§11.5）。`compRef`（comp ネスト＝precomp）は曖昧さが大きいため **MVP から外し §16 将来**へ（プリコンポは時間マッピング/collapse 仕様が要るため）。

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
  background?: RGBA;
}

// timeline comp: objects を持つ
interface TimelineComposition extends CompositionMeta {
  kind: "timeline";
  objects: SceneObject[];   // flat list, id 昇順で直列化。ツリーは parent から導出（§5.4-note）
  activeCamera?: ObjectId;
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
}

interface AssetEntry {
  id: AssetId;
  path: string;                  // assets/ 下の相対パス
  kind: "image" | "video" | "font" | "audio" | "other";
  meta?: Record<string, unknown>;
}

interface PluginRef { id: string; version: string; enabled: boolean; }
```

### §5.6-canon 正準シリアライズ（確定・INV-4 の基準）

`project.json` は **一意なバイト列**に直列化する。実装非依存（§14 の Rust/WASM も同一バイトを再現でき、差分テストで検証可能）。2 段階で定義する。

**(a) データ正規化（順序・直列化前）**
- **集合配列は id 昇順にソート**: `objects` / `assets` / `compositions` / `pluginRefs`。配列順に意味を持たせない（描画順は `zOrder` が持つ、§5.4-note）。
- **意味順を持つ配列は並べ替えない**: `components`（重なり順が意味）、`effects`（適用順が意味・§5.5b/§27）、各 `AnimatedProp.keyframes`（`frame` 昇順を維持）。
  - `SceneObject.effects` / `SceneObject.isAdjustment` は **optional**。`effects` は空（無し）なら**キーごと省略**、`isAdjustment` は `false` なら省略する（(b) の optional 規則）。これによりエフェクト未使用の既存 project.json は **byte 等価のまま**（INV-4・回帰なし）。`EffectInstance.id` は ULID（INV-6）、`props` は component props と同じく正準化対象。
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
- MVP の DOM レンダラは root に `transform-style: preserve-3d`。3D の前後関係はブラウザが z 深度で合成。
- **active camera あり**: `perspective = (compHeight/2) / tan(fov/2)` [px] を root に設定し、camera の world 変換の**逆**をシーン root に前掛けする（= ビュー変換）。`perspective-origin` は comp 中央。
- **active camera なし**: `perspective` を設定しない（**正射影**）。z は描画順の tie-break と将来の被写界深度のためだけに保持され、見た目の遠近は付かない。
- Blender camera import（将来）は、この `camera` オブジェクトの keyframe を埋めるだけで済む（IO plugin、§12/§16）。

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
  format: "webm" | "mp4" | "png-seq" | "gif";
  alpha: boolean;                // 透過（webm/vp9 alpha or png-seq）
}
```

- **成功条件はここ（M3）で満たされる**: browser best-effort で 5 秒尺を webm/mp4/連番に書き出せれば「アーティストが公開できる」が成立する。
- **音声の mux（確定）**: 映像フレームを決定論ステップで描き終えた後、`audio` レイヤ群を各自の `trimStart`/タイムライン配置と `gain` に従って **ffmpeg で mux**（png-seq/webm/mp4 へ）。音声はフレームステップせず元ソースをオフセット合成する。

### §11.4 video コンポーネント（MVP / best-effort）

- `video` は `asset(video)` を参照し、表示フレームのソース時刻 = `(frame - host.inPoint)/fps + trimStart/fps`。
- 描画は `<video>` を対象時刻に **seek** して DomRenderer の対象 div に合成。ブラウザの seek はフレーム精度が不安定なので **`requestVideoFrameCallback` で実フレーム到達を待ち、許容誤差を明記**（browser export は best-effort）。
- **canonical な完全一致は headless 経路（§16, M3.5）で担保**。INV-2 は「ソース時刻のマッピング＝決定論」を満たし、実デコードフレームの差はラスタ忠実度の範囲とする。
- 音声トラック付き video の音は MVP では鳴らさない（`audio` レイヤで別途）。フレーム同期音声は §16。

### §11.5 audio コンポーネント（MVP / 最小）

- `audio` は `asset(audio)` + `gain`（**静的, 0..1**）+ `trimStart`。タイムライン配置（inPoint/outPoint）で再生区間が決まる。
- **preview**: playhead に追従して `AudioContext` で再生（スクラブ時は鳴らさなくてよい）。
- **export**: §11.2 のとおり mux。
- mixing graph / エフェクト / **keyframed gain** / 波形表示は §16 将来。

### §11.6 フォント（確定）

- `assets/` のフォントは load 時に **`FontFace` API で登録**（`document.fonts.add`）。`text` component の `font` はその family 名で参照。
- **export 時の埋め込み**: browser の `<foreignObject>` ラスタ化はフォントの inline（base64 `@font-face`）が要る。headless 経路は実フォントが効くので不要。

### §11.7 Web Bundle Export（実行可能 web バンドル）

MP4 とは別の出力経路。作品を**ブラウザで実時間再生する DOM/JS バンドル**として書き出す。プレイヤーは `@mafter/runtime`（INV-7）+ 音声マスタークロックの薄いラッパで、`resolve()` の純粋性（INV-1）により frame drop 時も「現在 frame に resolve でワープ」するだけで状態が壊れない（INV-8）。

- **2 出力モード**:
  - **Single-file**（全 `live`・vector/text/CSS の軽量作品専用）: プレイヤー JS + 正準 JCS データ + 軽量アセットを **DataURL inline した 1 枚の静的 HTML**。Lottie 上位互換のスイートスポット。**ベイク動画を inline すると「軽量」が即死する**ため、`bake` レイヤがある作品では選べない。
  - **Folder bundle**（ベイク動画/重アセット有り）: `dist/` に `index.html` + プレイヤー + データ + メディアを出力。**全アセットは相対パス `./...`（Vite `base: './'`）** にしてサブディレクトリ/ローカル double-click でも動くポータビリティを保証。
- **bake 経路**: `exportStrategy: 'bake'` のレイヤ（将来の WebGL/3D/重 plugin 等）は §11.4 / M3.5 の headless 機構で**そのレイヤだけ**フレーム書き出しして MP4/WebP 化し、`video` アセットとして同 `worldTransform`/`zOrder` で player に差し戻す。重ライティングをテクスチャに焼くゲームエンジン的割り切り。
- **alpha 動画の制約（要注意）**: ベイクレイヤを live シーンに透過合成するには alpha 動画が要るが、Web の alpha video は VP9 alpha（Chrome/FF）止まりで Safari が弱い、HEVC-alpha は Safari 専用。→ **v1 は不透明ベイクのみ**を保証。透過が要る軽い要素は WebP/PNG 連番、本格的な透過は color+matte 2 ストリーム（§16 将来）。
- **再生クロック**: マスタークロック = `AudioContext.currentTime`（音声があれば）。`currentFrame = round(t * fps)` を毎 rAF で算出し `resolve(comp, currentFrame)` を描く。低スペックでは中間 frame を描かずスキップ＝音ズレしない（INV-8）。音声が無ければ rAF 経過時間をクロックにする。
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
| video（best-effort）/ audio（最小・gain 静的）/ font | **MVP (M3)** |
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
| Timeline Tier B（ラベル色 / solo / lock / shy / parent ドロップダウン UI, §21.0） | 将来（優先度高） |
| Timeline Tier C（ブレンドモード / トラックマット, §21.0） | 将来（優先度高） |
| Timeline Tier D（モーションブラー / フレームブレンド / 3D レイヤー / 調整レイヤー, §21.0） | 将来 |
| タイムコード ドロップフレーム表示（0;00;00;00, §21.1） | 将来 |
| Model B（DOM 内省で要素を Object 化） | 将来 |
| WebGL/WebGPU レンダラ / 実 3D（深度・ライティング・物理カメラ） | 将来 |
| Blender Camera / Depth Import（IO plugin） | 将来 |
| Particle / Advanced Effects / 分散レンダリング / AI 編集支援 | 将来 |
| comp/plugin JS のハードサンドボックス / CSP | 将来（セキュリティ硬化） |
| keyframed gain / audio mixing / 波形表示 / video 内蔵音声同期 | 将来 |
| OPFS アセット格納 / time remap / per-axis easing・expression | 将来 |
| グラフエディタ Phase 2（per-axis 値カーブ, §22.0） | 将来（additive スキーマ） |
| グラフエディタ Phase 3（空間モーションパス / 速度グラフ, §22.0） | 将来（additive スキーマ + resolve 拡張） |

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
- **パネルは ID で引ける自己完結ユニット**（`preview` / `timeline` / `project`(assets) / `inspector` / `log` …）。各パネルは自分の状態を持ち、他パネルと直接結合しない（共有は `@mafter/runtime` / エディタストア経由）。
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

---

## §20. Project パネル / コンポジション管理（UI 層・MVP 後の UX 拡張）

> §19 の続き。「AE の Project パネル概念」と「アクティブコンポジションの明示」を規定する。エンジン SSoT（§5 スキーマ）は変更しない — `Project.compositions` / `rootComposition` / `currentCompId`(エディタ状態) は既存。本節は **UI 層と store 操作の規約**であり、データモデルに新フィールドを足さない。

### §20.1 Project パネル（= AE の Project パネル相当）

`project` パネル（§19.1 の左パネル）は **プロジェクトに属する全アイテムの一覧**を表示する。AE 同様、ここは「素材とコンポの倉庫」であり、**レイヤー一覧ではない**（レイヤーは Timeline パネルが持つ。§20.4）。

表示する 2 系統:

- **Compositions** — `project.compositions` の全要素（`timeline` / `html` 両 kind）。
  - 各行は `name` ＋ kind バッジ ＋ `width×height @ fps` ＋ `duration`。
  - **timeline comp** の行クリック = そのコンポを**アクティブにする**（`setCurrentComp(id)`）。アクティブ行はハイライトする。
  - **html comp** の行クリック = §7 の `html` コンポーネントとして**現アクティブ comp のタイムラインに配置**する（既存 `addHtmlInstance`）。html comp は「タイムラインを持たない素材（footage/precomp 相当）」であり、それ単体を編集対象として開かない（§20.3）。
- **Footage / Assets** — `project.assets`（audio / image / video / font / other）。クリックで該当レイヤーをアクティブ comp に追加できる（種別が対応するもの。MVP は audio）。

操作:
- **`+ Composition`**: 新規 timeline comp を作成（既定 1920×1080 @30fps / 5s, name `Comp N`）して即アクティブにする。
- **`+ HTML Comp`**: 既存どおり html comp を作成（FS スターター生成）。
- **コンポのリネーム / 削除**を提供する（§20.2）。

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

### §20.3 アクティブコンポジションの明示（確定）

「いま編集している comp」を常に視覚的に明示する:

- **Preview パネル上部のコンポタブ**: 全 **timeline comp** をタブとして並べる（AE のコンポビューア相当）。アクティブタブをハイライトし、`name` を表示。タブクリックで `setCurrentComp`。
- Preview / Timeline のヘッダにアクティブ comp の `name` と `width×height @ fps` を表示する。
- Project パネルのアクティブ comp 行をハイライトする。

html comp はタブに出さない（編集対象の timeline ではないため。§20.1）。

### §20.4 パネル責務の分離（確定・§19.2 の明確化）

| パネル | 責務 |
|---|---|
| `project` | プロジェクトに属する **comp 一覧 + 素材一覧 + plugins**（倉庫）。レイヤーは持たない。 |
| `timeline` | **アクティブ comp のレイヤー一覧**（`objects`）+ スクラバ + KF + レイヤー追加/削除/可視性。 |
| `preview` | アクティブ comp の描画 + コンポタブ + 再生コントロール。 |
| `inspector` | 選択レイヤーのプロパティ。 |

レイヤーの追加（solid/text 等）と削除は **Timeline パネル**で行う（AE と同じく「コンポを開いている状態でレイヤーを足す」モデル）。Project パネルからレイヤー一覧を撤去する。

---

## §21. Timeline パネル / AE 相当のタイムライン編集（UI 層・MVP 後の UX 拡張）

> §20.4 の Timeline パネル責務を AE に近づけるための詳細規約。**エンジン SSoT（§5 スキーマ）は変更しない** — `inPoint`/`outPoint`/各 `AnimatedProp`/`Keyframe`、および footage 系コンポーネントの源時刻オフセット（`video`/`audio` の `trimStart`、`html` の内部 `inPoint`）は**既存フィールド**である。本節は **UI 層と store 操作の規約**。

### §21.0 スコープ（段階導入・確定）

AE タイムラインの機能を **Tier A〜D** に分け、本リビジョンで **Tier A のみ**を実装する。B〜D は `progress.md` に優先度高めのバックログとして記録し、別リビジョンで §5 スキーマ拡張・INV 影響評価を伴って導入する。

| Tier | 内容 | スキーマ影響 | 区分 |
|---|---|---|---|
| **A** | プロパティツリー展開 / per-property ストップウォッチ＋値編集 / KF 行 / レイヤーバーの drag（in/out トリム・スライド）/ 時間ルーラー＋SMPTE タイムコード / レイヤー番号 | **なし**（既存スキーマで成立） | **本リビジョン** |
| **B** | ラベル色 / solo / lock / shy / 親とリンク(parent) ドロップダウン UI | additive（`SceneObject` にフラグ追加） | 将来（優先度高） |
| **C** | ブレンドモード / トラックマット | renderer(INV-3)＋export 経路拡張 | 将来（優先度高） |
| **D** | モーションブラー / フレームブレンド / 3D レイヤー / 調整レイヤー | 大規模・決定論モデル評価要 | 将来 |

### §21.1 タイムコード表示（確定）

- **正準単位は整数 `Frame`（INV-5 不変）**。タイムコードは**派生表示のみ**で、内部状態・直列化には一切影響しない。
- 表示形式は **SMPTE `HH:MM:SS:FF`（non-drop）**。`f = round(fps)` とし、`FF = frame % f`、`SS = floor(frame/f) % 60`、`MM = floor(frame/(f*60)) % 60`、`HH = floor(frame/(f*3600))`。各 2 桁ゼロ埋め。
- ドロップフレーム（`0;00;00;00`）は §16 将来（整数 fps では non-drop と一致するため MVP 不要）。

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

### §23.2 時間マッピング（Phase 1）

```
childFrame = clamp(parentFrame - layer.inPoint + trimStart, 0, childComp.duration - 1)
```

- 親フレームが子コンプの `duration` を超えた場合は **最終フレームで停止（Freeze）** — AE のデフォルト同等。
- 1:1 時間マッピング（時間リマップなし）。
- `layer.inPoint` は DomRenderer が `resolve()` を通じて受け取る（resolved component props に `_inPoint` として注入）。

### §23.3 レンダリング（Phase 1）

**nest アプローチ（AE の non-collapse 相当）**: 各 comp レイヤーに対してコンテナ div を作り、子コンプの objects をその内部に描画する。

- `DomRenderer.renderNestedComp(container, childComp, childFrame, depth)` が担当。
- depth ≤ 4 の再帰ネストを許可（循環参照が追加時に排除されるが念のためガード）。
- Phase 1 制限: コンテナ内での html/plugin component は描画されない（Phase 3 で対応）。
- 親レイヤーの `opacity`（`entry.div.opacity`）は CSS opacity の継承で自動的に子全体に乗算される。

### §23.4 循環参照制御

- `store.addCompLayer(compId)` において BFS で循環を検出し、循環が生じる場合は追加を拒否する（`null` 返却）。
- FS インポート等で循環が混入した場合は、`renderNestedComp` の depth guard で深度 4 以上の再帰を打ち切る（最悪でも無限ループにならない）。

### §23.5 AE との比較

| 項目 | AE | Mafter Phase 1 |
|------|-----|---------------|
| 配置方法 | Project パネル → Timeline DnD | 同じ（DnD のみ） |
| time mapping | 1:1（デフォルト） | 1:1（trimStart オフセットのみ） |
| time remapping | AnimatedProp として設定可 | Phase 2 以降 |
| collapse / non-collapse | 2 モード切替 | 常に non-collapse 相当 |
| precomp opacity | レイヤー全体で適用 | 同じ（CSS opacity 継承） |
| 循環参照 | UI 拒否 | 追加時に BFS 検出・拒否 |
| nested html/plugin comp | 専用レンダラ | Phase 3 以降 |

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

- **透明チェッカーボード**: ステージ背景。comp に背景色がある場合はその上、無い領域（アルファ抜き）でチェッカーが見える。export は従来どおり comp 背景/アルファに従う。
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
| 段落（ボックス）テキスト / 文字単位の混在スタイル / パステキスト / 範囲セレクター式アニメーター | ❌ 将来（§16） | グリフ分解で代替できるため MVP 外 |

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

  font:   string;                     // family 名（assets フォント §11.6 or system）。animatable: false
  align:  "left" | "center" | "right";// animatable: false（justify は将来）
  weight: number;                     // 100..900（CSS font-weight）。animatable: false
  italic: boolean;                    // animatable: false
}
```

- 既定値（`addText` が積む初期 props）: `text="Text"`, `size=48`, `color=白`, `tracking=0`, `leading=0`, `strokeColor=黒`, `strokeWidth=0`, `font="sans-serif"`, `align="left"`, `weight=400`, `italic=false`。
- 単位の確定: `tracking`・`leading` は **px**（AE の 1/1000 em 方式は将来）。`leading=0` は CSS `line-height: normal`。
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
    { key: "align",       label: "Align",       kind: "enum",   default: "left", animatable: false, options: ["left","center","right"] },
    { key: "tracking",    label: "Tracking",    kind: "scalar", default: 0, animatable: true },
    { key: "leading",     label: "Leading",     kind: "scalar", default: 0, animatable: true, min: 0 },
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
| Font | テキスト入力（将来: assets フォントのセレクト, §11.6） | — |
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

### §26.5 グリフ分解（GG 分解）— テキストアニメーションの代替（確定）

AE のテキストアニメーター＋範囲セレクターは実装せず、**「1 文字 = 1 SceneObject」に分解する破壊的コマンド**で代替する。各グリフは独立した `text` レイヤーになり、**既存の Transform + キーフレーム機構だけ**で個別アニメーション（文字送り・タイポアニメ等）が作れる。

#### §26.5.1 コマンド仕様

「Decompose Glyphs（グリフ分解）」コマンド（Timeline / 右クリックメニュー / Inspector ボタンから起動、undo 可）:

1. **現在フレームの Source Text とスタイル**（font/size/tracking/leading/weight/italic）から**文字レイアウトを測定**する。測定は**エディタ層**で Canvas 2D `measureText`（または §26.4 のフォントパーサ）を用いる。→ **`resolve()` の純粋性（INV-1）を保つため、測定は編集時に一度だけ行い、結果の座標を静的 Transform に焼き込む**（resolve 経路では測定しない）。
2. 改行・align・tracking・leading を考慮し、各グリフの**ブロック内原点 (x, y)** を算出。
3. グリフ 1 つにつき `SceneObject` を 1 つ生成:
   - `text` component に**その 1 文字**を格納。font/size/color/stroke/weight/italic を元レイヤーからコピー。
   - `transform.position` に焼き込んだ原点、`anchor` をグリフ基準点に設定。
   - `parent` = **元レイヤー**（下記 4 でコンテナ化）。→ ブロック全体の Transform/アニメをグリフが継承（§5.4 parent 継承）。
   - `zOrder` は元レイヤー近傍に連番付与（fractional・§5.4）。新 ID は ULID（INV-6）。
   - 空白文字は**レイヤーを作らず advance（送り幅）だけ**反映。
4. **元レイヤー**は Source Text を空にして**トランスフォーム専用のコンテナ**（= 実質 null/group）として残す。これによりブロック単位の移動・回転・スケールが 1 箇所で効き、各文字は個別 KF で動かせる。
5. 全変更を **1 command（1 undo）**で確定する（§17, §21.5 の複数オブジェクト patch と同様）。

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
- フィルタ片は 2 種:
  - `{ kind: "css", fn }` … CSS `<filter-function>` トークン（例 `"blur(4px)"`）。
  - `{ kind: "svg", primitives }` … SVG filter primitive 群。DomRenderer が `<svg><filter id="fx-{objId}-{i}">…</filter></svg>` を host に紐づけ、`url(#fx-{objId}-{i})` トークンを生成。
- DomRenderer は effect 配列順にトークンを連結して **1 本の `filter` 文字列**にする（CSS `filter` は関数と `url()` を**混在・左→右順適用**できる）。例: `filter: blur(2px) url(#fx-abc-1)`。
- **reconcile**: host div の filter 文字列と svg `<filter>` defs は、effect の型/順序/有効状態が変わったときだけ作り直す（既存 `childSig` と同様の `fxSig`）。毎フレームは解決済み値で filter 文字列を更新するのみ。
- **filter region**: 各 `<filter>` には `x/y=-25% width/height=150%` を付与し、displacement / feather がレイヤー端でクリップされないようにする。`feImage` は `(0,0,w,h)` に固定（`x/y/width/height` 明示）するので region を広げても map/mask 画像は歪まない。

> **なぜ CSS filter か**: HTML comp が主役の DOM レンダラ（§8）と最も整合し、preview と foreignObject export（§11.4・テキスト export が既に使用）で**同一経路でラスタライズ**される＝ INV-2 を素直に満たす。`url(#)` SVG filter も foreignObject に内包できる。

### §27.2 EffectDef（§12 `registerEffect` の具体化・確定）

§12 で予約済みの `registerEffect(def: EffectDef)` を以下で確定する。**component の `ParamDescriptor[]` 契約を共有**する（Inspector / Timeline / KF / 補間 / expression を再利用するため）。

```ts
type EffectFilter =
  | { kind: "css"; fn: string }          // 例: "blur(4px)"
  | { kind: "svg"; primitives: string }; // <filter> の中身（feColorMatrix 等）。SourceGraphic を入力に取る

interface EffectRenderCtx {
  width: number;    // comp 解像度（tint blend / 単位換算用）
  height: number;
}

interface EffectDef {
  type: string;                       // "blur" | "tint" | plugin
  label: string;
  params: ParamDescriptor[];          // §5.5 と同契約（animatable param は AnimatedProp で props に入る）
  bundleExportDefault?: "live" | "bake"; // 既定: builtin=live / plugin=bake（§12 安全側）
  // 純関数。resolve 済み props（具体値）→ フィルタ片。null = 何もしない（恒等）。
  // DOM/乱数/Date 禁止（INV-1 相当。値は resolve() で焼き済み）。
  apply(props: Record<string, unknown>, ctx: EffectRenderCtx): EffectFilter | null;
}
```

- `pluginRegistry` に `registerEffect` / `getEffectDef(type)` / `listEffects()` を追加。DomRenderer と Inspector/Timeline は registry を lazy 参照（component と同じパターン）。
- builtin（`blur`/`tint`）も **エディタ初期化時に登録**する（§26.2 の builtin ComponentDef 登録と同じ場所・[store.ts](../src/editor/store.ts)）。
- **EffectDef I/O 契約**は §10/§14 の将来 WASM effect（buffer→buffer）と整合させる方針を維持（現状は DOM フィルタ片を返すが、`apply` は純関数で副作用なし）。

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

- `apply` → `{ kind: "svg", primitives }`。**真の正弦波** displacement map（`feImage`(data URI linearGradient) → `feDisplacementMap`）。AE Wave Warp のクリーンな正弦に合わせ、ノイズ（`feTurbulence`）は使わない。
- `amplitude === 0` は `null`（恒等）。
- displacement map の各 stop 色 = `0.5 + 0.5·sin(2π·pos/λ + phase)` を片チャンネルに載せる（他チャンネルは中立 128）。`feDisplacementMap scale = 2·amplitude`（変位 = `scale·(channel−0.5)` ゆえ振幅 `amplitude` px）。
- `direction=horizontal` は X 方向変位を R チャンネルに、`vertical` は Y 方向変位を G チャンネルに載せる。
- `phase` は data URI 内の正弦位相に直結 → **滑らかにスクロール**（seed 跳躍なし）。純関数の文字列生成のみ、乱数禁止（INV-1）。

#### `turbulentDisplace` — Turbulent Displace

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `amount` | Amount | scalar | `50` | min 0, max 500, step 0.1 | ✅ |
| `size` | Size | scalar | `50` | min 1, max 500, step 0.1 | ✅ |
| `evolution` | Evolution | scalar | `0` | 0..360, step 1 | ✅ |

- `apply` → `{ kind: "svg", primitives }`。`feTurbulence type="turbulence"` + `feDisplacementMap`。
- `amount === 0` は `null`。
- `size` → `baseFrequency`（大→低周波）。`evolution` → `seed`（決定論的）。

#### `ripple` — Ripple（放射状近似）

| param key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `radius` | Radius | scalar | `100` | min 0, max 1000, step 0.1 | ✅ |
| `amplitude` | Amplitude | scalar | `10` | min 0, max 200, step 0.1 | ✅ |
| `frequency` | Frequency | scalar | `5` | min 0.1, max 50, step 0.1 | ✅ |
| `centerX` | Center X | scalar | `0.5` | 0..1, step 0.01 | ✅ |
| `centerY` | Center Y | scalar | `0.5` | 0..1, step 0.01 | ✅ |

- `apply` → `{ kind: "svg", primitives }`。**同心円状** displacement map（`feImage`(data URI radialGradient・`userSpaceOnUse` 円形) → `feDisplacementMap`）。半径方向に `sin`/`cos` を R/G に載せ、変位ベクトルを半径に応じて回転させて「水紋」状にする。振幅は `(1−o)` で外側へ減衰し、`radius` 外は中立（無変位）。`center` は radialGradient の `cx/cy` に直結（AE 同様に中心が効く）。`frequency` = `radius` 内のリング数。
- 単一 displacement map では厳密な放射方向ベクトルを表現できないため**近似**（AE Ripple 100% 一致は非目標）。ノイズより遥かに波紋らしい見た目を優先。
- `amplitude === 0` は `null`。`feDisplacementMap scale = 2·amplitude`。

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

### §27.4 調整レイヤー（Adjustment Layer・最小実装）

**意味（AE 準拠）**: 調整レイヤーは自身の content を描画せず、`effects[]` を**その下（背面・低 zOrder）に重なる全レイヤーの合成結果**に適用する。

**DOM 実装（確定・最小）**:
- `SceneObject.isAdjustment === true` のオブジェクトは host div の **content components を描画しない**（透明）。
- effects は `filter` ではなく **`backdrop-filter`** として host div に適用する。`backdrop-filter` は描画順で**背面に既に描かれた内容**に作用する＝ DomRenderer の z-index(=zOrder) 順描画と一致し、低 zOrder のレイヤーだけが対象になる（AE「下のレイヤーに効く」と一致）。
- **作用範囲 = host div の矩形**（transform 適用後）。既定サイズ = comp 全体（width×height）。transform で縮小/移動すれば AE 同様に作用領域を限定できる（マスク相当は将来）。
- store に `addAdjustmentLayer()`（isAdjustment=true・content component なし・既定 full-comp サイズ・zOrder 最前）と `toggleAdjustment(objId)` を追加。Inspector/Timeline に調整レイヤーバッジ（§27.6/§27.7）。

**`backdrop-filter` トークン**: §27.1 と同じ順序付きフィルタ文字列を `backdrop-filter` に入れる。

> **INV-2（preview = export）に関する注記（重要・確定）**:
> - **通常レイヤーの effects（`filter`）は export でも一致**する（foreignObject ラスタ経路がテキスト export で実証済み・§11.4）。Blur / Tint はここで保証対象。
> - **調整レイヤーの `backdrop-filter` は foreignObject ラスタ化で再現性が browser/経路依存**（背面合成結果への作用は SVG foreignObject→canvas で欠落しうる）。よって調整レイヤーは **preview ベストエフォート**とし、export 一致は実装時に Playwright ピクセル差分で**検証必須**。再現できない場合は §26 の Draft/Best 残差と同格の「**許容済み既知差（preview 専用）**」として progress に明記し、ブロッカーにしない。将来の厳密対応（背面を一旦 raster してから filter する合成パス）は Phase 2。

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
- **調整レイヤー**: Inspector に `isAdjustment` トグル（または専用作成）。ON のとき content components セクションは「調整レイヤー（描画なし）」と注記。

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
- 調整レイヤーはレイヤーバーにバッジ表示（AE のアイコン相当・任意）。

### §27.8 ストア / コマンド / Undo（確定）

すべて既存の command 経路（before/after スナップショット・immutable 編集・§17）を通す。新規 store アクション（各 1 undo）:

- `addEffect(objId, type)` / `removeEffect(objId, effectId)` / `reorderEffect(objId, effectId, dir)` / `toggleEffect(objId, effectId)`。
- effect param の値/KF 書き込みは既存 `setPropByPath` / `setKeyframe` を **PropPath 拡張**（`effects.<id>.<key>`）で流用。スクラブ中の即時反映は §（2026-06-18）`previewOverride` 経路を流用。
- `addAdjustmentLayer()` / `toggleAdjustment(objId)`。
- 新規 `EffectInstance.id` は ULID（INV-6）。既定 props は `EffectDef.params[].default` から生成。

### §27.9 不変条件（INV 影響評価・確定）

INV-1〜8 を保持。新規 INV は不要。

- **INV-1**: `resolve()` / `EffectDef.apply` は純関数。effect param は resolve で焼く。
- **INV-2**: 通常レイヤー effects は preview/export 一致（§27.4 注記）。調整レイヤーは preview ベストエフォート（export 検証必須・再現不可なら許容済み既知差）。
- **INV-3**: レンダラは `ResolvedScene`（焼き済み）のみ受け取る。`effects`/`isAdjustment` は ResolvedObject に載る。
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
