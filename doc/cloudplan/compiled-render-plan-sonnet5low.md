# Compiled RenderPlan / 差分更新ランタイム — 実現可能性評価 & Sonnet 5 low 向け実装 PLAN

> 対象: 「resolve → ResolvedScene 全生成 → DomRenderer 全走査を毎フレーム」構造の軽量化。
> 出典: 他エージェントからのフィードバック（"Compiled RenderPlan + Dirty Property Patching"）。
> 本書は **① フィードバックを実際の spec / 実装と突き合わせた実現可能性評価** と、
> **② その中で Sonnet 5 low が安全に実装できる部分だけを切り出した逐語 PLAN** の 2 部構成。
>
> **前提（絶対）:** spec §5 データスキーマ・INV-1〜INV-6・`project.json` 直列化形式は**一切変更しない**。
> 本タスクは純粋な**ランタイム内部の描画経路最適化**であり、出力（preview / export / bundle）は
> 変更前と**視覚的に等価**でなければならない（INV-2）。§5/INV に触れる案は下記で明示的にスコープ外にする。

---

## 0. TL;DR（結論）

- フィードバックの**方向性は正しく、最優先ターゲットの選定（nested comp の毎フレーム DOM 再構築を廃止）も的確**。ただし全体像（Compiled RenderPlan + DirtyMask + allocation-free typed buffer + tree-shaken bundle）は**数週間規模のアーキテクチャ移行**で、INV-2 回帰リスクが高く **Sonnet 5 low の 1 タスクには不適**。
- 重要な事実誤認の補正: フィードバックの **WP-1「DomRenderer の全 entry を objectId で永続化」は、トップレベルでは既に実装済み**。`DomRenderer.entries: Map<ObjectId, ObjectEntry>`（`src/runtime/DomRenderer.ts:122`, `:428`, `:457`）が GC + 再利用 + `childSig` reconcile を既に行い、`<img>` src も変化時のみ書く（`:1200` 付近）。**トップレベルをやり直してはならない。**
- **本当の負債は nested comp 経路**にある。`renderNestedComp`（`:2037`）は**毎フレーム `container.innerHTML = ""`（`:2066`）**して全ラッパ `<div>` を作り直す。WebGL context 枯渇を避けるため **text/video/geom3d canvas/comp だけを reuseKey で持ち越す**特殊対応が既にあり（`:2110`, `:2130`）、フィードバックの「3D だけ特殊持ち越し → 汎用 reconcile 化の余地」という指摘は**実装と一致する**。
- **Sonnet 5 low が実装すべき安全な部分集合:**
  1. **WP-4（先行・低リスク）**: last-value 比較でトップレベルの同値 style 書き込みを抑制（出力バイト等価）。
  2. **WP-2（本命・中リスク）**: `renderNestedComp` を「objectId キーのラッパ div 永続化 + reconcile」へ移行し、`innerHTML=""` を廃止。トップレベルの `entries` reconcile モデルをネストへ移植する。
- **スコープ外（やらない）**: WP-3/WP-5（並行 `evaluateFrame`/DirtyMask/typed buffer）、WP-6（feature manifest + tree-shaken bundle）。理由は §2。

---

## 1. 現状パイプライン（コミット確認済み・file:line）

```
performPreviewRender / exporter / compFrameCapture / BundlePlayer （毎frame）
  → resolve(comp, frame, ctx)                         // src/runtime/resolve.ts:300  純関数(INV-1) 新規 ResolvedScene を毎frame生成
  → DomRenderer.renderFrame(scene, frame)             // src/runtime/DomRenderer.ts:373
     ├ this.entries を reconcile（GC/再利用）          //   :428 離脱GC / :457 再利用or生成 / :491 set
     ├ applyObject(entry, obj, ...)                    //   :1096 host style を毎frame無条件書き込み
     │    entry.div.style.transform/opacity/zIndex = … //   :1133-1135（← WP-4 対象: 同値でも毎frame書く）
     │    childSig 変化時のみ子要素を作り直す           //   :1173-1198（既に reconcile 済み）
     └ comp component → renderNestedComp(el, …)        //   :1248-1256
          → container.innerHTML = ""                   //   :2066（← WP-2 対象: 毎frame 全破棄）
          → childScene = resolve(childComp, …)          //   :2048 子comp も毎frame resolve
          → 全 obj について div を new + style 設定       //   :2087-2160
          → text/video/geom3d/comp だけ reuseKey 持ち越し//   :2110, :2130, nestedElReuse WeakMap :2004
```

### 既に最適化済み（＝再実装しない）

| フィードバック WP | 状態 | 根拠 |
|---|---|---|
| WP-1 entry を objectId 永続化 | **トップレベル済み** | `entries: Map`（`:122`）、reconcile（`:428`/`:457`） |
| 子要素 reconcile（型変化時のみ再構築） | **トップレベル済み** | `childSig`（`:1173`）、`<img>` src 変化時のみ（`:1200`付近） |
| geom3d canvas 持ち越し（context 保護） | **済み（トップ・ネスト両方）** | `:445`, `:2078`, `nestedGeom3dGroups`（`:2008`） |

### 未最適化（＝本タスクの標的）

| WP | 症状 | 位置 |
|---|---|---|
| **WP-4** | トップレベル host の `transform/opacity/zIndex` を**同値でも毎frame書く**（style invalidation を誘発） | `applyObject` `:1133-1135` |
| **WP-2** | nested comp が**毎frame `innerHTML=""` + 全ラッパ div 再生成** | `renderNestedComp` `:2066`, `:2087-2160` |

---

## 2. 実現可能性評価 — フィードバック各 WP の採否

| WP（フィードバック） | 採否 | 理由 |
|---|---|---|
| WP-1 entry を objectId 永続化 | **不要（済）** | トップレベルは実装済み。ネストは WP-2 に内包。 |
| **WP-2 nested を reconcile 化** | **採用（本命）** | 実在する構造的負債。単一メソッドに閉じる。INV-2 は「出力等価」を verify で守れる。 |
| WP-3 static/animated/expression の事前分類 | **スコープ外** | RenderPlan コンパイラ新設が必要。resolve() と二重の解決経路になり INV-2 の bit 一致維持が難しい（CLAUDE.md「片経路だけ壊れる」ハザード）。 |
| **WP-4 last-value で同値書込抑制** | **採用（先行・低リスク）** | 小さく局所的・出力バイト等価。WP-2 の前に足場として入れる。 |
| WP-5 allocation-free ResolvedFrameBuffer / DirtyMask（Uint32Array） | **スコープ外** | resolve() を「Scene生成」から「buffer更新」へ寄せる大改修。INV-1/INV-2 の全経路一致を崩すリスク大。Sonnet 5 low 不適。 |
| WP-6 feature manifest + tree-shaken bundle runtime | **スコープ外** | `bundleExporter`/`player` ビルドを触り、全 bundle export verify の回帰面が広い。転送サイズ最適化であって再生本丸ではない（フィードバック自身も末尾でそう述べている）。 |

### なぜ WP-3/5/6 を Sonnet 5 low でやらないか（明確な線引き）

- **INV-2 の二重経路リスク**: preview・browser export・bundle は**同一 `resolve()`** を共有することで frame 一致を担保している。`evaluateFrame(plan, frame, buffer)` を新設すると、`resolve()` と**別の**解決経路が生まれ、両者を bit 単位で永遠に一致させ続ける保守コストが発生する。これは CLAUDE.md「新描画レイヤー…export 正常化」で警告される「共有パイプラインを変えると触っていない経路だけ静かに壊れる」典型。
- **spec 整合**: RenderPlan/DirtyMask を `project.json` に直列化するわけではないので §5 型変更には**当たらない**が、`ResolvedScene`（§8 / `resolved.ts`）を返す純関数という INV-3 の契約に**並行経路**を足すのは設計判断であり、**着手前にユーザー確認が必要な領域**（CLAUDE.md 運用体制）。よって本 Sonnet 5 low PLAN からは外す。
- WP-2 と WP-4 は**いずれも `resolve()` / `ResolvedScene` / §5 型に一切触れず**、`DomRenderer` 内の DOM 適用のみを変える。だから安全。

> WP-3/5/6 を将来やるなら、それは別タスク・別 spec 追記（§ に「RenderPlan コンパイル層」を定義）から始めるべきで、実装前にユーザーへ選択肢提示。本書では扱わない。

---

## 3. 影響経路（触る前に把握・必須）

`renderNestedComp` と `applyObject` は **DomRenderer = 共有描画コア**。CLAUDE.md「新描画レイヤーオブジェクトの export 正常化」の横断回帰ゲート対象。

| 経路 | WP-2 影響 | WP-4 影響 | 対応 |
|---|---|---|---|
| preview（live DomRenderer） | 直接受益（nested 毎frame軽量化） | 直接受益（同値書込減） | verify で無回帰 |
| browser export（mp4/webm/PNG） | nested を含む comp の capture 経路 | 同 host style 経路 | 既存 `verify-*-export*` 無回帰 |
| **compFrameCapture**（precomp raster / RAM / bundle bake） | nested comp を offscreen で描く → **要無回帰** | — | `verify-comp19-nested-*` 等 |
| **HTML bundle player（player.js）** | `DomRenderer` は `src/runtime` = **player が import** | 同左 | **`npm run build:player` 必須** |
| INV-2（preview ≡ export ≡ bundle） | 出力等価なら不変 | 同値スキップは出力不変 | 実機 verify で一致確認 |
| track matte / adjustment / geom3d / split alpha（nested 内） | reconcile 化で状態持ち越しの副作用に注意 | — | §4 の特殊ケース確認 |

> **`DomRenderer.ts` は `src/runtime` 配下。CLAUDE.md の表より「ランタイム側 helper 変更」→ `npm run build:player` 必須。完了前に必ず実行。**

---

## 4. 実装 PLAN（Sonnet 5 low 逐語手順）

> 進め方は `.claude/skills/implementation-loop/SKILL.md` に従う（spec 先行 → 影響経路列挙 → 実機 verify → 純関数テスト固定 → progress 記録）。
> **spec 変更は本タスクでは発生しない**（純関数・型・直列化に触れないため）。着手前に該当 spec 節（§8 resolve / §23 nested comp / §5.4d blend）を**読むだけ**。

### Phase A — WP-4: 同値 style 書き込みの抑制（先行・最も安全）

**狙い**: `applyObject` がホスト div の `transform`/`opacity`/`zIndex` を毎フレーム無条件に書くのをやめ、**前回値と異なるときだけ書く**。ブラウザは同値代入でも style invalidation / compositor 再判定が発生しうるため、書き込み自体を省く。

**手順:**

1. `ObjectEntry`（`:122`）に last-value フィールドを追加:
   ```ts
   /** WP-4 同値 style 書込抑制（出力等価・INV-2 不変）。未設定は null。 */
   lastTransform: string | null;
   lastOpacity: string | null;
   lastZ: string | null;
   ```
2. entry 生成箇所（`:466` の `entry = { … }`）で 3 フィールドを `null` 初期化する。
3. `applyObject`（`:1096`）の**通常経路（`else` ブロック `:1127-1154`）** の style 書き込みを last-value ガードで包む:
   ```ts
   const tf = mat4ToCss(xform);
   if (tf !== entry.lastTransform) { entry.div.style.transform = tf; entry.lastTransform = tf; }
   if (opacity !== entry.lastOpacity) { entry.div.style.opacity = opacity; entry.lastOpacity = opacity; }
   const z = String(Math.round(obj.zOrder * BASE_Z));
   if (z !== entry.lastZ) { entry.div.style.zIndex = z; entry.lastZ = z; }
   ```
4. **track matte / matte source 経路（`:1111-1126`）に入ったフレームは last-value を無効化する**（構造が変わり div の役割が変わるため）。それらの分岐に入ったら `entry.lastTransform = entry.lastOpacity = entry.lastZ = null;` を立て、通常経路へ戻った初回に必ず書き直させる。同様に `childrenRebuilt`（`:1173`）が真のフレームでも安全側で null 化してよい。

**守ること（ガード）:**

- **値の生成ロジックは変えない。** `mat4ToCss(xform)` / `opacity` / `zIndex` の**計算式は完全に据え置き**。「同じ値なら書かない」だけ。
- **track matte / adjustment / matte-source の分岐に入るフレームでは last-value を必ずリセット**（それらは `entry.div` の transform/opacity/zIndex の**意味**を変える）。リセット漏れは「モード切替後に古い transform が残る」バグになる。
- nested 側（`renderNestedComp`）は Phase A では**触らない**（style を `cssText` で一括代入しており、last-value 化は WP-2 の reconcile 化とセットで Phase B で行う）。

**検証（Phase A 完了ゲート）:**
- `npm run typecheck` 緑。
- `npm run build:player`（runtime 変更のため必須）→ `public/player.js` 更新。
- 実機 verify: 既存の代表 verify を数本流し、**ピクセル解析値が変更前と一致**（＝出力等価）。最低限: `verify-blend-mode.mjs`, `verify-track-matte.mjs`, `verify-export-adjustment.mjs`。
- INV-2: 同一 frame の preview と export のスクリーンショット一致（既存 `verify-*-export-parity` があればそれ）。

---

### Phase B — WP-2: nested comp を reconcile 化（本命）

**狙い**: `renderNestedComp`（`:2037`）の**毎フレーム `container.innerHTML = ""`（`:2066`）と全ラッパ div 再生成を廃止**し、トップレベル `entries` と同じ「objectId キーで div を永続化 → GC/再利用 → style を in-place 更新」モデルへ移す。text/video/geom3d の特殊持ち越し（reuseKey）を**全型に一般化**する。

**現状の要点（実装から）:**
- `container` はフレーム間で安定（トップレベルの comp component `el`＝`entry.children[i]` が persist、`:1248-1256`）。だから `WeakMap<container, …>` が機能する（`nestedElReuse` `:2004`, `nestedGeom3dGroups` `:2008`）。
- いまは**ラッパ div（`obj` ごとの外側 div, `:2088`）を毎frame new**し、その中身の text/video/comp/geom3d **要素だけ** `prevEls`（reuseKey）で持ち越している。

**移行方針（トップレベル reconcile の移植）:**

1. `renderNestedComp` 用の**ラッパ div 永続化マップ**を container 単位で持つ（`nestedElReuse` と同型の新規 WeakMap）:
   ```ts
   // WP-2: nested のラッパ div を objectId で永続化（トップレベル entries の nested 版）。
   private nestedWrappers = new WeakMap<HTMLElement, Map<ObjectId, HTMLDivElement>>();
   private nestedWrapperLast = new WeakMap<HTMLDivElement, { transform: string; opacity: string; z: string; cssMode: "normal" | "adj" }>();
   ```
2. `renderNestedComp` 冒頭で `container.innerHTML = ""`（`:2066`）を**削除**し、代わりに:
   - `wrappers = this.nestedWrappers.get(container) ?? new Map()` を取得。
   - この frame の可視 `childScene.objects` の id 集合 `seen` を作る。
   - **離脱 GC**: `wrappers` のうち `seen` に無い id の div を、配下の geom3d/split-alpha GL を解放してから `remove()` し map から消す（トップレベル `:428-440` と同じ順序: GL 解放 → remove）。
3. 各 `obj` について:
   - `let div = wrappers.get(obj.id)`。無ければ `document.createElement("div")` して `wrappers.set(obj.id, div)`。
   - **子要素の reconcile**: いまの reuseKey（`${obj.id}:${ci}:${c.type}`, `:2102`）持ち越しロジックを**全 component 型に適用**する。型シグネチャ（`obj.components.map(c=>c.type).join("|")`）を div に紐づけ、変化時のみ子を作り直す（トップレベル `childSig` `:1173` と同型）。geom3d/video の canvas・要素は従来どおり持ち越し。
   - **style は in-place + last-value**: いまの `div.style.cssText = …`（`:2097`/`:2099`）を、`transform`/`opacity`/`zIndex`/adj 用 `width/height/background/pointerEvents` の**個別 style 代入**に置換し、`nestedWrapperLast` で同値スキップ（Phase A と同じ last-value 手法）。`cssMode`（normal ↔ adj）が変わったフレームは last をリセット。
   - **DOM 順序**: reconcile では `container.appendChild(div)` を**毎frame呼んでも順序維持のため無害だが**、既存順序と一致するよう「この frame の描画順（`childScene.objects` は zOrder 昇順ソート済み）」で `appendChild` を回す（appendChild は既存ノードを末尾へ移動するので、全 obj を順に append すれば z 順が保たれる）。
4. `nextEls`/`prevEls`（`:2064`/`:2211`）による text/video/geom3d 持ち越しは**維持**（この一般化に吸収）。`nestedGeom3dGroups`（`:2072`）の GL 保護ロジックは**そのまま**。
5. **export composite タグ付け**（`__nestedComposite` / `needsComposite`, `:2118`, `:2164` 付近）と **blend mode**（`setBlendModeStyle` `:2162`）は**現状の挙動を 1:1 で維持**する。reconcile 化で div を持ち越すため、`setBlendModeStyle` も last-value 化するか、または毎frame呼んでも同値なら実質無害（`setBlendModeStyle` の実装を確認し、同値スキップが必要か判断）。

**守ること（ガード・回帰の火種）:**

- **持ち越しで「前フレームの style/子が残る」バグに注意。** いまは `innerHTML=""` が毎frame全リセットしていた＝暗黙のクリーンアップに依存していた箇所がある。reconcile 化では**「今フレームで設定しない style は明示的にクリアする」**必要がある。特に:
  - adj（調整レイヤー）→ 通常レイヤーに変わった div は `width/height/background/pointerEvents` を明示クリア（トップレベル `:1163-1167` と同じ）。
  - track matte / matte source が nested 内に出るケース（`exportCompositeMode` 経路 `:2164` 以降）の div 再利用時の状態クリア。
- **geom3d / split alpha / packed alpha の GL context**: 離脱 div を remove する前に **GL compositor を明示解放**（トップレベル `releaseAlphaGlCompositorsUnder` `:540` と同じ）。しないと context リーク＝「3D が数十frameで消える」。
- **深いネスト（depth 2+）**: 再帰 `renderNestedComp`（`:2116`）の `innerEl` も同じ reconcile モデルに乗る。container 永続化（`prevEls`/`nextEls`）は既にあるので、それを壊さない。
- **exportComposite / `needsComposite` の判定結果を変えない**（調整レイヤーを含む nested が単一 capture で焼けるか否かの判定は export 正しさに直結）。
- **INV-2**: reconcile 化は**出力を一切変えない**のが完了条件。「速くなったが 1px ずれた」は失格。

**段階分割（Sonnet 5 low 向け・1 PR ずつ verify）:**
- **B-1**: ラッパ div の永続化 + 離脱 GC + `innerHTML=""` 廃止（style はまだ毎frame `cssText` でも可）。ここで「持ち越しによる状態残り」を verify で潰す。
- **B-2**: 子要素 reconcile を全型に一般化（childSig 化）。
- **B-3**: style を in-place + last-value 化（`nestedWrapperLast`）。
- 各段で下記 verify を通してから次へ。**B-1 が最もバグりやすい**（暗黙クリーンアップ依存の顕在化）ので、ここに時間を割く。

**検証（Phase B 完了ゲート・必須の横断回帰）:**
- `npm run typecheck` 緑 / `npm test`（DomRenderer / raster / bundle 関連が緑。既知の pre-existing FAIL は baseline と照合して切り分け）。
- **`npm run build:player`** → `public/player.js` 更新（`playerBuildFreshness` 緑）。
- nested comp を含む実機 verify を**横断で**（CLAUDE.md「書き出し経路を横断して列挙」）:
  - preview: nested comp の live 再生でちらつき・消え・崩れが無い（特に 3D-extrude text を積んだ precomp、geom3d canvas 保護）。
  - **compFrameCapture**: `verify-comp19-nested-export.mjs` / `verify-nested-*` 系。
  - browser export: nested を含む comp を mp4/webm/PNG で書き出し、変更前とピクセル一致。
  - bundle export（§11.7）: nested comp を含む zip を書き出し、player で再生一致。
- **INV-2**: nested を含む同一 frame で preview ≡ export のスクリーンショット一致。
- **GL context 無回帰**: 3D text を複数積んだ precomp を親から呼び、数百frame再生して "Too many active WebGL contexts" が出ないこと。

---

## 5. スコープ外（本タスクで絶対にやらない）

- **WP-3 / WP-5**: `CompiledRenderPlan` / `AnimatedBinding` / `evaluateFrame` / `DirtyMask`(Uint32Array) / allocation-free `ResolvedFrameBuffer` の新設。→ `resolve()` と並行経路になり INV-1/INV-2 の bit 一致保守が破綻リスク。**別タスク・spec 追記・ユーザー確認から**。
- **WP-6**: `RuntimeFeatureSet` による未使用 renderer/effect/exporter の tree-shake + bundle 縮小。→ `bundleExporter`/`player` ビルドの回帰面が広い。転送サイズ最適化であり再生本丸ではない。
- **§5 型変更 / INV 変更 / `project.json` 直列化変更**（本タスクの範囲では発生しない）。
- **resolve() 自体の変更**（nested の子 comp を毎frame resolve する `:2048` のキャッシュ化等）。INV-2 リスク。据え置き。

---

## 6. 完了チェックリスト（Sonnet 5 low 用）

Phase A（WP-4）:
- [ ] `ObjectEntry` に last-value 3 フィールド追加 + 初期化。
- [ ] `applyObject` 通常経路の transform/opacity/zIndex を last-value ガード。
- [ ] matte / adjustment / childrenRebuilt フレームで last-value リセット。
- [ ] typecheck / build:player / 代表 verify でピクセル等価を確認。
- [ ] `progress.md` に追記。

Phase B（WP-2）:
- [ ] B-1: `nestedWrappers` 永続化 + 離脱 GC（GL 解放順序込み）+ `innerHTML=""` 廃止。
- [ ] B-2: 子要素 reconcile を全型へ一般化（childSig 化）。
- [ ] B-3: nested style を in-place + last-value 化。
- [ ] adj↔通常 / matte の状態クリア漏れが無い。
- [ ] typecheck / npm test / **build:player**。
- [ ] 横断 verify（preview / compFrameCapture / browser export / bundle export）全て変更前とピクセル一致。
- [ ] INV-2 preview≡export 一致 / GL context リーク無し。
- [ ] `progress.md` に追記。

---

## 付録: 参照ファイル / 行

- `src/runtime/DomRenderer.ts`
  - `ObjectEntry`（`:122`） / `renderFrame`（`:373`） / entry reconcile（`:428`, `:457`） / `applyObject`（`:1096`, style 書込 `:1133-1135`） / childSig reconcile（`:1173`）。
  - comp component → nested（`:1248-1256`）。
  - `renderNestedComp`（`:2037`, `innerHTML=""` `:2066`, ラッパ div `:2088`, reuseKey `:2102`, geom3d 保護 `:2072-2083`, export composite `:2164`）。
  - `nestedElReuse`（`:2004`） / `nestedGeom3dGroups`（`:2008`） / `releaseAlphaGlCompositorsUnder`（`:540`）。
- `src/runtime/resolve.ts`（`:300` `resolve()`・純関数 INV-1）— **触らない**（参照のみ）。
- `src/runtime/resolved.ts`（`ResolvedScene` / `ResolvedObject` §8）— **触らない**。
- 回帰ゲート verify（該当）: `verify-blend-mode.mjs` / `verify-track-matte.mjs` / `verify-export-adjustment.mjs` / `verify-comp19-nested-export.mjs` / `verify-nested-*` / bundle export 系。
- 参考ドキュメント: `doc/rendering-pipeline-current.md`（1 frame の全経路） / `doc/mafter-effect-spec.md` §8, §23, §5.4d。
- 手順の正本: `.claude/skills/implementation-loop/SKILL.md`（Phase 4c 横断回帰） / `.claude/skills/add-layer-component-type/SKILL.md`（§E export 無回帰） / CLAUDE.md「bundle player の再ビルド」。
