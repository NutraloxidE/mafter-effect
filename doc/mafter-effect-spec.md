# Mafter Effect — MVP 仕様書 v0.3

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
| `text`      | テキスト（DOM レンダリング）        | `text`, `font`, `size`, `color`, `align` |
| `image`     | 画像アセット表示                   | `asset: AssetId`, `fit`              |
| `shape`     | rect / ellipse（最小図形）          | `kind`, `fill: RGBA`, `radius`, `size: vec2` |
| `html`      | HTML Composition（Model A, §7）     | `compId: CompId`, + comp が宣言した params |
| `video`     | 動画アセット（best-effort, §11.4）   | `asset: AssetId`, `fit`, `trimStart: Frame` |
| `audio`     | 音声アセット（最小, §11.5）          | `asset: AssetId`, `gain`, `trimStart: Frame` |
| `camera`    | カメラ（comp に最大 1 つ active）   | `fov`, （Transform で位置/向き）      |

plugin はここに新しい type を追加できる（§12）。

> **決定（覆し可）**: `video` と `audio` を MVP に入れた（音楽 MV 用途を想定）。ただし `video` は決定論シーク制約があり browser は best-effort（§11.4）。`audio` は最小（gain 静的・mix なし・export で mux、§11.5）。`compRef`（comp ネスト＝precomp）は曖昧さが大きいため **MVP から外し §16 将来**へ（プリコンポは時間マッピング/collapse 仕様が要るため）。

> **`exportStrategy` の既定（確定）**: web bundle export 時、各 component type が既定を宣言する。**自動判定はしない**（任意の author JS が実用速度で web 実行できるかは静的に分からないため）。既定: `solid`/`text`/`shape`/`image`/`html`/`audio` → `live`、将来の WebGL/particle/3D → `bake`。**plugin（第三者）は既定 `bake`**（§12、配信時に第三者コードをエンドユーザに流さない安全側）。author は per-component で上書き可。`bake` 指定レイヤは export 時に headless 機構（§11.4 / M3.5）で部分 MP4/WebP 化してアセットに差し替える。

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
- **意味順を持つ配列は並べ替えない**: `components`（エフェクト等の重なり順が意味）、各 `AnimatedProp.keyframes`（`frame` 昇順を維持）。
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
- オブジェクトは `inPoint <= frame <= outPoint` かつ `enabled` のときのみ描画。
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
| Model B（DOM 内省で要素を Object 化） | 将来 |
| WebGL/WebGPU レンダラ / 実 3D（深度・ライティング・物理カメラ） | 将来 |
| Blender Camera / Depth Import（IO plugin） | 将来 |
| Particle / Advanced Effects / 分散レンダリング / AI 編集支援 | 将来 |
| comp/plugin JS のハードサンドボックス / CSP | 将来（セキュリティ硬化） |
| keyframed gain / audio mixing / 波形表示 / video 内蔵音声同期 | 将来 |
| OPFS アセット格納 / time remap / per-axis easing・expression / 速度グラフ | 将来 |

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

*v0.3 / MVP scope = M0–M4（Web Bundle Export は M5）。このファイルが「エンジンを作るための SSoT」。`claude.md` が「エンジンを使うための SSoT」。*
