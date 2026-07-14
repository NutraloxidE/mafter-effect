# PLAN — pixelStretch `linePos` を ink（実塗り）基準にする

対象 Issue: [ISSUE.md](ISSUE.md)（原因確定済み: `linePos` が layer box 基準で、塗りの透明パディング分だけ原点方向へズレる）
方針: **修正案 (A) contentBox 方式**を採用。ただし将来型でズレが再発しない設計に調整済み（下記 D-1〜D-5）。
実装担当想定: Sonnet 5 (low)。**WP を上から順に、1 WP = 1 コミット**で進める。各 WP の「完了条件」を満たすまで次へ進まない。

---

## 設計決定（この PLAN の正・実装中に変えない）

### D-1. ink は「型知識」ではなく「ピクセル」から測る（将来型ドリフト防止の要）

font metrics（A-lite）や 3D bitmap の余白計算のような **per-type の ink 算出は一切書かない**。
`SourceGraphic` としてフィルタが実際に見るラスタ（foreignObject capture / backdrop ラスタ）の
**alpha bbox** を、共有純関数 1 個で測る。

- 新しいコンポーネント型（shape / 将来の何か）が増えても、ラスタに乗る限り**自動的に正しい contentBox が出る**。`c.type` 分岐ゼロ。
- CLAUDE.md「新描画レイヤーオブジェクトの export 正常化」の「片経路だけ壊れる」対策と同型: 共有コードは最小・純関数、型別分岐なし。

### D-2. エフェクト側はフラグでオプトイン

`EffectDef` に `needsContentBox?: boolean` を追加。測定コスト（ラスタ化）は
**チェーン内に needsContentBox な enabled エフェクトがあるレイヤーだけ**発生させる。
将来 contentBox を使いたいエフェクトはフラグ 1 個で乗れる（測定コードを再実装しない）。

### D-3. INV-2 は「同じ関数・同じラスタ」で構造的に満たす

preview と export の両方が **同じ capture ヘルパ（`captureElementToCanvas`）＋同じ `alphaBBox`** から
contentBox を得る。値の突き合わせではなく経路共有で一致させる。
AA ゆらぎ対策として alpha 閾値（`>= 8`）＋整数量子化（floor/ceil で外側に丸め）を必須にする。

### D-4. フォールバック = 現状挙動

`ctx.contentBox` が無い/測定未完/測定失敗のときは**従来の box 基準**で描く（真っ黒・無描画にしない）。
プレビューは測定完了時に再適用（既存 rasterChain の settle パターンと同じ）。export は測定を await して決定論を守る。

### D-5. `basis` パラメータで旧挙動と調整レイヤーの逃げ道を残す

pixelStretch に `basis: "ink" | "box"`（default `"ink"`, animatable: false）を追加。
- 既存プロジェクトの見た目を厳密に維持したい場合は `"box"` に戻せる。
- 調整レイヤーで「下の全内容の union bbox」が意図と違う場合の escape hatch にもなる。
- effects props は free-form なので **§5 スキーマ変更・project.json 直列化変更には該当しない**。
  `EffectRenderCtx` への optional field 追加はプラグイン ctx 拡張（ISSUE で要確認と記載済み → 本 PLAN 依頼で承認済み扱い。spec §27.3 と plugin API 節へ追記する）。

---

## WP-1: 純関数コア（contentBox 計算 + line マッピング）

**ファイル: 新規 `src/runtime/contentBox.ts`**

```ts
export interface ContentBox { x: number; y: number; w: number; h: number; }

/** RGBA バッファの alpha>=threshold な画素の bbox。無ければ null。外側整数丸め。 */
export function alphaBBox(
  data: Uint8ClampedArray, w: number, h: number, threshold = 8,
): ContentBox | null;
```

- 実装: 全画素走査で minX/minY/maxX/maxY。`w = maxX - minX + 1` 等。純関数・DOM 禁止（INV-1 準拠のヘルパ扱い）。

**ファイル: `src/runtime/effectSvg.ts`**

- `PixelStretchOpts` に `content?: ContentBox` を追加（optional）。
- `pixelStretchDisplaceMaps` の `line` 計算（現 `effectSvg.ts:183`）を変更:

```ts
const c0 = horiz ? (opts.content?.x ?? 0) : (opts.content?.y ?? 0);
const cn = horiz ? (opts.content?.w ?? n) : (opts.content?.h ?? n);
const line = Math.round(c0 + clamp01(opts.linePos) * cn);
```

- 帯・target の式はそのまま（`line` の定義だけ変わる）。`line` が `[0,n)` を外れうるので
  `target[i]` 計算前に `line` を `[0, n-1]` に clamp する（content が box 外にはみ出すことは無いが防御）。

**テスト: 新規 `test/contentBox.test.ts` + `test/pixelStretchInk.test.ts`（既存 pixelStretch テストがあればそこへ追記）**

1. `alphaBBox`: 全透明 → null / 単一画素 / 中央矩形 / threshold 境界。
2. `pixelStretchDisplaceMaps` に `content={x:30,y:0,w:340,h:...}` を渡し、`linePos=0.15` で
   `line = round(30 + 0.15*340) = 81`（box 基準 60 ではない）ことをマップのデコードで検証。
   ISSUE の「centered diamond lp=0.15 → −21px」ケースを数値で固定。
3. `content` 未指定 → 従来値と bit 同一（回帰ゲート）。

**完了条件:** `npm test` 緑。`content` 未指定時の stage1/stage2 出力が変更前と一致。

---

## WP-2: チェーン配線（EffectDef フラグ + ctx 拡張）

**ファイル: `src/runtime/plugin.ts`**

- `EffectRenderCtx` に追記:

```ts
/** §27.3 — SourceGraphic の実塗り(alpha) bbox。ctx.width/height と同じレイヤーローカル px。未測定なら undefined。 */
contentBox?: ContentBox;
```

- `EffectDef` に `needsContentBox?: boolean;` を追加（コメント: 「true なら chain 側が SourceGraphic の ink bbox を測って ctx.contentBox に入れる。未対応経路では undefined のまま＝box フォールバック」）。

**ファイル: `src/runtime/effectChain.ts`**

- `resolveEffectChain` の戻り値（chain オブジェクト）に `needsContentBox: boolean` を追加:
  enabled なエフェクトのうち `def.needsContentBox === true` が 1 つでもあれば true。
  （実装は `hasDisplacementFx` と同じ集計パターンを踏襲。）

**ファイル: `src/runtime/fastEffects.ts`（`PIXEL_STRETCH_EFFECT_DEF`）**

- `needsContentBox: true` を追加。
- params に `{ key: "basis", label: "Basis", kind: "enum", default: "ink", animatable: false, options: ["ink", "box"] }` を追加。
- `apply` 内:

```ts
const basis = str(props["basis"], "ink");
const content = basis === "ink" ? ctx.contentBox : undefined;
return { kind: "svg", primitives: pixelStretchPrimitives({ w, h, direction, linePos, length, density, content }) };
```

**完了条件:** typecheck 緑。`ctx.contentBox` 未設定の状態で既存の pixelStretch 出力が変わらない（WP-1 のテストで担保）。

---

## WP-3: DomRenderer — 通常レイヤーの contentBox 測定・キャッシュ・settle

**ファイル: `src/runtime/DomRenderer.ts`（`applyEffects`、[DomRenderer.ts:1315](../../src/runtime/DomRenderer.ts#L1315) 付近）**

1. `ObjectEntry` にフィールド追加:
   - `contentBox: ContentBox | null` — 測定済み値。
   - `contentBoxKey: string | null` — 測定時のコンテンツ署名。
   - `contentBoxInFlightKey: string | null` — 測定中の署名（多重 capture 防止）。
2. コンテンツ署名 `cbKey` は「フィルタ入力が変わったら変わる」もの: `` `${entry.fxLayerW}x${entry.fxLayerH}:${contentSignature}` ``。
   `contentSignature` は entry.children の `outerHTML` 長ハッシュ等ではなく、**既存にコンテンツ変更検知の署名があればそれを再利用**（`updateComponentEl` 系の props 署名）。無ければ `entry.children` の `innerHTML` を `fnv1a` した文字列で新設（ヘルパは contentBox.ts に置く）。video/画像フレームで毎フレーム変わる型はハッシュが安定しない → その場合はフレームを含めず「サイズ＋components props 署名」を使う（**毎フレーム再測定は禁止**。動画の ink が動くケースは box フォールバックでよい、と JSDoc に明記）。
3. `applyEffects` 内、`resolveEffectChain` を呼ぶ**前**に:

```ts
if (!obj.isAdjustment && chainNeedsContentBox(effects)) {   // 事前判定ヘルパ: enabled で def.needsContentBox
  if (entry.contentBoxKey === cbKey) {
    ctx.contentBox = entry.contentBox ?? undefined;
  } else if (entry.contentBoxInFlightKey !== cbKey) {
    entry.contentBoxInFlightKey = cbKey;
    void this.measureContentBox(entry, cbKey);  // 完了時に entry へ格納し、このオブジェクトの effects 再適用を要求
  }
  // miss 中は ctx.contentBox = undefined（box フォールバック描画）
}
```

4. `measureContentBox(entry, key)`: `captureElementToCanvas`（[rasterCapture.ts:193](../../src/runtime/rasterCapture.ts#L193)）で `entry.div` の子コンテンツを **filter 無しの状態で** native scale capture → `getImageData` → `alphaBBox`。フィルタが既に付いた div を capture すると変位後を測ってしまうため、**capture 対象は `entry.children` を包む内側要素（フィルタ適用前の DOM）**にする。既存 rasterChain がどの要素を capture しているかを確認し、同じ「フィルタ前ソース」取り方を踏襲する。完了時: `entry.contentBox = bbox; entry.contentBoxKey = key; entry.contentBoxInFlightKey = null;` として、既存の rasterChain 完了時と同じ再適用トリガ（`rasterCompletedKey` 系が使っている再 render 要求）を叩く。失敗時は `entry.contentBox = null; entry.contentBoxKey = key;`（= box フォールバック確定、リトライループ禁止）。
5. **fxSig に contentBox を混ぜる**（重要）: [DomRenderer.ts:1317](../../src/runtime/DomRenderer.ts#L1317) の `fxSig` に `:cb=${entry.contentBoxKey === cbKey && entry.contentBox ? `${x},${y},${w},${h}` : "none"}` を連結。これが無いと測定完了後も古いフィルタ（box 基準）が使い回される。

**完了条件:** dev サーバ + [measure-tilted.mjs](measure-tilted.mjs) 相当で、centered diamond `linePos=0.15` の bias が **−21 → 0±1px** になる。full solid は全 linePos で 0 のまま（回帰）。

---

## WP-4: 調整レイヤー（ユーザー報告の実ケース）— backdrop ink

**ファイル: `src/runtime/DomRenderer.ts`**

- 調整レイヤーは `ctx = comp サイズ`＋SourceGraphic = 下の合成 backdrop（`fxUseBackdropDisplace` 経路）。
  contentBox の測定元は **backdrop ラスタ**。既存の backdrop displace 経路が backdrop を canvas 化している箇所を特定し（`fxUseBackdropDisplace` の消費側、[effectRaster.ts](../../src/runtime/effectRaster.ts) / exportComposite）、その **同じ canvas** に `alphaBBox` を掛けて ctx.contentBox とする。
- backdrop は下レイヤーのアニメで毎フレーム変わりうる → 署名は「フレーム＋下レイヤー集合の resolved 署名」になり毎フレーム再測定になりがち。**コスト上限ルール:** backdrop canvas が既にその経路で生成されている場合のみ測る（追加 capture を発生させない）。live preview で backdrop canvas が無い経路（純 backdrop-filter）では測定不能 → `basis:"ink"` でも box フォールバックし、export（canvas がある）で ink が効く……は **INV-2 違反**になるため不可。
  → **決定:** 調整レイヤーの live preview 側にも export と同じ backdrop ラスタ測定を入れられる場合のみ ink を有効化。入れられない（preview が真の backdrop-filter で raster を持たない）場合、調整レイヤーは **preview/export とも box 基準に固定**し、Inspector の `basis` ツールチップに「調整レイヤーでは box 基準」と明記する。実装時にどちらかを確認してから進み、判断結果を PLAN 末尾に追記する。

**完了条件:** 調整レイヤー + pixelStretch のシナリオで preview と export（mp4 1 フレーム）の帯位置が一致（INV-2）。ズレ改善が入る場合は [measure-editor-bbox.mjs](measure-editor-bbox.mjs) 系で bias≈0 を確認。

---

## WP-5: export 全経路の決定論と無回帰

1. **exporter の settle:** export ループには既に rasterChain 完了待ちがある（`rasterCompletedKey` を待つ箇所を `exporter.ts` / `compFrameCapture.ts` で特定）。同じ待ち条件に「chain が needsContentBox なら `contentBoxKey === cbKey` になるまで再 render」を追加。**export は絶対にフォールバック値でフレームを確定しない。**
2. **nested comp 経路:** [DomRenderer.ts:2042](../../src/runtime/DomRenderer.ts#L2042) と `applyNestedLiveEffects` の ctx 生成にも contentBox を配線（通常レイヤー分。調整は WP-4 の決定に従う）。
3. **回帰ゲート（CLAUDE.md 必須リスト）:**
   - `npm test`（export / raster / bundle 関連含む）
   - 既存 `verify-*-export*.mjs`・blend / 調整 / fast displacement 系
   - solid+text+image のみコンプの export（pixelStretch 無し → 測定コード自体が走らないこと＝ `needsContentBox` オプトインの確認）
   - [measure-directions.mjs](measure-directions.mjs) / [measure-live-path.mjs](measure-live-path.mjs)（full-box ソースなので ink==box、従来どおり bandSrcMinusLine=0 のはず）
4. **INV-2 検証:** 同一 comp・同一フレームで preview screenshot と mp4/PNG export の帯開始列を画素比較（既存 measure スクリプトの手法を流用、新規 `verify-pixelstretch-ink.mjs` としてこのフォルダに置く）。

**完了条件:** 上記すべて緑。既存シナリオの PASS を置き換えない（新 verify は追加）。

---

## WP-6: spec / player / 記録

1. `doc/mafter-effect-spec.md` §27.3 pixelStretch 節: `basis` param と「linePos は ink bbox 基準（basis=box で旧挙動）」を追記。plugin API 節（EffectRenderCtx）に `contentBox` と `needsContentBox` を追記。**§5 / INV 表は触らない。**
2. **`npm run build:player` を必ず実行**（`src/runtime/` を触るため。CLAUDE.md 必須手順。`playerBuildFreshness` が通ること）。HTML bundle export で pixelStretch+ink が効くことを 1 ケース確認。
3. `progress.md` 更新: 完了内容・WP-4 の判断結果・既知の制限（動画レイヤーの ink 追従なし、調整レイヤーの basis 扱い）。
4. Inspector（UI）: `basis` enum は params 定義から自動で出るはず。出ない場合のみ effects UI の enum 対応を確認。

---

## やらないこと（スコープ外・明記）

- font metrics による text 専用補正（A-lite）— D-1 と重複するため実装しない。
- 動画フレームごとの ink 追従（毎フレーム再測定）— 禁止。box フォールバック。
- 他の displacement 系エフェクト（wave 等）への contentBox 適用 — フラグを立てれば乗れる状態にするだけで、本件では pixelStretch のみ。
- §5 スキーマ・project.json 直列化の変更 — 一切なし。
