# 3D テキスト拡張 — 実装Plan分解（下位モデル/Codex 実行用）

> **これは何**: [3d-text-extrusion-plan.md](3d-text-extrusion-plan.md)（設計・戦略）を、下位モデル（Codex medium 等）が **1 Ticket=15〜30 分**で安全に実装できる作業票へ分解したもの。
> **設計の「なぜ」は親プランを見る**。この文書は「どのファイルを・何を・どうテストして・どこで止まるか」だけを扱う。
> **正本の順序**: 設計プラン（親）→ 本分解（子）→ spec（SSoT・§5/§6/§26 追記）→ 実装。spec を更新せずコードだけ変えない（CLAUDE.md）。
> **make-plan-for-codex スキル準拠**。Codex に Phase を投げない。Claude が WP を選び Ticket に砕いて渡す。

---

## 0. Plan intake summary

- **Source document**: `doc/cloudplan/3d-text-extrusion-plan.md`（案 B = per-layer 素 WebGL 押し出しメッシュ・three.js 不使用）
- **Goal**: `text`/`shape` を非破壊に 3D 押し出し化（厚み/ベベル/ねじり/曲げ/テーパー・多形式グラデーション・全 KF 可能・3D⇄2D トグル往復・shape 再利用）。ライブ性維持（ベイクなし）。
- **Known Phases**: P0 スパイク / P1 押し出しコア / P2 変形 / P3 グラデーション / P4 shape 統合 / P5 将来。
- **Required gate files**: **なし（ファイルゲートではなく承認ゲート）**。親プラン §9（§5 スキーマ追加 2 件・直列化規則・earcut 依存）+ §11 オープン質問 5 点への**ユーザー承認**が実装開始の前提。
- **Required status files**: `progress.md`（各 WP 完了時）。spec `doc/mafter-effect-spec.md`（§5.5 / §5.5f 新設 / §6.5c / §26.10 相当への追記 = WP-01）。
- **Hard forbidden areas**（全 Ticket 共通・明示許可なき限り変更禁止）:
  - `src/core/schema.ts` 以外での**型の破壊的変更**、既存 prop の削除・改名。
  - `resolve()` の既存挙動変更（新 props を**解くだけ**なら可、既存の解決結果を変えない）。
  - 共有 capture/export パイプラインの**一律**挙動変更（`rasterCapture.ts` / `exporter.ts` / `compFrameCapture.ts` / `DomRenderer` の全型・全フレーム適用の変更）。分岐は必ず `c.type ∈ {text,shape} && geomEnabled===true` でオプトイン。
  - 既存テストの期待値変更（本分解で明示許可した箇所を除く）。
  - `SceneObject` スキーマ（`threeD`/`threeDMode`/camera）への変更。3D は component props で完結。
- **Allowed file policy**: 各 Ticket が allowed files を列挙。新規は `src/runtime/geom3d/**` と `test/geom3d/**` に隔離（既存経路への差分を最小化）。
- **Required commands**: `npm run typecheck` / `npm test`（該当スイート）/ ランタイム変更後 `npm run build:player`（§build-player 節）。
- **Required generated artifacts**: `public/player.js`（DomRenderer が `geom3d/*` を import した WP 以降・commit 対象）。
- **Human verification required**（Codex が自己宣言しない）: 実 Chrome + 実ドラッグ scrub の perf 判定（P0/P2）、押し出しの見た目・正立・UV 向きのスクリーンショット目視、preview≡export のピクセル一致最終判定。
- **Ambiguities**: 親プラン §11 の 5 点（bend モデル / 単色 union / 既定パース / P4 同梱可否 / warp 拡張余地）。承認前は推測で埋めない。
- **First safe action**: **Ticket 00（gate 確認・実装なし）**。承認が下りるまで実装 Ticket を発行しない。

---

## 1. 新設ファイル一覧（隔離ディレクトリ）

すべて `src/runtime/geom3d/` 配下。既存経路への配線は WP-1x/WP-2x でのみ行う。

| ファイル | 役割 | 純度 |
|---|---|---|
| `geom3dTypes.ts` | `Geom3DParams` / `GradientFill` / `GradientStop` / `Geom3DFaces` / `OutlineGlyph` / `Mesh` 型定義 | 型のみ |
| `geom3dParams.ts` | `GEOM3D_PARAM_DESCRIPTORS`（ParamDescriptor[]）+ `parseGeom3DParams(props)`（resolved props → 正規化）+ 既定値 | 純関数 |
| `outlineProvider.ts` | text/shape の解決値 → `OutlineGlyph[]`（閉リング列 + 配置）へ正規化 | 純関数 |
| `extrudeMesh.ts` | `OutlineGlyph[]` + bevel 設定 → 単位厚メッシュ（頂点属性配列）。earcut 使用 | 純関数 |
| `geomDeform.ts` | twist/bend/taper の CPU リファレンス実装（GLSL と数式一致・テスト用） | 純関数 |
| `gradientFill.ts` | `GradientFill` 補間・stop LUT 化・`parseGradientFill` | 純関数 |
| `geom3dGl.ts` | per-layer WebGL canvas 管理（ctx/program/buffer/描画）。**唯一の非純粋モジュール** | 副作用あり |
| `geom3dMeshCache.ts` | メッシュ生成のメモ化（決定論キー） | 副作用（キャッシュ）|

テスト: `test/geom3d/{params,outline,extrude,deform,gradient,serialize}.test.ts`。

---

## 2. Phase → WP → Ticket 一覧（全体像）

```
GATE  Ticket 00        承認確認（実装なし・最初に必ず）
P1    WP-01            spec 追記（§5 スキーマ確定文面）
      WP-02  T02-a..c  型 + params 記述子 + parse（純・test）
      WP-03  T03-a..b  earcut 導入 + extrudeMesh（純・test）
      WP-04  T04-a..b  outlineProvider（text 経路のみ・純・test）
      WP-05  T05-a..c  geom3dGl（WebGL 描画・単位厚・継承色・lambert）
      WP-06  T06-a..b  DomRenderer 配線（geomEnabled 分岐・draft 降格）
      WP-07  T07-a..b  store 既定 props + Inspector 3D フォールドアウト
      WP-08  T08-a..c  export/bundle parity + build:player + 回帰ゲート
P2    WP-09  T09-a..b  geomDeform（CPU 参照・純・test）
      WP-10  T10-a..b  シェーダ変形 uniform 配線 + KF 検証
P3    WP-11  T11-a..b  gradientFill（純・test）
      WP-12  T12-a..b  geomFaces 配線（シェーダ・直列化）
      WP-13  T13       グラデーションエディタ UI
P4    WP-14  T14-a..b  outlineProvider の shape 実装（rect/ellipse/path/merge/rings）
      WP-15  T15       shape ComponentDef へ param 群 concat + 回帰ゲート
P5    （承認・実測後に別途分解）GradientFill の 2D 塗り流用 / raster3d 供給 / light・DoF
```

**依存**: WP-01 →（承認後）→ WP-02〜04 は並列可 → WP-05（04,03 依存）→ WP-06（05 依存）→ WP-07 → WP-08。P2 は P1 完了後。P3/P4 は P1 完了後（相互独立）。

---

## 3. Ticket 詳細

### Ticket 00 — Gate and approval check（実装なし・最初に必ず）

- **Owner**: Claude / Model: 下位モデル可（read-only）
- **Size**: 10 分
- **Purpose**: 実装開始条件（親プラン §9 承認・§11 回答）が満たされたかを確認し、blocker を記録する。
- **Allowed files**: `progress.md`（blocker 追記のみ）
- **Forbidden files**: すべての実装ファイル・spec・test
- **Pre-read**: `doc/cloudplan/3d-text-extrusion-plan.md` §9, §11
- **Steps**:
  1. 親プラン §9 の 4 項目（geom* params 追加 / GradientFill 型 / 直列化規則 / earcut 依存）がユーザー承認済みか確認。
  2. §11 の 5 質問に回答が付いたか確認（特に Q1 承認・Q3 単色表現・Q4 既定パース）。
  3. 未承認なら「実装は開始不可」と報告し停止。承認済みなら「WP-01 から開始可」と報告。
- **Tests/commands**: なし
- **Stop conditions**: 承認が 1 つでも欠けていれば実装 Ticket を発行しない。
- **Completion report**: gate 状態 / 実装開始可否 / 未回答質問。
- **次 Ticket へ進むな**（WP-01 は Claude が承認確認後に発行）。

---

### WP-01 — spec 追記（§5 スキーマ確定文面）

#### Ticket 01 — Write spec sections

- **Owner**: Claude 主導（spec は SSoT・§5 変更は承認事項）/ 下位モデルは下書きのみ
- **Size**: 20 分
- **Purpose**: 実装前に spec を確定（先に仕様→次に実装）。
- **Allowed files**: `doc/mafter-effect-spec.md`
- **Forbidden files**: 実装・test すべて
- **Pre-read**: spec §5.5（Component 表）, §5.5c–e（shape 前例）, §26.1（text props）, §6.5b（camera）
- **Implementation scope**:
  - §5.5 built-in component 表に `text`/`shape` の 3D params 追加を追記。
  - 新節 **§5.5f「3D ジオメトリ拡張（geom*・additive）」**: §4.2 の ParamDescriptor 群、`geomEnabled` 非アニメの理由、継承色規約、単位。
  - 新節 **§5.5g「GradientFill（再利用可能塗り）」**: §4.3 の型、直列化規則（面キー存在時のみ / stop 配列順保存 / 既定 strip）。
  - §6.5 に **§6.5c「geom3d のカメラ整合」** 1 段落: threeD=true は active camera 使用、threeD=false は既定パース（Q4 の回答値）、canvas は full-comp・カメラ免除・GL 内でのみ view/projection 適用。
  - §26 に「3D 化時の system フォント非対応→2D+警告フォールバック」1 段落。
- **Explicit non-goals**: コードを 1 行も書かない。INV 本文（§4）は変更しない（3D は既存 INV 枠内）。
- **Tests/commands**: なし（散文）
- **Stop conditions**: §9 の承認と食い違う設計を書きそうになったら停止しユーザーに確認。
- **Completion report**: 追記した節番号一覧・INV への影響（なし）を明記。

---

### WP-02 — 型 + params 記述子 + parse（純関数）

親: extrude/GL より先に「props の正規化」を固める。ParamDescriptor は既存 Timeline/Inspector を無改修で使うための唯一の契約。

#### Ticket 02-a — geom3dTypes.ts（型のみ）

- **Owner**: 下位モデル / **Size**: 15 分
- **Purpose**: 3D 拡張の全型を 1 ファイルに定義。
- **Allowed files**: `src/runtime/geom3d/geom3dTypes.ts`（新規）
- **Forbidden files**: 他すべて（`schema.ts` も触らない — これらの型は runtime ローカル）
- **Pre-read**: `src/core/schema.ts`（`RGBA`/`Vec3`/`AnimatedProp` の形）, 親プラン §4.2/§4.3
- **Implementation scope**: 親プラン §4.2/§4.3 の型を TypeScript で定義。
  ```ts
  export type GradientKind = "linear" | "radial" | "conic" | "depth";
  export interface GradientStop { id: string; offset: AnimatedProp<number>; color: AnimatedProp<RGBA>; }
  export interface GradientFill { kind: GradientKind; angle: AnimatedProp<number>; center: AnimatedProp<Vec3>; stops: GradientStop[]; }
  export interface Geom3DFaces { front?: GradientFill; side?: GradientFill; bevel?: GradientFill; back?: GradientFill; }
  export interface Geom3DParams { enabled: boolean; depth: number; bevelSize: number; bevelSegments: number;
    curveQuality: "low"|"medium"|"high"; twist: number; bend: number; taper: number;
    shading: "none"|"lambert"; lightDir: Vec3; ambient: number; }
  export interface OutlineGlyph { rings: Vec2[][]; offset: Vec2; layoutU: number; }  // Vec2 = {x,y}
  export interface MeshData { positions: Float32Array; normals: Float32Array;
    zNorm: Float32Array; faceGroup: Uint8Array; layoutU: Float32Array; bevelOffset: Float32Array; indices: Uint32Array; }
  ```
  `Vec2` はローカル定義 or `{x:number;y:number}`。`import type` で schema 型を借用。
- **Non-goals**: parse・記述子はここに書かない（02-b）。ロジックゼロ。
- **Tests/commands**: `npm run typecheck`
- **Stop conditions**: schema.ts に型を足す必要が出たら停止（設計上 runtime ローカルのはず）。
- **Completion report**: 変更ファイル / typecheck 結果。

#### Ticket 02-b — geom3dParams.ts（記述子 + parse・純）

- **Owner**: 下位モデル / **Size**: 25 分
- **Allowed files**: `src/runtime/geom3d/geom3dParams.ts`（新規）, `test/geom3d/params.test.ts`（新規）
- **Forbidden files**: builtinComponents.ts（配線は WP-07）, DomRenderer, resolve
- **Pre-read**: `src/runtime/builtinComponents.ts`（ParamDescriptor の書式）, `src/runtime/textRender.ts` の `parseTextProps`（parse の書式・防御的読み取り）
- **Implementation scope**:
  - `export const GEOM3D_PARAM_DESCRIPTORS: ParamDescriptor[]` = 親プラン §4.2 の 12 記述子（`ComponentDef["params"]` と同じ形。`import type { ComponentDef } from "../plugin"`）。
  - `export function parseGeom3DParams(props: Record<string, unknown>): Geom3DParams` — `parseTextProps` と同じ防御的読み取り（型チェック + 既定フォールバック + clamp）。`enabled` は `props["geomEnabled"] === true`。
  - `export const GEOM3D_DEFAULTS` — store が積む初期 props（`geomEnabled: false` ほか §4.2 default）。**staticProp でラップする形は WP-07 で使う**ので、ここでは生 default 値のマップも export。
- **Non-goals**: gradient parse は WP-11。記述子の**登録**はしない（WP-07）。
- **Tests** (`test/geom3d/params.test.ts`): 既定値の往復、欠落 props → 既定、範囲外 clamp（depth<0→0, ambient>1→1）、`geomEnabled` 真偽判定。
- **Commands**: `npm test -- geom3d/params` , `npm run typecheck`
- **Stop conditions**: ParamDescriptor に無い kind が必要になったら停止（設計は既存語彙のみのはず）。
- **Completion report**: 変更ファイル / test 件数 / typecheck。

---

### WP-03 — earcut 導入 + extrudeMesh（純関数・重い部分）

#### Ticket 03-a — earcut 依存追加

- **Owner**: 下位モデル / **Size**: 10 分
- **Purpose**: 三角形分割ライブラリを追加（**§9 で承認済みが前提**）。
- **Allowed files**: `package.json`, `package-lock.json`
- **Forbidden files**: 他すべて
- **Steps**: `npm install earcut@^3.0.0`（MIT）+ `npm install -D @types/earcut`。**`npm install` は playwright を prune しうる**（webgl-video plan の教訓）→ 直後に `node -e "require.resolve('playwright')"`、消えていれば `npm i playwright@<既存版> --no-save` で復帰。
- **Tests/commands**: `npm run typecheck`（earcut が import 可能か最小確認は 03-b で）
- **Stop conditions**: earcut のバージョン競合 / peer 警告が出たら停止し報告。
- **Completion report**: 追加された版・playwright 健在確認・lockfile 差分。

#### Ticket 03-b — extrudeMesh.ts（単位厚メッシュ生成・純）

- **Owner**: 下位モデル（medium 推奨・幾何ロジック中枢）/ **Size**: 30 分
- **Allowed files**: `src/runtime/geom3d/extrudeMesh.ts`（新規）, `test/geom3d/extrude.test.ts`（新規）
- **Forbidden files**: geom3dGl, DomRenderer, resolve
- **Pre-read**: `geom3dTypes.ts`(02-a), `src/runtime/shapePathBoolean.ts`（既存 flatten があれば流用・無ければ本 Ticket で ring flatten は入力前提とする）
- **Implementation scope**:
  - `export function extrudeUnitDepth(glyphs: OutlineGlyph[], opts: { bevelSize: number; bevelSegments: number }): MeshData`
  - 各リングを earcut で三角化 → 前面（z=0）+ 背面（z=1）キャップ。側壁 = リングエッジごとの quad（2 三角形）。ベベル = 輪郭法線オフセット × segments 段（bevelSize=0 なら省略）。
  - 頂点属性を §5.2 どおり焼く: `positions(xy, zNorm∈{0..1})`, `normals`（面法線）, `zNorm`, `faceGroup`(0=front,1=back,2=side,3=bevel/Uint8), `layoutU`（glyph.layoutU を全頂点へ）, `bevelOffset(xy)`。
  - **z は単位（0..1）**。depth 乗算は GL 側 uniform（03-b はキーに depth を含めない）。
- **Non-goals**: WebGL 描画しない。twist/bend/taper しない（P2）。グラデーションしない。
- **Tests** (`test/geom3d/extrude.test.ts`): 単一四角リング → 既知の頂点数/面数（front 2 + back 2 + side 8 三角形など閉式で）、穴付きリング（外周+内周）→ earcut が穴を抜く、bevelSize=0 で側壁のみ、法線の外向き符号、決定論（同入力→同 Float32Array）。
- **Commands**: `npm test -- geom3d/extrude`, `npm run typecheck`
- **Stop conditions**: リング巻き方向（CCW/CW）の規約が outlineProvider 側と食い違いそうなら停止し規約を確定（外周 CCW/穴 CW を本 Ticket の前提として明記）。
- **Completion report**: 面数の閉式・test 件数・決定論確認。

---

### WP-04 — outlineProvider（text 経路のみ・純）

#### Ticket 04-a — ring flatten 共有化

- **Owner**: 下位モデル / **Size**: 20 分
- **Allowed files**: `src/runtime/geom3d/outlineProvider.ts`（新規）, `test/geom3d/outline.test.ts`（新規）
- **Forbidden files**: textRender, textLayout（読むのみ）, DomRenderer
- **Pre-read**: `src/runtime/shapePath.ts`, `src/runtime/shapePathBoolean.ts`（flatten 実装の有無）, `src/runtime/textLayout.ts`（`resolveTextLayout`/`LayoutGlyph`）
- **Implementation scope**: ベジェ path → ポリゴンリングの flatten を純関数化（既存 `shapePathBoolean.ts` に分割があれば re-export・無ければ移設）。分割数は `curveQuality`（low/med/high → 例 8/16/32 セグメント/辺）。
- **Non-goals**: opentype 呼び出しはまだ（04-b）。
- **Tests**: 直線のみ path → 頂点そのまま、ベジェ 1 本 → 分割数一致・決定論。
- **Commands**: `npm test -- geom3d/outline`, `npm run typecheck`
- **Completion report**: 変更ファイル / test。

#### Ticket 04-b — text → OutlineGlyph[]

- **Owner**: 下位モデル（medium）/ **Size**: 30 分
- **Allowed files**: `src/runtime/geom3d/outlineProvider.ts`, `test/geom3d/outline.test.ts`
- **Forbidden files**: DomRenderer（配線は WP-06）
- **Pre-read**: `textRender.ts:215` 付近（`font.getPath(char, x, baseline, size)` の使い方）, `textLayout.ts`（`resolveTextLayout`, `textBaselineY`）, `fontOutlineCache.ts`
- **Implementation scope**:
  - `export function textToOutlineGlyphs(p: TextStyleProps, font: Font, quality): OutlineGlyph[]`
  - `resolveTextLayout` でグリフ配置（既存と同座標）→ 各グリフ `font.getPath(char, g.x-bounds.minX, baseline, size)` → opentype path commands をリングへ（`toPathData` ではなく commands を直接、Q/C を flatten）。
  - `layoutU` = グリフ x を行全幅で正規化（0..1・twist/bend 座標）。`offset` = グリフ原点。
  - **font=null（system フォント）は null 返し**（呼び出し側が 2D フォールバック）。
- **Non-goals**: shape 側（WP-14）。GL 描画しない。
- **Tests**: ビルトイン Noto（`public/fonts` を Node で読める形。test は opentype で直接 parse）で "A" → 1 リング以上・座標が既存 `renderPreciseText` の path と整合（サンプル点一致）、"あ" 等マルチリング、決定論。
- **Commands**: `npm test -- geom3d/outline`, `npm run typecheck`
- **Stop conditions**: opentype path の座標系（y 下向き/上向き）が既存描画と食い違ったら停止し、既存 `renderPreciseText` の baseline 規約に合わせる。
- **Completion report**: 既存 precise path との整合確認方法・test。

---

### WP-05 — geom3dGl（WebGL 描画・単位厚・継承色・lambert）

#### Ticket 05-a — WebGL canvas ライフサイクル

- **Owner**: 下位モデル（medium）/ **Size**: 30 分
- **Allowed files**: `src/runtime/geom3d/geom3dGl.ts`（新規）, `src/runtime/geom3d/geom3dMeshCache.ts`（新規）
- **Forbidden files**: DomRenderer（配線は WP-06）, exporter
- **Pre-read**: 親プラン §2.4/§5.3, `webgl-video-layer-plan.md` §1.2（罠リスト・必読）, `mat4.ts`
- **Implementation scope**:
  - `class Geom3DLayer`: `getCanvas(): HTMLCanvasElement`（1 レイヤー 1 canvas・full-comp サイズ）、`dispose()`。
  - `gl` 取得は `{ premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true }`（**preserveDrawingBuffer 必須** = export 教訓）。
  - program は単位厚版（変形なし）: 頂点は `projection·view·world·(pos.xy, zNorm*depth)`、法線変換、フラグ vary。fragment は継承色 + lambert（`shading==="none"` は素通し）。
  - `geom3dMeshCache`: `getMesh(key, buildFn)` 決定論キー（§5.2）でメモ化。
- **Non-goals**: 変形（P2）・グラデーション（P3）は uniform/シェーダに**箇所だけ確保**して未使用で可。DOM への attach は WP-06。
- **Tests/commands**: `npm run typecheck`（GL は headless で SwiftShader・ユニットテスト困難 → 描画正しさは WP-08 実機 verify で担保）。最小 smoke（任意）: jsdom で canvas 取得が例外を投げないこと。
- **Stop conditions**: WebGL2 前提が必要になったら停止（WebGL1 で書けるはず・確認）。
- **Completion report**: uniform/attribute レイアウト表・確保した将来 uniform（変形/グラデ）。

#### Ticket 05-b — 描画関数（render(resolved, camera, comp)）

- **Owner**: 下位モデル（medium）/ **Size**: 30 分
- **Allowed files**: `src/runtime/geom3d/geom3dGl.ts`
- **Forbidden files**: DomRenderer, exporter
- **Pre-read**: `mat4.ts`（lookAt/perspective/multiply）, spec §6.5b（view/projection 式）, `resolved.ts`（ResolvedObject の worldTransform/camera 形）
- **Implementation scope**:
  - `render(mesh: MeshData, params: Geom3DParams, ctx: { world: Mat4; view: Mat4|null; projection: Mat4|null; compW; compH; baseColor: RGBA })`。
  - camera あり（threeD=true）: 渡された view/projection。camera なし/threeD=false: 既定パース（Q4 回答値・§6.5c）。
  - z 単位 → depth 乗算 uniform、baseColor（text=color / shape=fill）を front/back に、side/bevel は lambert 陰影付き同色。
  - **UV/上下反転に注意**（webgl-video 教訓）。深度テスト ON（自己遮蔽）。
- **Non-goals**: 変形/グラデ本実装は後続。
- **Tests/commands**: `npm run typecheck`。正しさは WP-08 実機。
- **Stop conditions**: view/projection を CSS 側と二重適用しそうな設計に気づいたら停止（canvas はカメラ免除・GL 内のみ、が親プラン §5.3 の確定）。
- **Completion report**: camera 有無の分岐・既定パース値の出所。

---

### WP-06 — DomRenderer 配線（geomEnabled 分岐・draft 降格）

#### Ticket 06-a — content dispatch に geom3d 分岐

- **Owner**: 下位モデル（medium・中枢配線）/ **Size**: 30 分
- **Allowed files**: `src/runtime/DomRenderer.ts`
- **Forbidden files**: exporter, rasterCapture, compFrameCapture（一律変更禁止・分岐は type 内で閉じる）
- **Pre-read**: `DomRenderer.ts:2291`（`case "text"`）・`:2246` 付近（`case "shape"` の位置を確認）・`applyTextEl` 呼び出し・`ObjectEntry`（contentRoot/div・line 121）・カメラ適用（`applyObject` line 1049, `objectWorldTransformWithCamera`）
- **Implementation scope**:
  - `case "text"`（と後の WP-14 で `case "shape"`）内の先頭で `parseGeom3DParams(props).enabled` を判定。
  - **enabled=false**: 既存 `applyTextEl(...)` を**そのまま**通す（差分ゼロ）。残置 geom canvas があれば除去。
  - **enabled=true**: `el` 内に `Geom3DLayer` の canvas を ensure（`ObjectEntry` に `geom3d?: Geom3DLayer` を追加保持）、`outlineProvider`→`meshCache`→`geom3dGl.render`。既存 text DOM/SVG は掃除。canvas は full-comp サイズで `el` 内の座席に置く（`el` の transform/blend/filter/matte は既存経路が触る = 触らない）。
  - camera: `this.cameraPre`/`scene.camera` から view/projection を組み、threeD 判定で渡す（既存 `objectWorldTransformWithCamera` のカメラ有無ロジックを参照）。
- **Explicit non-goals**: 他 case・export 経路・rasterCapture を触らない。blend/filter/matte 配線は既存のまま（canvas はただの DOM 子）。
- **Tests/commands**: `npm run typecheck`。**`npm run build:player`**（DomRenderer が geom3d を import した = ランタイム変更）。実機は WP-08。
- **Stop conditions**: canvas を出すために `el` の transform/blend/z-index を書き換える必要が出たら停止（それは既存経路の責務・侵さない）。
- **Completion report**: 追加した ObjectEntry フィールド・分岐位置行・build:player 実行と `git diff public/player.js` 更新確認。

#### Ticket 06-b — draft 降格（編集中フォールバック）

- **Owner**: 下位モデル / **Size**: 20 分
- **Allowed files**: `src/runtime/DomRenderer.ts`, （品質フラグ源が store なら）読み取りのみ
- **Forbidden files**: store の書き込み経路、他 case
- **Pre-read**: §26.3/§26.4 の `previewQuality`/編集中降格の既存機構（`textQuality` が DomRenderer にどう渡るか）
- **Implementation scope**: 既存の編集中 draft 降格フラグが立つ間は geom3d でも 2D draft を描く（メッシュ再生成のタイプ毎連打回避）。既存 `textQuality`/降格シグナルに相乗り。
- **Non-goals**: 新しい品質モードを足さない。
- **Tests/commands**: `npm run typecheck`, `npm run build:player`
- **Completion report**: 相乗りしたフラグ名。

---

### WP-07 — store 既定 props + Inspector 3D フォールドアウト

#### Ticket 07-a — ComponentDef 登録 + store 既定 props

- **Owner**: 下位モデル / **Size**: 25 分
- **Allowed files**: `src/runtime/builtinComponents.ts`, `src/editor/store.ts`
- **Forbidden files**: DomRenderer, resolve, schema
- **Pre-read**: `builtinComponents.ts`（TEXT/SHAPE_COMPONENT_DEF）, `store.ts:1184 addText`・`:1150 addShape`, `geom3dParams.ts`(02-b)
- **Implementation scope**:
  - `TEXT_COMPONENT_DEF.params` と `SHAPE_COMPONENT_DEF.params` の末尾に `...GEOM3D_PARAM_DESCRIPTORS` を concat。
  - `addText`/`addShape` の初期 props に §4.2 既定を積む（animatable な geom* は `staticProp(default)`、非アニメ `geomEnabled:false`/`geomBevelSegments`/`geomCurveQuality`/`geomShading` は生値）。**geomFaces は積まない**（未設定=継承色）。
  - **後方互換**: 既存プロジェクト（geom* 欠落）は `parseGeom3DParams` が既定補完 → 直列化で strip（既定値は書かない）→ byte 等価。この strip 規則が canonicalize に必要なら §serialize 側（別 Ticket 08 or WP-01 で spec 明記）。
- **Non-goals**: Inspector UI（07-b）。
- **Tests/commands**: `npm test -- store`（既存 addText/addShape テストが壊れないこと・**期待値は変えない**。geom 既定で snapshot がずれるなら既定は strip される設計を確認）, `npm run typecheck`
- **Stop conditions**: 既存 store テストの期待値変更が必要になったら停止（既定 strip で byte 等価にできるはず）。
- **Completion report**: concat 箇所・既定 props・既存テスト無回帰。

#### Ticket 07-b — Inspector 3D フォールドアウト

- **Owner**: 下位モデル / **Size**: 30 分
- **Allowed files**: `src/editor/panels/InspectorPanel.tsx`（or 既存 Text/Shape セクション実体ファイル）
- **Forbidden files**: DomRenderer, store コマンド定義（既存 updateObject/setKeyframe 経路を使う）
- **Pre-read**: InspectorPanel の Text セクション実装、既存 PropRow/ScrubNumber/ストップウォッチ配線、§26.3 のフォーム
- **Implementation scope**: text/shape 選択時に "3D" フォールドアウト追加。`geomEnabled` トグル → ON で Depth/Bevel Size/Bevel Segments/Curve Quality/Twist/Bend/Taper/Shading/Light/Ambient を既存 PropRow で表示（flat param なので汎用行が使える）。書き込みは既存 `updateObject`/`setKeyframe`。
- **Non-goals**: グラデーションエディタ（WP-13）・ギズモ。
- **Tests/commands**: `npm run typecheck`。UI 目視は human/実機。
- **Completion report**: 追加フィールド・使った既存行コンポーネント。

---

### WP-08 — export/bundle parity + build:player + 回帰ゲート

#### Ticket 08-a — export 経路の canvas インライン確認

- **Owner**: 下位モデル（medium）/ **Size**: 30 分
- **Allowed files**: `verify-geom3d-export.mjs`（新規・使い捨て可）, 必要なら export 経路の**型別分岐のみ**（`exporter.ts`/`rasterCapture.ts` に geom canvas を含める最小対応があれば）
- **Forbidden files**: export の一律挙動変更（他型に影響する変更）
- **Pre-read**: 既存の canvas → dataURL インライン化経路（`inlineCanvasBitmaps` 相当が webgl-video 由来で残っているか grep）、`exportComposite.ts`, spec §11.2
- **Implementation scope**: geom3d canvas が mp4/webm/PNG 連番/bundle でインライン取り込みされるか検証。`preserveDrawingBuffer` により既存 canvas インライン経路に乗るはず。乗らない箇所だけ**型別**に最小補填。
- **Non-goals**: 全 export の挙動変更。
- **Tests/commands**: 新規 `verify-geom3d-export.mjs`（Playwright・押し出しテキスト 1 枚を preview と export で撮り画素比較）, `npm test -- <export/raster/bundle 系>`
- **Stop conditions**: 共有 capture を一律変更しないと通らない設計に気づいたら停止し Claude に相談（片経路回帰リスク）。
- **Completion report**: 各書き出し形式の parity 結果（画素差%）。

#### Ticket 08-b — 既存 export 回帰ゲート

- **Owner**: 下位モデル / **Size**: 20 分
- **Allowed files**: なし（実行と報告のみ）
- **Pre-read**: CLAUDE.md「新描画レイヤーオブジェクトの export 正常化」節
- **Steps**: 既存 `verify-*-export*.mjs` の該当群 + solid+text+image のみコンプ + blend/調整/fast displacement + bundle bake 件数 + `npm test` フルスイートを回し、**geom OFF で全て変更前と一致**を確認。
- **Non-goals**: 失敗を「無関係」と自己判断して握りつぶさない（既知 flake `test/projectBins.test.ts` のみ progress.md 記録に従い許容）。
- **Tests/commands**: 上記一式
- **Stop conditions**: geom と無関係な既存 verify が落ちたら停止し報告。
- **Completion report**: 各 verify の PASS/FAIL・回帰有無。

#### Ticket 08-c — build:player + progress 更新

- **Owner**: 下位モデル / **Size**: 10 分
- **Allowed files**: `public/player.js`（生成物・commit 対象）, `progress.md`
- **Steps**: `npm run build:player` → `git diff public/player.js` で更新確認 → `playerBuildFreshness` test 緑（**緑を鵜呑みにせず diff を目視** = webgl-video 教訓）→ progress.md に P1 完了記録。
- **Tests/commands**: `npm run build:player`, `npm test -- playerBuildFreshness`
- **Completion report**: player.js 更新確認・progress 追記。

---

### WP-09 — geomDeform（CPU 参照・純）

#### Ticket 09-a — twist/bend/taper CPU 実装

- **Owner**: 下位モデル / **Size**: 25 分
- **Allowed files**: `src/runtime/geom3d/geomDeform.ts`（新規）, `test/geom3d/deform.test.ts`（新規）
- **Forbidden files**: geom3dGl（シェーダ配線は 10）
- **Pre-read**: 親プラン §5.3、Q2 の bend モデル回答
- **Implementation scope**: `deformVertex(pos: Vec3, layoutU: number, p: {twist;bend;taper}): Vec3` — taper(奥ほど縮小/拡大) → twist(layoutU に沿って twist° 回転) → bend(ベースライン円弧写像)。GLSL と**完全一致する数式**で（後で頂点シェーダの検算基準にする）。
- **Non-goals**: GL に載せない。
- **Tests**: twist=0/bend=0/taper=0 で恒等、twist=90° の既知点、bend=360° で円環化の端点一致、決定論。
- **Commands**: `npm test -- geom3d/deform`, `npm run typecheck`
- **Completion report**: 数式・test。

#### Ticket 09-b — （予備）変形合成順の固定 test
- 上記に含めて可。合成順（taper→twist→bend）の確定を test で固定。

---

### WP-10 — シェーダ変形 uniform 配線 + KF 検証

#### Ticket 10-a — 頂点シェーダに変形を実装

- **Owner**: 下位モデル（medium）/ **Size**: 30 分
- **Allowed files**: `src/runtime/geom3d/geom3dGl.ts`
- **Forbidden files**: DomRenderer（uniform を渡すのは既存 render 経由）
- **Pre-read**: 09-a の数式, 05-b の render 署名
- **Implementation scope**: WP-05 で確保した変形 uniform（twist/bend/taper）を頂点シェーダで適用。**09-a の CPU 実装と数式一致**。`render` に params.twist/bend/taper を渡す。
- **Non-goals**: グラデ（P3）。
- **Tests/commands**: `npm run typecheck`, `npm run build:player`。数式一致は 10-b。
- **Completion report**: GLSL と CPU の対応表。

#### Ticket 10-b — KF・数式一致 verify

- **Owner**: 下位モデル / **Size**: 20 分
- **Allowed files**: `verify-geom3d-deform.mjs`（新規）
- **Steps**: (1) 頂点を `gl.readPixels` or transform feedback ではなく、既知頂点をシェーダ経由で描いた位置と 09-a CPU 出力を突き合わせ（実機 Playwright）。(2) twist/bend/taper に KF を打ち scrub → メッシュ再生成が起きない（uniform のみ更新）ことをカウンタで確認。(3) preview≡export を 1 フレーム画素比較。
- **Human verification**: 実 Chrome + 実ドラッグ perf（60fps 近傍・キャッシュ再生成ゼロ）は human 判定（Codex 自己宣言しない）。
- **Commands**: 上記 verify + `npm test`
- **Completion report**: 数式一致・再生成ゼロ・parity。

---

### WP-11〜13（P3 グラデーション・要約）

- **WP-11 T11-a/b** `gradientFill.ts` + `test/geom3d/gradient.test.ts`: `parseGradientFill`（防御的）、stop を offset 昇順 LUT 化、linear/radial/conic/depth の評価純関数、KF 補間（stop 本数固定）。Allowed: geom3d/gradientFill.ts, test。Forbidden: GL/DomRenderer。
- **WP-12 T12-a/b** シェーダ配線 + 直列化: `geom3dGl` fragment で `geomFaces` を faceGroup 別に評価（≤8 stop uniform 配列 or 1D テクスチャ）。`resolve.ts` に `geomFaces` の解決追加（**shape vertices と同じ「構造化 prop を resolveComponent が解く」前例に従う**・resolve の既存挙動は変えない）。直列化規則（面キー存在時のみ/stop 順保存/既定 strip）を `serialize.ts`/`canonicalize` に**型別**追加。Allowed: geom3dGl.ts, resolve.ts(追加のみ), core/serialize.ts。Forbidden: 既存直列化の一律変更。Tests: round-trip byte 等価（geomFaces 無=既存等価）, preview≡export。build:player 必須。
- **WP-13 T13** グラデーションエディタ UI: Inspector に面タブ + stop バー + 既存カラーピッカー。stop offset/color の KF は ShapeVertex 専用ストップウォッチ配線を流用。Allowed: InspectorPanel + 新規 GradientEditor.tsx。Forbidden: store コマンド新設（既存経路）。

---

### WP-14〜15（P4 shape 統合・要約）

- **WP-14 T14-a/b** `outlineProvider` の shape 実装: rect/ellipse をパラメトリック輪郭化、`kind="path"` の `vertices`/`rings`、`kind="merge"` の `resolvedMergeRings`（resolve 済み・§5.5d）を `OutlineGlyph`（offset=0,0/layoutU=0）へ。`buildShapePathD` と同じ flatten を共有（WP-04a）。Allowed: geom3d/outlineProvider.ts, test。Forbidden: DomRenderer。Tests: 各 kind の輪郭・merge 穴の巻き方向。
- **WP-15 T15** shape ComponentDef へ concat（WP-07a で text と同時にやっていれば shape 分岐の DomRenderer `case "shape"` に 06-a と同じ geomEnabled 分岐を追加するだけ）+ 回帰ゲート（shape の既存 rect/ellipse/path/merge/rings export 無回帰）。build:player 必須。

---

## 4. build:player（必須・毎回）

DomRenderer が `src/runtime/geom3d/*` を import する WP-06 以降、**ランタイム変更**に該当。各 WP の最終 Ticket で:

1. `npm run build:player` を Codex 自身が実行（失敗したら修正して再実行）。
2. `git diff public/player.js` で更新を目視確認（**`playerBuildFreshness` の緑を単独で信用しない** = webgl-video plan §1.2 の教訓）。
3. HTML bundle export を触った WP は bundle verify も実行。

mp4/webm/PNG export と preview は `src/runtime` を直接 import するため player.js 不要。**player.js が要るのは HTML bundle export のみ**だが、runtime 変更時は常に再ビルドして diff 確認する運用にする。

---

## 5. Codex prompt テンプレート（そのまま貼れる形）

### 例: Ticket 03-b（extrudeMesh）

```
Implement only Ticket 03-b (extrudeMesh.ts). Read doc/cloudplan/3d-text-extrusion-implementation.md WP-03 for full spec.

Allowed files:
- src/runtime/geom3d/extrudeMesh.ts (new)
- test/geom3d/extrude.test.ts (new)

Forbidden:
- Do NOT edit geom3dGl.ts, DomRenderer.ts, resolve.ts, exporter.ts
- Do NOT change existing tests
- Do NOT implement twist/bend/taper (that is P2) or gradients (P3)
- Do NOT render WebGL

Goal:
Pure function extrudeUnitDepth(glyphs, {bevelSize, bevelSegments}) -> MeshData.
z is UNIT (0..1); do NOT multiply by depth here. Ring winding: outer CCW, holes CW.
Bake vertex attributes: positions(xy,zNorm), normals, zNorm, faceGroup(0front/1back/2side/3bevel), layoutU, bevelOffset.

Run:
- npm test -- geom3d/extrude
- npm run typecheck

Stop if:
- You need to edit files outside the allowed list
- Ring winding convention conflicts with outlineProvider (stop and confirm the CCW/CW rule)

Report:
- Changed files
- Face-count closed form for a square ring
- Tests run + pass count
- Typecheck result
- Blockers

Do not continue to the next ticket.
```

### 例: subagent（read-only 偵察・Ticket 06-a 前）

```
Read-only reconnaissance. Do not edit any file.

Investigate for Ticket 06-a in src/runtime/DomRenderer.ts:
1. The content dispatch switch — exact line of `case "text"` and `case "shape"`
2. How applyTextEl is called and what `el` is (contentRoot vs div)
3. ObjectEntry interface fields (where a per-layer canvas handle could live)
4. How camera view is applied per object (objectWorldTransformWithCamera, cameraPre)
5. Where residual per-type DOM is cleaned up when switching content

Output:
- Line numbers + short quotes
- ObjectEntry field list
- Camera application call sites
- Risks for adding a geomEnabled branch without touching export/rasterCapture

Do not write code. Do not modify tests. Do not decide exceptions.
```

---

## 6. Review チェック（各 Codex Ticket 完了後・Claude 実施）

- [ ] allowed files だけ触ったか / forbidden を触っていないか
- [ ] geom OFF で既存挙動・直列化が byte 等価か（既存テスト無回帰）
- [ ] 共有 capture/export/resolve を**一律**変更していないか（型別オプトインか）
- [ ] 既存テスト期待値を勝手に変えていないか
- [ ] runtime 変更 Ticket で `npm run build:player` を実行し `git diff public/player.js` を確認したか
- [ ] human 判定（実機 perf・見た目・parity 最終）を Codex が自己宣言していないか
- [ ] 次 Ticket へ勝手に進んでいないか
- [ ] WP 完了時に progress.md を更新したか

---

## 7. 参照

- 設計（なぜ）: [3d-text-extrusion-plan.md](3d-text-extrusion-plan.md)
- per-layer GL 原則 / 罠リスト: [webgl-video-layer-plan.md](webgl-video-layer-plan.md) §1
- 配線チェックリスト: [.claude/skills/add-layer-component-type/SKILL.md](../../.claude/skills/add-layer-component-type/SKILL.md)
- 実装ループ: [.claude/skills/implementation-loop/SKILL.md](../../.claude/skills/implementation-loop/SKILL.md)
- 視覚デバッグ: [.claude/skills/debug-visual-render-bug/SKILL.md](../../.claude/skills/debug-visual-render-bug/SKILL.md)
- コード入口: `builtinComponents.ts` / `store.ts:1184,1150` / `DomRenderer.ts:2291` / `textLayout.ts` / `textRender.ts:215` / `resolve.ts:198` / `mat4.ts` / `shapePath.ts`
