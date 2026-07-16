# 実行チケット PS-P1: Pixel Sorter CPU コア高速化（出力バイト完全一致・承認不要）

> **これは単一の実装エージェント（Sonnet 5 low 想定）がワンショットで完遂するための作業票。**
> 背景・全体像は [bitonic-pixel-sorter-plan.md](bitonic-pixel-sorter-plan.md) を参照（読まなくても本票だけで実装可能）。
> **本票のスコープは Phase 1 のうち「出力を1バイトも変えない typed-array リファクタ」だけ**。GPU / 整数キー / radix / worker 並列は**やらない**（別票）。
> §5 データスキーマ・INVARIANT・`project.json` 直列化・spec の param 表・公開 API シグネチャは**変更しない** → ユーザー承認不要。

---

## 0. 目的（Goal）

[`src/runtime/pixelSort.ts`](../../src/runtime/pixelSort.ts) の `processPixelSort` は 1080p で 270ms〜1300ms/frame かかる。原因はピクセル毎の配列タプル（`[r,g,b,a]`）と `SpanPixel` オブジェクトの大量生成による GC 圧。

**やること**: 内部を typed array 化して割り当てを排除し高速化する。ただし**出力は現行と完全に同一（全ピクセル・全パラメータで byte 一致）**でなければならない。これが唯一絶対の合格条件。速度はその上で「速くなっていれば良い」（数値目標は §5 の soft target）。

---

## 1. ハード制約（絶対に守る・違反したら即失敗）

1. **出力バイト完全一致**: 任意の入力バッファ・任意の `PixelSortParams` に対し、リファクタ後の `processPixelSort` 出力は現行実装と 1 バイトも違わない。→ §4 の golden テストで機械検証する。
2. **輝度式・しきい値・ブレンドの演算は現行のまま**（float の計算順序・`Math.round`・`Math.min/max` を変えない）。整数キー化・輝度重み変更は**禁止**（出力が変わるため。それは承認事項＝別票）。
3. **公開 API 不変**: `processPixelSort` / `blockAverage` / `luminance` / `isPixelSortIdentity` / `canvasToRasterBuffer` / `rasterBufferToCanvas` のエクスポート名・シグネチャ・戻り値型を変えない。
4. **INV-1 純関数性維持**: `Math.random`/`Date.now`/DOM/network 禁止。乱数は既存 `seededRandom` のみ。
5. **触ってよいファイルは §3 のみ**。他ファイルの挙動を変えない。

---

## 2. 出力を変えないための実装ルール（重要・precision の罠）

- **whole-pixel の移動・gather は `Uint32Array` ビュー**（`new Uint32Array(data.buffer, byteOffset, len)` ではなく、`data` 全体に対する `new Uint32Array(out.data.buffer)` を作りインデックスアクセス）で 1 word コピーする。→ endianness に依存しないのは「u32 値をそのままコピーするだけ」で**チャネルをビットシフトで分解しない**限り。**輝度計算とブレンドは必ずバイト単位（`data[i]`, `data[i+1]`…）で行う**こと。u32 を `>>8` 等で分解してはいけない。
- **weight は `Float64Array` で保持**（`Float32Array` にすると丸めが変わり出力が変わる）。輝度も `Float64Array` / `number`。
- **ブレンド演算は現行の式・順序を厳守**:
  ```
  w >= 1 → コピー（src をそのまま）
  0 < w < 1 → 各チャネル round(target * (1 - w) + src * w)
  ```
  `target` は**その出力ピクセルの元の色**、`src` はソート後に割り当てられた色。`w` はその出力ピクセルの weight。
- **ソートの安定性を維持**: 現行は `Array.prototype.sort`（ES2019 以降 stable）で同輝度ピクセルの相対順序を保つ。**インデックス配列を stable comparator でソート**して同じ順序を再現する（`indices.sort((a,b) => lum[a] - lum[b])` は stable）。**`TypedArray.sort()`（数値ソート）へ置換してはいけない**（キーパックには整数化が要り出力が変わる＝別票）。
- **`rotateBuffer` の bilinear は現行 `sampleBilinear` と同一の演算**（`Math.floor`/`Math.min`/重み `tx,ty`/`Math.round` の順序）をインラインで各チャネルに適用。タプル `[…]` を作らずに出力バッファへ直書きする。クランプは出力が `Uint8ClampedArray` であることで現行と同じに効く。

---

## 3. ファイルスコープ

**編集可（allowed）**:
- `src/runtime/pixelSort.ts` — 内部実装のみ書き換え（エクスポート signature 不変）
- `test/pixelSort.test.ts` — golden テストを追記（既存テストは消さない）

**新規作成可**:
- `test/pixelSortGolden.test.ts`（golden を別ファイルにする場合。既存に追記でも可）

**編集禁止（forbidden・挙動を変えない）**:
- `src/runtime/pixelSortParams.ts` / `rasterWorkerPool.ts` / `workers/rasterProcess.worker.ts` / `rasterProcessAsync.ts` / `DomRenderer.ts` / `effectRaster.ts` / `builtinEffects.ts`
- `doc/mafter-effect-spec.md`（§5/INV/param 表に触れない。散文変更も本票では不要）
- `project.json` 直列化まわり全般

---

## 4. 手順（この順で実行する）

### Step 1 — golden fixture を「現行コードから」採取して固定する（リファクタ前）

`test/pixelSortGolden.test.ts` を新規作成し、**現行 `processPixelSort` の出力チェックサムを期待値として埋め込む**。手順:

1. 決定論的な入力生成関数をテスト内に書く（`Math.random` 不可。LCG で seeded 生成）:
   ```ts
   function makeInput(w: number, h: number, seed: number): RasterBuffer {
     const data = new Uint8ClampedArray(w * h * 4);
     let s = seed >>> 0;
     const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
     for (let i = 0; i < data.length; i += 4) {
       data[i] = Math.floor(rnd() * 256);
       data[i + 1] = Math.floor(rnd() * 256);
       data[i + 2] = Math.floor(rnd() * 256);
       data[i + 3] = 255;
     }
     return { data, width: w, height: h };
   }
   ```
2. FNV-1a などの決定論チェックサムを書く:
   ```ts
   function checksum(buf: RasterBuffer): string {
     let h = 0x811c9dc5 >>> 0;
     for (let i = 0; i < buf.data.length; i++) {
       h = (h ^ buf.data[i]!) >>> 0;
       h = Math.imul(h, 0x01000193) >>> 0;
     }
     return `${buf.width}x${buf.height}:${h.toString(16)}`;
   }
   ```
3. **マトリクス**（全組み合わせを1ケースずつ）を回す。最低限これを網羅する:
   - サイズ: `64×48`, `129×77`（奇数・非2冪でスパン端/非2冪長を踏む）
   - `sortingMode`: `simple` / `highlights` / `shadows` / `random`
   - `angle`: `0` / `45` / `90`
   - しきい値: `(low,high)=(0,1)` と `(0.25,0.75)`
   - `length`: `0`(全体) と `16`、`offset`: `0` と `8`
   - `feather`: `0` と `40`
   - `sortBlocks`: `1` と `4`
   （全直積でなくてよい。上記軸を代表的に組み合わせ **20〜40 ケース**。seed は各ケースで固定）
4. **現行コードのまま** `npm test -- pixelSortGolden` を1回走らせ、各ケースの `checksum` 実測値を出力し、それをテスト内の `expected` 定数（配列/オブジェクト）に**貼り付けて固定**する。
5. 固定後、**現行コードで緑になること**を確認する（＝ golden が現行を正しく捕捉した証拠）。ここで初めてリファクタに進む。

> このテストが「現行の出力」を凍結する。以後リファクタしても緑なら byte 一致が保証される。

### Step 2 — `rotateBuffer` を typed-array 化（割り当て排除・演算不変）

- `sampleBilinear` が返すタプルを廃止し、bilinear を `rotateBuffer` 内にインライン。4 チャネルを直接 `out[oi+c] = Math.round(top*(1-ty)+bot*ty)` で書く。`top/bot` は `c00…c11` の各チャネルを `data[...]` から直接読む。
- `getPixel`/`setPixel` はホットパスから外す（内部の他所で使っていれば残してよいが、rotate/scanline のループでは使わない）。
- 演算順序・`Math.floor`/`Math.min(w-1,...)`/`Math.max(0,...)`/`Math.round` を現行と一致させる。

### Step 3 — `sortHorizontalScanlines` + `sortSpanPixels` を typed-array 化

- 行処理を `Uint32Array`（whole-pixel コピー用）＋事前確保した scratch（`width` 長の `Float64Array lum`, `Float64Array weight`, `Uint32Array packedRgba`, `Int32Array indices`）で回す。scratch は `processPixelSort` で1回確保しループで使い回す。
- スパン検出は現行と同じ条件（`weight > 0.01` で継続、それ以外で flush）。
- `sortSpanPixels` 相当を index ベースに書き換える。各モードの意味論を現行と厳密に一致させる:
  - `simple`: slice の index を `lum` 昇順に **stable** ソート → 順に gather。
  - `highlights`: `mid=(lum[first]+lum[last])/2`。`dark = lum<mid`（元順）、`bright = lum>=mid` を `lum` 昇順 stable ソート。出力 = dark→bright。
  - `shadows`: 同 mid。`dark = lum<mid` を `lum` 昇順 stable、`bright = lum>=mid`（元順）。出力 = dark→bright。
  - `random`: 現行 `seededRandom(seed >>> 0)` による Fisher–Yates を**そのまま**（seed も `seed + y` の与え方も現行通り）。
  - `length`/`offset`: slice = `[min(offset, n-1), length>0 ? min(n, start+length) : n)`。slice 長 < 2 は無変更。
  - ブレンド: §2 のルール厳守。
- flush 時は sorted 結果を `packedRgba`→`Uint32Array` で書き戻し、ブレンドが要る（weight<1）ピクセルのみバイト単位で再計算して上書き。

### Step 4 — golden で byte 一致を確認

- `npm test -- pixelSortGolden` が**全ケース緑**（Step 1 で固定した期待値のまま）であることを確認。1ケースでも赤なら演算が現行とズレている → 直す（整数化・Float32・シフト分解を疑う）。

### Step 5 — 回帰・配線ゲート

以下を順に実行し全て緑にする:

```
npm run typecheck
npm test
npm run build:player        # ← src/runtime を触ったため必須（CLAUDE.md 多層防御）
```

- `npm test` は既存 `test/pixelSort.test.ts` / `test/effects.test.ts` / `test/playerBuildFreshness.test.ts` を含め全 PASS。
- `build:player` 後 `public/player.js` が更新され `playerBuildFreshness` が緑。
- 既存 verify のうち pixelSort/effect 関連が存在すれば実行して無回帰確認: `node verify-effects.mjs`（あれば）。

### Step 6 — 記録・コミット

- `progress.md` の先頭に本作業のセッション記録を1ブロック追記（実測 before/after ms、golden ケース数、build:player 実行済みを明記）。
- コミットして指定ブランチ `claude/bitonic-pixel-sorter-feasibility-dfksdt` に push（`git push -u origin <branch>`、ネットワーク失敗時のみ指数バックオフ再試行）。**PR は作らない**（ユーザー明示依頼がない限り）。

---

## 5. 受け入れ条件（Acceptance）

| # | 条件 | 判定 |
|---|---|---|
| A1 | `test/pixelSortGolden.test.ts` の全ケースが緑（byte 一致） | **必須・ハードゲート** |
| A2 | `npm run typecheck` 緑・`any` 未導入 | 必須 |
| A3 | `npm test` 全 PASS（既存テスト無回帰） | 必須 |
| A4 | `npm run build:player` 成功・`playerBuildFreshness` 緑 | 必須 |
| A5 | 公開エクスポートの signature 不変 | 必須 |
| A6 | 1080p `simple/angle0` が現行比で速い（soft target: ≥2x） | 目標（未達でも A1–A5 を満たせば可・実測を progress に記録） |
| A7 | 1080p `angle45` が現行比で速い（soft target: ≥3x、rotate 起因） | 目標 |

> **A1 が最優先**。速くても A1 が赤なら不合格。速度が目標未達でも A1–A5 が緑なら成果として受理（radix/GPU は別票で上乗せ）。

---

## 6. スコープ外（やらない・触ったら差し戻し）

- WebGPU / WebGL 実装（Phase 2・別票）
- 整数輝度キー化・radix sort（出力が変わる＝§27.3 散文変更＋ユーザー承認事項）
- `random` モードの hash キー化（出力変更）
- 任意 angle の GPU 化・回転アルゴリズム変更
- worker 行バンド並列（Phase 1b・別票。本票は単一 worker のまま）
- `pixelSortLite`（live SVG 近似）への変更
- spec / §5 / INV / param 表 / `project.json` 直列化の変更

---

## 7. 詰まったときの停止条件（Stop）

- golden が現行コードで**採取時点から**赤い、または現行と新実装で**どうしても byte 一致しない**箇所が特定できない → **その差分（どのモード/angle/パラメータで何バイト違うか）を progress に書いて停止し、ユーザーに報告**。勝手に「近似で妥協」して出力を変えない。
- `build:player` が既存要因で失敗する（本票の変更と無関係）→ 切り分けを記録して報告。
