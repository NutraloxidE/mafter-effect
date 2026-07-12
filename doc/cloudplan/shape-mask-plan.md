# シェイプによるマスク（レイヤーパスマスク）機能設計プラン

> **ステータス**: ドラフト（未承認）。本ファイルは `doc/mafter-effect-spec.md`（SSoT）を置き換えない。
> §5 データスキーマ・INVARIANT・`project.json` 直列化形式に触れる項目は **ユーザー承認が必須**（CLAUDE.md 運用体制）。該当箇所は本文中に **⚠️ 要承認** と明記した。
> 作成日: 2026-07-12 / 対象ブランチ: `claude/shape-mask-implementation-gishmv`

---

## 0. TL;DR

- **「マスク」= トラックマット（§5.4f）はすでに実装済み**（`schema.ts:159` `trackMatteMode` / `resolve.ts:309-348` / `trackMatteApply.ts` / `trackMatteDom.ts`）。直上レイヤーの alpha / luma をマット源に切り抜く AE の TrkMat 準拠。
- **シェイプ描画レイヤー（rect / ellipse / ベジェパス `vertices` / 複数リング `rings` / Boolean 合成 `mergeInputs`）もすでに実装済み**（`schema.ts:63-99` / `shapePath.ts` / `shapePathBoolean.ts` / `shapeBake.ts` / `store.ts:1150` `addShape`）。
- **したがって「シェイプで別レイヤーをくり抜く」ことは今日でも可能** — シェイプ層を対象の直上に置き、対象レイヤーに `trackMatteMode="alpha"` を設定すればよい（トラックマット源は型非依存。除外は `isAdjustment` / `isNull` / camera のみ、spec §5.4f）。**この意味でのシェイプマスクは新規実装ゼロで成立する**。
- **未実装なのは AE 風の「レイヤー付属パスマスク」** — 同一レイヤーに**マスクパスを直接貼り**、複数マスクを **mode（Add / Subtract / Intersect / Difference）** で合成し、**feather / expansion / マスク不透明度** を持たせる機能。spec §5.4f L291 が「**レイヤーパスマスク（ペン / ベジェ）は含まない**（将来）」と明記しており、`SceneObject` に `masks?:` フィールドは存在しない。
- 本プランは 2 経路を提示する:
  - **Phase 1（軽量・今回の主提案・⚠️承認不要）** — 既存の「シェイプ層 + トラックマット」を **1 クリックの「下のレイヤーのマスクにする」導線**として UX 化する。§5 スキーマ変更ゼロ・INV 変更ゼロ。
  - **Phase 2（AE パリティ・⚠️要承認）** — `SceneObject.masks?: LayerMask[]` を新設し、同一レイヤー内の複数パスマスク・mode 合成・feather / expansion を実現する。§5 スキーマ変更・新規レンダラ経路・新規オンキャンバス gizmo・export 正常化（§E）が必要。
- **UI 方針（shape-editing-plan と整合）**: マスク編集は既存の Shape / Inspector 資産を再利用し、分散した新パネルは作らない。Phase 2 の頂点編集は shape の頂点 gizmo と同じ基盤を共用する。

---

## 1. 現状調査サマリ（コード根拠）

### 1.1 トラックマット（＝現状の「マスク」）は完成配線済み

| 箇所 | 状態 |
|---|---|
| `src/core/schema.ts:159` | `SceneObject.trackMatteMode?: TrackMatteMode`（`"alpha" \| "alphaInverted" \| "luma" \| "lumaInverted"`、L202-208）。 |
| `src/runtime/resolve.ts:309-348` | `resolveTrackMattePairs` でスタックをペアリング → 塗りに `trackMatte: { mode, matteId }`、可視マット源に `isTrackMatteSource: true` を焼く（INV-3）。 |
| `src/runtime/trackMatteApply.ts` | RGBA バッファ上の純関数 `applyTrackMatte`（INV-1）。合成の正準。 |
| `src/runtime/trackMatteDom.ts` | preview / export 共通の DOM キャプチャ + canvas blit。CSS `mask-image` / SVG mask+foreignObject は使わない（Chromium で text マット不可のため）。 |
| spec §5.4f（L271-291） | 仕様確定済み。**マット源はスタック直上（ID 参照なし）**、連鎖なし（v1）、対象外は `isAdjustment` / `isNull` / camera のみ。 |

**重要**: マット源の型に制限はない（除外リストは `isAdjustment` / `isNull` / camera のみ）。**シェイプ層はそのままマット源になれる。**

### 1.2 シェイプは Phase 1–3 まで実装済み（描画レイヤーとして）

`shape-editing-plan.md` が提案した Phase 1（矩形/楕円）・Phase 2（頂点/ベジェパス）・Phase 3（Boolean/Pathfinder）は、現時点でスキーマ・実装ともに存在する:

| 箇所 | 状態 |
|---|---|
| `src/core/schema.ts:67-73` | `ShapeVertex { id, pos, inTangent?, outTangent? }`（すべて `AnimatedProp<Vec3>`、INV-6 の ULID）。 |
| `src/core/schema.ts:80` | `ShapeRings = ShapeVertex[][]`（穴・分離図形・`fill-rule="evenodd"`）。 |
| `src/core/schema.ts:91-99` | `BooleanMergeInput { id, objectId, op }` + `BooleanOp`（`kind="merge"` の Pathfinder 合成、他レイヤー参照）。 |
| `src/runtime/shapePath.ts` | 頂点 → `<path d>` の純関数（`buildShapePathD` / `buildMultiRingPathD`、INV-1）。 |
| `src/runtime/shapePathBoolean.ts` | Boolean 合成（`polygon-clipping`、`src/types/polygon-clipping.d.ts`）。 |
| `src/editor/shapeBake.ts` | `kind="merge"` の Bake（rings 出力）。 |
| `src/editor/store.ts:1150` | `addShape(name?)` — エディタから shape レイヤーを作れる。 |
| `src/runtime/DomRenderer.ts`（`case "shape"`） | rect/ellipse は CSS box、path/rings は SVG `<path>` 描画。 |

→ **シェイプ形状（矩形・楕円・自由ベジェパス・穴あき・Boolean 合成）はすべて表現可能。** これを「マット源」として使えば任意形状のくり抜きができる。

### 1.3 未実装 — AE 風のレイヤー付属パスマスク

`src/core/schema.ts` の `SceneObject`（L135-160）を `mask` で grep してもヒットは `trackMatteMode` のみ。**`masks?:` フィールド・マスクモード・feather / expansion に相当する型は存在しない。**

AE の「マスク」（レイヤーを選択して直接ペンで描くマスク）が持つ以下は現状すべて欠落:

- **同一レイヤーへの付属**（別レイヤーを立てずにそのレイヤー自身をくり抜く）
- **複数マスクの mode 合成**（Add / Subtract / Intersect / Difference）
- **マスク feather**（境界のソフト化）/ **expansion**（膨張・収縮）/ **マスク不透明度**
- **マスクパスのキーフレーム**（形状アニメーション。頂点 `AnimatedProp` 自体は shape で実現済みだが「マスクとして」の配線はない）

spec §5.4f L291 が明示的に「**非目標（v1）: レイヤーパスマスク**」としており、これは意図的な将来スコープ。

### 1.4 「シェイプ層 + トラックマット」で今できること／できないこと

| やりたいこと | 現状 | 手段 |
|---|---|---|
| 任意形状で 1 レイヤーをくり抜く | ✅ 可能 | シェイプ層を直上に置き、対象に `trackMatteMode="alpha"` |
| くり抜き形状を反転 | ✅ 可能 | `trackMatteMode="alphaInverted"` |
| くり抜き形状をアニメート | ✅ 可能 | シェイプ層の `vertices` / transform をキーフレーム |
| 穴あき・複合形状でくり抜く | ✅ 可能 | shape の `rings` / `mergeInputs`（Boolean）をマット源に |
| **1 レイヤーに複数マスクを重ねて mode 合成** | ❌ 不可 | トラックマットは 1 塗り = 1 マット源（連鎖なし v1） |
| **マスク境界の feather / expansion** | △ 部分的 | エフェクト（blur 等）で近似は可能だが「マスク feather」専用 UI はない |
| **別レイヤーを立てずに同一レイヤーへ付属** | ❌ 不可 | 必ずマット源レイヤーが 1 枚増える（レイヤー数・整理性の負担） |

→ **Phase 1 は「できること」を UX として磨き、Phase 2 で「できないこと」を埋める。**

---

## 2. スコープ定義

### Phase 1（今回の主提案・軽量・⚠️承認不要）— 「シェイプをマスクに」ワンクリック導線

**追加するデータ型: ゼロ。** 既存の `shape` コンポーネント + `trackMatteMode` の組み合わせを、ユーザーが AE の「マスク」感覚で使えるよう UI 導線を足すだけ。

やること（すべて `src/editor/` 内、runtime / schema 非変更）:

1. **Timeline / Inspector に「マスクとして使う」操作を追加**:
   - 選択中のシェイプ層（または任意レイヤー）に対して「**直下のレイヤーのマスクにする**」アクション → 内部で下のレイヤーに `trackMatteMode="alpha"` を設定し、シェイプ層を直上へ並べ替える（`zOrder` 調整）。1 コマンド（undo 可）。
   - 逆操作「マスクを解除」= `trackMatteMode` を削除。
2. **「マスク付きシェイプを新規作成」ショートカット**:
   - 選択レイヤーに対して「矩形マスクを追加」「楕円マスクを追加」→ 対象と同サイズのシェイプ層を生成し、直上に置いて `trackMatteMode="alpha"` を自動設定。AE の「レイヤー選択 → 矩形ツールでマスク」に近い体験を、既存の shape + トラックマット資産だけで再現する。
3. **可視化の改善**: マット源になっているシェイプ層を Timeline で判別できるラベル/アイコン（既存の `isTrackMatteSource` 情報を UI に出す。resolve では既に焼かれている）。
4. **反転トグル**: マスクの反転を `alpha` ↔ `alphaInverted` のトグルとして Inspector に出す。

**この段階で得られる体験**: 「シェイプでレイヤーをくり抜く」を、レイヤーを手で並べ替えて trackMatteMode をドロップダウンから選ぶ、という現状の手数から、1 クリックへ短縮する。**新規スキーマなし・新規レンダラなし・INV 影響なし**（純粋にストア操作 + UI）。

**限界（Phase 1 では埋まらない）**: 1 レイヤー複数マスクの mode 合成、マスク専用 feather / expansion、別レイヤーを立てない同一レイヤー付属。これらは Phase 2。

### Phase 2（AE パリティ・⚠️要承認・大きい）— レイヤー付属パスマスク

AE の「マスク」に本格的に一致させるには、**レイヤー自身が複数のマスクパスを持てる**モデルが必要。以下が必要になる:

- ⚠️ **要承認（§5 スキーマ変更）**: `SceneObject.masks?: LayerMask[]` の新設（additive-optional）。想定型:
  ```ts
  type MaskMode = "add" | "subtract" | "intersect" | "difference"; // AE Mask Mode 相当
  interface LayerMask {
    id: string;                    // ULID (INV-6)
    vertices: ShapeVertex[];       // Phase 2 shape と同じ頂点型を再利用（tangent = 相対オフセット）
    mode: MaskMode;                // このマスクを直前までの合成結果へどう合成するか
    inverted: boolean;             // マスク反転
    opacity: AnimatedProp<number>; // マスク不透明度 0..1
    feather: AnimatedProp<Vec3>;   // 境界ソフト化（AE は x/y 独立）
    expansion: AnimatedProp<number>; // 膨張(+)/収縮(-) px
  }
  ```
  `masks` が存在すれば、そのレイヤーの描画結果を `masks` の合成マスクでくり抜く（存在しなければ従来通り = 後方互換）。
- ⚠️ **要承認（INV-6 適用範囲）**: マスク・マスク頂点の stable ID（ULID）を INV-6 の対象に明示。
- ⚠️ **要承認（`project.json` 直列化形式）**: `masks` フィールドの正準シリアライズ（配列順保持・省略時 byte 等価 INV-4）。既存 serialize/validate に additive で足す。
- **新規レンダラ経路（INV-2 / INV-3）**: resolve 済み `masks` から純関数で合成マスクを組み立て、レイヤーへ適用。トラックマットが text マット対応のため `mask-image` を避け canvas 合成（`trackMatteApply.ts`）にした教訓に従い、**同じ純関数合成経路を再利用**するのが安全。feather は SVG `feGaussianBlur`、expansion は `feMorphology`（既存 `effectSvg.ts` の SVG 文字列生成規約を流用）。
- **export 正常化（§E 必須）**: 新しいくり抜き経路は browser export（mp4 / webm / PNG 連番）/ `compFrameCapture`（ネスト precomp・調整レイヤー）/ Web bundle player（§11.7）/ preview（INV-2）を横断で無回帰確認。**トラックマットと同じ純関数を通せば INV-2 は自動的に担保**される設計を狙う。
- **新規オンキャンバス gizmo**: マスク頂点のドラッグ・ベジェタンジェント・頂点追加/削除。**shape の頂点編集 gizmo と共用**する（`shape-editing-plan` Phase 2 の gizmo 基盤があれば流用、なければ同時に整備）。既存の Transform ギズモ（`PreviewViewerOverlay.tsx`）とは独立オーバーレイ。
- **bundle player 再ビルド**: runtime（resolve / DomRenderer / 合成ヘルパ）を触るため `npm run build:player` が必須（CLAUDE.md「bundle player 再ビルド」節）。

Phase 2 は本プランではロードマップ記載に留め、着手時に §5 / INV / 直列化の承認を改めて得てから設計を確定する。

### Phase 1 と Phase 2 の関係

- **Phase 1 は Phase 2 の前提ではない**（独立に価値がある）。承認不要ですぐ着手できる。
- **Phase 2 のデータモデルは Phase 1 の trackMatte 経路と共存**する（`masks` は同一レイヤー付属、trackMatte は別レイヤー源。両立して問題ない）。
- **頂点編集 gizmo は shape（`shape-editing-plan`）と Phase 2 マスクで共用**するのが自然。どちらを先に整備しても他方が乗れる。

---

## 3. §5 / INV への影響サマリ（承認要否）

| 項目 | Phase 1（トラックマット UX 化） | Phase 2（レイヤー付属マスク） |
|---|---|---|
| §5 `SceneObject` 型変更 | **なし** | ⚠️ 要承認（`masks?: LayerMask[]` 新設） |
| §5 `ParamKind` / 新規型 | **なし** | ⚠️ 要承認（`LayerMask` / `MaskMode` の新設） |
| INV-1〜6 | 影響なし（既存ストア操作のみ） | INV-1（マスク合成が純関数）・INV-2（全経路一致）・INV-3（resolve で焼く）・INV-6（マスク stable ID）を要確認 |
| `project.json` 直列化形式 | 変更なし | ⚠️ 要承認（`masks` の additive シリアライズ・byte 等価 INV-4） |
| bundle player 再ビルド | 不要（runtime 非変更） | 必須（resolve / DomRenderer 変更） |

**結論**: Phase 1 は CLAUDE.md の「勝手に進めず確認が必要」な 3 項目（INV 変更・§5 型変更・直列化形式変更）のいずれにも該当しない、純粋な UI / ストア作業。Phase 2 は 3 項目すべてに該当するため着手前にユーザー承認が必須。

---

## 4. 検証計画

### Phase 1（トラックマット UX 化）

1. **unit**: 「マスクにする」コマンドが `trackMatteMode` を正しく設定/削除し、`zOrder` 並べ替えが決定論的であること。undo で完全復元（逆パッチ）。
2. **既存回帰**: `npm test` 全体。トラックマット系（`test/trackMatte.test.ts`）が無回帰。
3. **実機 Playwright**: シェイプ層 + 「マスクにする」→ 下のレイヤーが形状にくり抜かれる → 反転トグル → export（mp4 / PNG 連番）で正しく焼き込まれる → 既存の非関連シナリオが無回帰。
4. runtime 非変更のため `npm run build:player` 不要（`playerBuildFreshness` は変わらず緑）。

### Phase 2（レイヤー付属マスク・着手時）

1. **unit**: `resolve()` / `serialize()`（byte-equal・INV-4）に `masks` 付きレイヤーのケース追加。合成マスクの純関数（feather / expansion / mode）をピン止め。
2. **export 横断（§E）**: browser export（mp4 / webm / PNG 連番）/ `compFrameCapture` / bundle player / preview の 4 経路で INV-2 一致。既存 `verify-*-export*.mjs`・トラックマット・blend / 調整レイヤーの無回帰。
3. **実機 Playwright**: 複数マスク + mode 合成 + feather + expansion + マスクパスのキーフレームアニメーション。頂点 gizmo の追加/削除/ドラッグ。
4. **bundle**: `npm run build:player` 後、HTML bundle export でマスクが正しく効く。

---

## 5. オープン質問（着手前にユーザーへ確認したい点）

- **Q1**: 今回の「シェイプによるマスク」の期待は、**(a) シェイプ層でくり抜く体験を 1 クリック化（Phase 1・承認不要ですぐ着手）**か、**(b) AE 完全準拠のレイヤー付属マスク（Phase 2・§5 スキーマ変更で要承認）**か。**推奨は Phase 1 を先に出して体験を確認 → 必要なら Phase 2 を承認付きで**。
- **Q2**: Phase 1 の導線は「既存の任意レイヤーをマスク源にする」と「矩形/楕円マスクを新規生成して付ける」の両方が要るか、後者だけで十分か。
- **Q3**: Phase 2 に進む場合、マスクモードは AE の 5 種（None/Add/Subtract/Intersect/Difference）フルセットか、まず Add/Subtract のみで足りるか。
- **Q4**: Phase 2 の頂点編集 gizmo は shape（`doc/cloudplan/shape-editing-plan.md`）の頂点編集 gizmo と共用前提でよいか（別実装にしない）。
- **Q5**: feather / expansion は Phase 2 の初回スコープに含めるか、まず「くっきりマスク + mode 合成」だけ入れて feather / expansion を後続にするか。

---

## 6. 参照

- `doc/mafter-effect-spec.md` §5.4f（L271-291, トラックマット・非目標「レイヤーパスマスク」）/ §5.5（Component/shape 型）
- `doc/cloudplan/shape-editing-plan.md`（shape Phase 1–3 の設計・本プランと gizmo / UI 方針を共有）
- `src/core/schema.ts`（`SceneObject` L135-160 / `trackMatteMode` L159 / `TrackMatteMode` L202-208 / `ShapeVertex` L67-73 / `ShapeRings` L80 / `BooleanMergeInput` L91-99）
- `src/runtime/resolve.ts:309-348`（トラックマット resolve）/ `src/runtime/trackMatteApply.ts`（純関数合成）/ `src/runtime/trackMatteDom.ts`（DOM キャプチャ）
- `src/runtime/shapePath.ts` / `src/runtime/shapePathBoolean.ts` / `src/editor/shapeBake.ts` / `src/editor/store.ts:1150`（`addShape`）
- `.claude/skills/add-layer-component-type/SKILL.md`（§E export 正常化）/ `.claude/skills/implementation-loop/SKILL.md`
