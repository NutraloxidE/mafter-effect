# Handoff: WebGPU raster 基盤の設計（別セッション先行） → pixelSorter プラン refine への戻し

> **目的**: pixelSorter の GPU 高速化（[bitonic-pixel-sorter-plan.md](bitonic-pixel-sorter-plan.md) Phase 2）に先立ち、**アルゴリズム非依存の WebGPU raster 基盤（配管）を別セッションで設計・実装**する。その成果（API/契約）が確定したら本ブランチに戻り、pixelSorter プランの §3.A / §4 / spec §27.3 を**その契約に合わせて refine** する。
> **GPU 種別は WebGPU で確定**（WebGL2 は §3.B で却下・不採用のまま。理由は本票 §4）。
> 作成日: 2026-07-16 / 対象ブランチ: `claude/bitonic-pixel-sorter-feasibility-dfksdt`

---

## 1. なぜ「基盤先行 → spec refine」の順にするか

- 基盤の API/バッファ契約が**上位の spec を制約する**（依存方向）。spec を先に凍結して GPU を後付けすると手戻りする。
- ただし **pixelSorter 固有の parity/INV-2 判断は基盤セッションに渡さない**（§3）。基盤は「GPU でどう速く回すか」に集中し、「出力を現行 CPU とどう一致させるか」は本ブランチで確定する。役割を割ることでコンテキスト無しの別セッションでも設計をやり直さずに済む。

---

## 2. 基盤セッションが**確定して返すべき**アウトプット（この4点が埋まれば戻りの refine は機械的）

### 2-1. デバイス初期化・可用性検出・フォールバック配線

- `navigator.gpu` → adapter → device の取得と、失敗時に**例外でなく `null` を返して CPU 経路へ落ちる**契約（現行 [rasterWorkerPool.ts](../../src/runtime/rasterWorkerPool.ts) の worker フォールバックと同型）。
- feature/limit 検出: 最低限 `maxComputeWorkgroupStorageSize`（既定 16384B）/ `maxComputeInvocationsPerWorkgroup`（既定 256）/ `maxStorageBufferBindingSize` を読み、要求を満たさなければ CPU へ。
- **3 経路それぞれの落とし所を明記**: preview（`DomRenderer`→`processRasterChainAsync`）/ browser export（`exporter.ts`）/ headless verify・CI。headless Chromium で GPU 不可（SwiftShader 性能不足含む）のとき CPU に落ちること。
- device lost / adapter 消失時の再取得 or CPU 降格の扱い。

### 2-2. バッファ契約（最重要・pixelSorter 以外にも効く）

現行 raster チェーンは **CPU `RasterBuffer`(Uint8ClampedArray) の buffer→buffer**（[effectRaster.ts](../../src/runtime/effectRaster.ts) / [rasterProcessAsync.ts](../../src/runtime/rasterProcessAsync.ts)）。GPU 基盤はどちらを採るか確定する:

- **(a) 単発オフロード型**: CPU buffer を受け取り `writeTexture`→compute→`mapAsync` readback で CPU buffer を返す。往復（1080p RGBA ≈ 8MB×2）が毎エフェクト発生。実装単純・現行チェーンに差し込みやすい。
- **(b) チェーン持ち回り型**: raster チェーン全体を GPU テクスチャで持ち回り、往復を端（入口/出口）だけにする。速いが `effectRaster.ts` の buffer→buffer 契約の変更が必要で影響範囲大。
- **決めること**: (a)/(b) いずれか、GPU バッファの型（storage buffer か texture か・RGBA8 か）、CPU⇄GPU 変換ヘルパーの置き場（例 `src/runtime/gpu/`）、非同期境界（現行は `processRasterChainAsync` が既に async なので preview は吸収可・export 経路の await 有無）。

### 2-3. 汎用性のスコープ

- この基盤に **mosaic / wave / ripple / turbulentDisplace** も後で乗せる前提の汎用 API にするか、まず **pixelSorter 専用**の薄い口だけ作るか。
- 汎用にするなら「compute パイプライン + bind group を effect ごとに登録する」型の最小レジストリを定義（`EffectDef` に GPU カーネルを optional で持たせるか、別テーブルにするか）。

### 2-4. 決定論・数値表現の**基盤側の保証範囲**

- GPU 側で使える数値型（f32 / u32）と、**同一入力に対する device 間再現性の限界**を基盤として明文化（f32 の丸めは driver 依存でありうる）。
- 「基盤は f32/u32 の演算場所を提供するだけで、CPU との bit 一致は上位（pixelSorter 側）が整数キー設計で担保する」という**責任分界**を宣言（§3 と対）。

---

## 2-5. スコープ外だが GPU 予算を共有する既存 WebGL サブシステム（3D extrude text / video alpha）

WebGPU raster 基盤は **`RasterBuffer` の buffer→buffer エフェクト経路だけ**を対象とする。以下は**別サブシステムであり本基盤の描画対象外**だが、**GPU リソース（context 予算）を共有する**ため基盤設計時に認識が要る（コードで確認済み・2026-07-16、main マージ後の実態）:

**既存の生 WebGL 使用箇所は2つ**（どちらも `getContext("webgl")`・three.js 不使用・「canvas はピクセルを作る手段」原則で DOM レイヤー構造/matrix3d/blend/filter に非関与）:

- **`src/runtime/geom3d/geom3dGl.ts` = 3D extrude テキスト/シェイプの押し出しメッシュ描画**。per-layer に WebGL canvas を1枚作り、頂点/法線バッファ + ライティングシェーダ（`uMVP`/`uNormalMatrix`/平行光）で実メッシュを描く。**「3D extrude テキストは WebGL 依存」は正しい**（当初の handoff の「CSS matrix3d・WebGL 非経由」記述は誤り＝マージ前ツリーを見ていた・訂正）。
- **`src/runtime/videoAlphaGl.ts` = split/packed alpha 動画合成**。context 予算 `MAX_GL_ALPHA_CONTEXTS = 8`。

**raster エフェクト経路との関係**: 3D メッシュ描画自体は WebGPU 基盤の対象外（基盤が触るのは描画済みピクセルに対する `RasterBuffer` エフェクトだけ）。ただし「3D text レイヤーに pixelSorter をかける」場合は *geom3d が canvas に描く → その canvas を raster 化 → エフェクト経路* という**別ステージの連結**であり、WebGPU 化はエフェクト側だけに効く（geom3d の描画は変えない）。

- **注意①（GPU context 予算の食い合い）**: `geom3dGl.ts` §5.5f 既知リスク（2026-07-16）の通り、**Chrome の同時 WebGL context は 1ドキュメント ~16 が上限・ページ全体で共有**。`geom3d` は 3D text レイヤーごとに予算なしで context を1つ作る（積むほど増える）＋`videoAlphaGl`（予算8）とこの枠を食い合う。超過すると古い context から黙って破棄され描画が消える。
- **注意②（WebGPU device の追加）**: 本基盤が導入する WebGPU device は上記2つの WebGL context とは**独立したコンテキスト**（一般に WebGL の ~16 枠とは別カウント）だが、**ページ全体の GPU リソース圧**という観点では3つ目の消費者になる。リソース共有・統合はしない（別物として扱う）が、大量の 3D text ＋ alpha 動画 ＋ WebGPU raster を同時に走らせる際の総 GPU 負荷は基盤の可用性/フォールバック判断（§2-1）で考慮する。

## 3. 基盤セッションに**渡さない**（本ブランチに残す）もの

Phase 2 の pixelSorter 統合時に、確定した基盤契約の上でここで決める:

- **§4「整数キー permutation 化」**（`K = 2126R+7152G+722B`）と INV-2 の parity 設計。
- **§6 の承認4点**（輝度キー整数化 / random 据え置き / GPU angle 90°制約 / Phase 2 着手判断）— ユーザー承認事項。
- **spec §27.3 `pixelSorter` の記述変更**（輝度キー定義・GPU 経路の angle 制約など）。
- **3経路 parity verify**（preview / export / bundle player の pixel diff = 0）の pixelSorter 版。
- bitonic カーネル本体（WGSL の span 検出 scan・adaptive phase・odd-network）— 基盤の bind group/バッファ契約が決まってから本ブランチで書く。

---

## 4. WebGPU で確定した根拠（WebGL2 を採らない理由）

- WebGL2 には compute shader も workgroup shared memory も無い → bitonic pixel sorter の核（1ライン丸ごとを groupshared memory に載せ O(log²n) を1ディスパッチ）が使えず、全 stage が render-to-texture の ping-pong 多パスになりスパン検出も多パス化 → 複雑さが見合わない（プラン §3.B）。
- WebGPU は Chrome/Edge 安定。可用性で劣る環境（Safari 一部・headless）は §2-1 の CPU フォールバックで受ける。
- **export/headless の可用性**という論点で WebGL に一理あったが、pixelSorter の核が shared memory 前提である以上、WebGL 版は「別アルゴリズム」を書くことになりコスト過大 → WebGPU + CPU フォールバックで統一する。

---

## 5. 戻ってきたときの refine 手順（このブランチで実施）

基盤の §2 アウトプットが揃ったら:

1. プラン §3.A を確定した**バッファ契約 (a)/(b)** に合わせて具体化（往復コストの見積り更新含む）。
2. §4「整数キー permutation 化」を、基盤の f32/u32 保証範囲に合わせて確定 → §6-1 の承認をユーザーに取る。
3. Phase 2 の実装チケット（PS-P2）を [phase1-ticket](bitonic-pixel-sorter-phase1-ticket.md) と同粒度で切る（allowed/forbidden files・parity verify・受け入れ条件）。
4. spec §27.3 更新（承認済み項目のみ）。

---

## 6. 現状のブランチ成果（このセッションまで）

- [bitonic-pixel-sorter-plan.md](bitonic-pixel-sorter-plan.md): 全体プラン（実現可能性・3経路評価・実測・INV 整合・Phase 分割・承認4点）。
- [bitonic-pixel-sorter-phase1-ticket.md](bitonic-pixel-sorter-phase1-ticket.md): Phase 1（bit-exact CPU リファクタ・承認不要・単発実行チケット）。実測見込み angle0 1.3x / angle45 2.3x。
- 本票: WebGPU 基盤先行のための handoff。
- **コード変更はまだ無し**（調査・計測・プラン文書のみ）。
