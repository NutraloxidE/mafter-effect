# Pixel Sorter 高速化プラン — bitonic pixel sorter 型アプローチの実現可能性と実装計画

> **ステータス**: ドラフト（未承認）。本ファイルは `doc/mafter-effect-spec.md`（SSoT）を置き換えない。
> §5 データスキーマ・INVARIANT の変更は **ゼロ** で実装可能。ただし §6 の「ユーザー承認が必要な判断ポイント」
> （§27.3 散文の輝度キー定義変更 = 出力ピクセルに影響しうる）は着手前に承認が必要。
> 作成日: 2026-07-12 / 対象ブランチ: `claude/bitonic-pixel-sorter-feasibility-dfksdt`

---

## 0. TL;DR（先に結論）

- **原理的に可能。** ただし「bitonic sorter だから速い」のではない。参照実装
  [ruccho/BitonicPixelSorter](https://github.com/ruccho/BitonicPixelSorter)（Unity compute shader、RTX 4070 で FHD 340µs / 1000FPS 超）の速さの源泉は 3 つ:
  1. **GPU の数千スレッド並列 + workgroup 共有メモリ**（bitonic network は「分岐しない比較ネットワーク」なので GPU に最適、というだけ。CPU 逐次では O(n log²n) で quicksort/radix に劣る）
  2. **ピクセル(RGBA)を動かさずキーだけソート**: 「16bit スパン内 index + 16bit 輝度」をパックした 32bit キーをソートし、最後に index で元テクスチャから gather する
  3. **スパン検出の並列化**: prefix-max / suffix-min の 2 本の並列 scan で O(log n)
- ブラウザでの GPU 対応物は **WebGPU compute shader（WGSL）**。共有メモリ既定上限 16KiB は本家と同一で、本家の「1 ライン最大 2048px（4096 variant あり）」制約もそのまま移植できる。
- **ただし GPU 化の前に、(2)(3) の発想を CPU 実装へ移植するだけで数倍速くなることを実測で確認済み**（§3.C）。現行実装はピクセル毎のオブジェクト/タプル割り当てと comparator 付き `Array.sort` が支配的で、typed array + 数値キーソートへの素朴な書き換えプロトタイプだけで **1080p simple: 270ms → 78ms（3.5x）**。radix sort 化・回転最適化・worker 行分割まで含めれば 10x 超が現実的。
- **推奨**: Phase 1（CPU コア書き換え・全経路共通・決定論そのまま・低リスク）→ 効果を実機計測 → 必要なら Phase 2（WebGPU compute・オプトイン・フォールバック必須）。
- **最大の設計論点は速度ではなく INV-2**（preview / browser export / headless export の一致）。GPU float は device 依存で丸めが揺れるため、ソートを「**整数キーによる決定論的 permutation**」として仕様化し、CPU/GPU どちらの実装でも同一 permutation を出すことで吸収する（§4）。

---

## 1. bitonic pixel sorter とは（検索結果まとめ）

参照実装: [ruccho/BitonicPixelSorter](https://github.com/ruccho/BitonicPixelSorter)（GPU-accelerated pixel sorter with bitonic sorting for Unity）。

処理パイプライン（compute shader・1 ライン = 1 workgroup）:

| 段 | 内容 |
|---|---|
| Load | 各スレッドが担当ピクセルの輝度を計算し、`(16bit index << 16) \| 16bit 輝度` の 32bit キーを groupshared memory へ格納 |
| Span 検出 | 輝度しきい値内の連続領域を prefix-max scan（スパン開始）+ suffix-min scan（スパン終端）の 2 本の並列 scan で O(log n) 検出。しきい値外ピクセルは「長さ 1 のスパン」となり動かない |
| Phase 数決定 | 並列 reduction で最長スパン長 maxLen を求め、bitonic phase 数を `floor(log2(maxLen)) + 1` に削減（短いスパンだけなら早く終わる） |
| Bitonic network | comparator をスパン開始位置からの相対 index で張り、複数スパンを同時に・分岐発散なしで独立ソート。非 2 冪長は odd-network 技法で処理 |
| Gather | ソート済み index で元テクスチャから RGBA を gather して出力 |

制約と性能:

- **1 ライン最大 2048px**（16KiB shared memory）。occupancy を犠牲に 4096px variant あり
- **ソート方向は水平/垂直のみ**（任意角度なし）
- RTX 4070 / FHD で GPU 時間 **約 340µs**、1000FPS 超

bitonic sort 自体は比較回数 O(n log²n) で逐次実行なら劣るが、比較ネットワークがデータ非依存（分岐しない）なため GPU の lockstep 並列に最適、という性質のアルゴリズム。**「CPU で bitonic sort に置き換える」ことには意味がない**点に注意（§3.C）。

---

## 2. 現状実装の構造とボトルネック（コード根拠）

### 2.1 パイプライン

[`src/runtime/pixelSort.ts`](../../src/runtime/pixelSort.ts) `processPixelSort()`:

```
clone → (sortBlocks>1 なら blockAverage) → rotateBuffer(-angle)
  → sortHorizontalScanlines（スパン検出 + モード別ソート + feather ブレンド）
  → rotateBuffer(+angle)
```

統合経路:

- **preview**: `DomRenderer` → `processRasterChainAsync`（[rasterProcessAsync.ts](../../src/runtime/rasterProcessAsync.ts)）→ `globalRasterWorkerPool.processPixelSort`（[rasterWorkerPool.ts](../../src/runtime/rasterWorkerPool.ts)、pool 最大 4 worker だが **1 フレームの pixelSorter は 1 worker で直列実行**）
- **export / composite**: `def.processPixels` 直呼び（同一関数）
- **parity の現状担保**: preview / export / bundle player すべてが**同一の JS 関数**を実行するため、INV-2 は「同一コード」で自動成立している。高速化でこの構造を崩す場合は §4 の decision が必要

### 2.2 ボトルネック（コード上の根拠）

| # | 箇所 | 問題 |
|---|---|---|
| B1 | `getPixel`/`setPixel` が毎ピクセル `[r,g,b,a]` タプルを生成、スパンは `SpanPixel` オブジェクトの配列 | 1080p で数百万オブジェクト/frame の割り当て → GC 圧が支配的 |
| B2 | `slice.sort((a,b) => a.lum - b.lum)` | comparator 付き `Array.sort`（boxed 比較）。`slice()`/`filter()`/中間配列も毎スパン発生 |
| B3 | `rotateBuffer` | JS bilinear × 2 パス、毎ピクセルでタプル割り当て。angle≠0 のとき**支配的**（下表: 270ms → 1299ms） |
| B4 | `sortHorizontalScanlines` の輝度計算 | スパン検出とソートで float 輝度を都度計算（行単位の precompute なし） |

### 2.3 実測ベースライン（Node 22 / 本コンテナ、`processPixelSort` 単体、3 run 平均）

ランダムノイズ画像（ワーストケース寄り: スパンが細かく大量に発生）:

| ケース | 1280×720 | 1920×1080 |
|---|---|---|
| simple / angle 0 / len 256（デフォルト） | 192 ms | **270 ms** |
| simple / **angle 45** / len 256 | 614 ms | **1299 ms** |
| simple / threshold 0..1 / len 0（全面ソート） | 331 ms | 763 ms |
| highlights | 141 ms | 324 ms |
| random | 68 ms | 208 ms |

→ 30fps preview 予算（33ms/frame）に対し **8〜40 倍オーバー**。worker で UI は固まらないが、preview のエフェクト付きフレームレートは数 fps に落ちる。

---

## 3. 原理的可能性 — 3 つの経路の評価

### 3.A WebGPU compute shader（本家と同型）— 可能・最速・ただし可用性とparityの管理が必要

- WGSL compute + workgroup shared memory。WebGPU 既定 limit `maxComputeWorkgroupStorageSize = 16384B`（本家の 16KiB と同一）、`maxComputeInvocationsPerWorkgroup = 256` → 本家同様 1 スレッド複数要素担当で 1 ライン 2048px を 1 workgroup に載せられる。span 検出 scan・adaptive phase・odd-network はそのまま WGSL 化可能。
- 回転済みバッファに対して水平ラインをソートする現行構成なら、ライン長 = バッファ幅なので 1920/2048 制約は 1080p まで素で収まる（4K は 4096 variant か CPU フォールバック）。
- 期待性能: カーネル自体は 1080p で 1ms 未満〜数 ms。ただし **RasterBuffer(CPU) ⇄ GPU テクスチャの往復**（writeTexture + mapAsync readback、1080p RGBA ≈ 8MB×2）が数 ms 加わる。現行 effect chain は buffer→buffer の CPU 契約（[effectRaster.ts](../../src/runtime/effectRaster.ts)）なので、当面は往復込みで見積もる（それでも 10ms 級 = 現行比 30〜100x）。
- 可用性（2026 時点）: Chrome/Edge は安定。headless Chromium（verify スクリプト・CI）では SwiftShader fallback の可否と性能が環境依存 → **CPU フォールバック必須**であり、フォールバックと GPU の出力一致が INV-2 の論点になる（§4）。

### 3.B WebGL2 fragment shader ping-pong bitonic — 可能だが非推奨

古典的 GPGPU 手法（[GPU Gems 2 ch.46](https://developer.nvidia.com/gpugems/gpugems2/part-vi-simulation-and-numerical-algorithms/chapter-46-improved-gpu-sorting)）。shared memory がないため全 O(log²n) パスがテクスチャ往復になり、スパン検出も多パス化して実装が複雑。`videoAlphaGl.ts` で WebGL 基盤は既にあるが、WebGPU が主要ブラウザで使える現在、複雑さに見合わない。**採らない**（WebGPU 不可環境は Phase 1 の CPU 経路で受ける）。

### 3.C CPU への「思想」移植（キーパック + gather + オブジェクト排除）— 可能・実証済み・最低リスク

bitonic network そのものは CPU では無意味だが、本家の高速化要素 (2)(3) は CPU でもそのまま効く:

- 行輝度キーの precompute（`Int32Array`）、スパン検出のインライン化
- **キーパック**: `K * 8192 + spanIndex` を `Float64Array`（整数は 2^53 まで正確）に詰めて comparator なし数値ソート → 下位 bit の spanIndex が現行 stable sort と同じ安定性を与え、ソート後は spanIndex で u32 RGBA を gather
- `Uint32Array` ビューで RGBA を 1 word として移動（チャネル別コピー廃止）

**プロトタイプ実測**（simple / angle 0、上と同一条件・同一入力）:

| ケース | 現行 | プロトタイプ | 倍率 |
|---|---|---|---|
| 1080p デフォルト | 270 ms | **78 ms** | 3.5x |
| 1080p 全面ソート | 763 ms | **177 ms** | 4.3x |
| 720p デフォルト | 192 ms | 34 ms | 5.6x |

さらに残っている伸びしろ（プロトタイプ未実施分）:

- `Float64Array.sort()`（比較ソート）→ **LSD radix sort**（22bit キーなら 11bit×2 パス、O(n)）
- `rotateBuffer` の typed array 化（B3。angle45 の 1299ms の大半はここ）
- **行バンド worker 並列**: 回転後の行は完全独立なので、既存 pool の 4 worker に行バンドを分配して合流するだけで ~3x
- 合計で **10〜20x（1080p simple ≈ 15〜30ms、angle45 ≈ 60〜130ms）** が現実的な着地点

決定論は JS のまま（float 演算も V8 の IEEE754 で全経路一致）なので **INV-2 は現行同様「同一コード」で自動成立**。全経路（preview worker / export / bundle player）が同じ関数を呼ぶ構造も不変。

---

## 4. 決定論・INV 整合（最重要設計論点）

| INV | 影響 | 対応 |
|---|---|---|
| INV-1（`resolve` 純関数） | なし。pixel sort は resolve 後の raster 段。`processPixels` の純関数性（同一入力→同一出力）は GPU 経路でも維持する | seed は現行どおり `phaseToSeed(frame)` |
| INV-2（preview / export / headless 一致） | **Phase 2（GPU）で顕在化**。GPU float は device/driver 依存で丸めが揺れる | 下記「整数キー permutation 化」 |
| INV-3〜6 | なし | — |

### 整数キー permutation 化（Phase 2 の前提・Phase 1 でも採用推奨）

ソート結果を「float 演算の産物」ではなく「**整数キーで定義される決定論的 permutation**」として仕様化する:

- **輝度キー**: `K = 2126*R + 7152*G + 722*B`（0..2,550,000、22bit）。現行 `L = (0.2126R+0.7152G+0.0722B)/255` と正の定数倍で単調同値だが、float 丸めの影響で「ほぼ同輝度のピクセル同士」のタイブレークが現行と変わりうる → **出力ピクセルが変わりうるため §27.3 散文の更新 + ユーザー承認が必要**（§6-1）。GPU（u32 演算）と CPU（整数演算）で完全一致する。
- **安定性**: 順序キーを `(K, spanIndex)` の辞書式にする。現行の stable `Array.sort` と同じ意味論であり、unstable な bitonic network 上でも本家と同じ「index をキーにパック」で成立する。
- **モード別のキー表現**（すべて permutation として表現可能）:
  - `simple`: `(K, i)` 昇順
  - `highlights` / `shadows`: スパン端 2 点から `midK` を計算し、対象外側は `(0, i)`（相対順維持）・対象側は `(1, K, i)` の合成キー → 現行の filter+sort+連結と同一結果
  - `random`: 現行は `seededRandom` の逐次 Fisher–Yates で**本質的に逐次**。GPU 化するには `hash(seed, y, i)` をキーにしたソート（= シャッフル）へ意味論変更が必要（出力が変わる）。**推奨: Phase 1〜2 では random モードは CPU 実装のまま据え置く**（§6-2）
  - `length`/`offset`: スパン境界の切り詰めとして表現（現行と同じ）。`feather`: ソート後の重みブレンド（並列 per-pixel、意味論不変）
- **回転（任意 angle）の parity**: GPU テクスチャの bilinear は 8bit 固定小数の重みで CPU f64 と一致しない。
  - **R1（推奨）**: GPU 経路は `angle % 90 === 0` のみ（回転が transpose/flip で厳密）。任意 angle は Phase 1 の最適化済み CPU 経路が受ける。本家も水平/垂直のみであり、90° 刻みが実用上の主用途
  - R2（将来）: 回転も compute shader の自前 f32 bilinear にし、CPU 側も `Math.fround` で f32 に落として一致させる。全経路のピクセルが現行から変わるため R1 の後で別途判断

### 経路一致の検証方針

`verify-fast-export-parity.mjs` と同型の verify を新設し、**同一フレームで (a) preview 経路（worker、GPU 有効時は GPU）、(b) export 経路、(c) bundle player** の 3 出力を pixel diff = 0 で照合する。GPU 有効環境では export も GPU を使い経路を統一、GPU 無効環境（headless CI 等）では全経路 CPU に落ちる — どちらの世界でも「整数キー permutation」仕様により同一出力になることが被検証命題。

---

## 5. 実装プラン（Phase 分割）

### Phase 0: ベンチ・回帰基盤（0.5 日）

- `verify-pixelsort-bench.mjs`（または `doc/cloudplan/pixel-sorter-bench/` 配下）: §2.3 の計測を再現可能なスクリプトに固定（実画像 + ノイズ画像、全モード × angle 0/45/90）
- [test/pixelSort.test.ts](../../test/pixelSort.test.ts) に golden（現行出力のハッシュ/サンプル点）を追加し、「意図した変更以外は出力不変」を機械化

### Phase 1: CPU コア書き換え（1〜2 日）— 最優先・単独でも価値あり

> **単発エージェント向け実行チケット**: [bitonic-pixel-sorter-phase1-ticket.md](bitonic-pixel-sorter-phase1-ticket.md)
> （Phase 1 のうち「出力バイト完全一致を保証する typed-array リファクタ」だけに絞った、Sonnet 5 low がワンショットで完遂できる粒度の作業票。整数キー化・radix・worker 並列は含めず承認不要）。


1. `sortHorizontalScanlines` の typed array 化: 行キー precompute（`Int32Array`）→ スパン検出インライン → キーパック（承認可否で分岐: 承認済みなら整数 `K`、未承認なら現行 float `lum` を `Float64Array` パック）→ radix / 数値ソート → `Uint32Array` gather
2. `rotateBuffer` の割り当て排除（タプル廃止・チャネル直書き・bilinear インライン化）
3. `blockAverage` / feather / highlights / shadows / random の同意味論 typed array 化
4. （オプション）worker 行バンド並列: `rasterWorkerPool` に「1 フレームを行バンドで複数 worker に分配」する job 型を追加。行独立なので合流は memcpy のみ
- **変更なし**: `PixelSortParams` / `EffectDef` / UI / spec の param 表。公開 API は `processPixelSort` シグネチャ不変
- **必須**: `src/runtime` 変更のため `npm run build:player`（CLAUDE.md 多層防御）
- **受け入れ目安**: golden 一致（キー定義変更を承認した場合はその差分のみ許容・目視同等）、1080p simple ≤ 40ms、angle45 ≤ 150ms、`npm test` / 既存 verify 無回帰

### Phase 2: WebGPU compute 経路（3〜5 日・オプトイン・Phase 1 の実測を見てから着手判断）

1. `src/runtime/gpu/pixelSortGpu.ts`: adapter/device 初期化、feature/limit 検出、失敗時は例外でなく `null` を返して CPU へフォールバック
2. WGSL カーネル群（本家パイプラインの移植）: (a) キー計算 + しきい値マスク、(b) スパン検出 scan（prefix-max / suffix-min）、(c) workgroup 内 bitonic（≤2048px、必要なら 4096 variant）、(d) gather。`length`/`offset`/`feather` はスパン境界調整と後段ブレンドパスで表現
3. 統合: [rasterProcessAsync.ts](../../src/runtime/rasterProcessAsync.ts) の分岐を「GPU 可用 && `angle % 90 === 0` && モード ≠ random → GPU、それ以外 → worker(CPU)」に拡張。browser export も同じ分岐を通す（経路統一）
4. parity verify（§4）を GPU 有効/無効の両環境で PASS させる
- **受け入れ目安**: 1080p simple ≤ 10ms（転送込み）、3 経路 pixel diff 0、GPU 無効環境で自動フォールバックし出力一致

### Phase 3: 配線・回帰ゲート（0.5〜1 日）

- CLAUDE.md「export 正常化」チェックリストの横断確認: browser export（mp4 / webm / PNG 連番）/ `compFrameCapture`（ネスト precomp・調整レイヤー raster）/ Web bundle player / preview
- `npm run build:player` + `playerBuildFreshness` 緑、`verify-effects.mjs` / `verify-fast-export-parity.mjs` / `verify-preview-cache.mjs` / `npm test` 無回帰
- spec §27.3 散文更新（承認済み項目のみ）、`progress.md` 更新

---

## 6. ユーザー承認が必要な判断ポイント（着手前に確認）

| # | 論点 | 選択肢 | 推奨 |
|---|---|---|---|
| 1 | 輝度キーの整数化（§27.3 散文変更。近傍同輝度ピクセルの並びだけ現行と変わりうる） | a) 承認して CPU/GPU 共通の正準定義にする / b) 現行 float 意味論を維持（Phase 2 の parity 設計が大幅に複雑化） | **a** |
| 2 | `random` モード | a) CPU 据え置き（出力不変） / b) hash キー化して GPU 対応（出力変更） | **a**（Phase 1-2 の間） |
| 3 | GPU 経路の angle 制約 | a) 90° 刻みのみ GPU・他は CPU / b) 回転も f32 で GPU/CPU 一致させる（全経路の出力変更） | **a** |
| 4 | Phase 2 の着手 | a) Phase 1 実測後に判断 / b) 最初から GPU まで一気に | **a**（Phase 1 で preview 実用域に入れば Phase 2 は保留可） |

---

## 7. 非目標

- `pixelSortLite`（live SVG 近似）の置き換え・変更 — 別物として現状維持
- WebGL2 ping-pong 実装（§3.B で不採用）
- AEPS2 100% 一致（既存の非目標のまま・spec 2518）
- 4K の GPU 1-workgroup ソート（>2048px ラインは 4096 variant か CPU フォールバックで受ける）

---

## 8. 参考

- [ruccho/BitonicPixelSorter — GPU-accelerated pixel sorter with bitonic sorting for Unity](https://github.com/ruccho/BitonicPixelSorter)
- [GPU Gems 2, Chapter 46 — Improved GPU Sorting (NVIDIA)](https://developer.nvidia.com/gpugems/gpugems2/part-vi-simulation-and-numerical-algorithms/chapter-46-improved-gpu-sorting)
- [Alan Zucconi — GPU Sorting](https://www.alanzucconi.com/2017/12/13/gpu-sorting-1/)
- 現行実装: [src/runtime/pixelSort.ts](../../src/runtime/pixelSort.ts) / spec §27.3 `pixelSorter`（doc/mafter-effect-spec.md:2496）
