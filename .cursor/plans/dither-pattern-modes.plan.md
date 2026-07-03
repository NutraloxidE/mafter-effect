# ditherDissolve — 不規則ディザパターン拡張プラン

## 背景・問い

現行 `ditherDissolve` は **8×8 Bayer 秩序ディザ**（規則的な格子感が見える）。
ユーザーは AE っぽい **ざらついた・不規則な質感** も選べるか？

**結論: 可能。** ただし AE の「Dither Dissolve ブレンドモード」自体も秩序ディザ（Bayer 系）であることが多く、**不規則モードは AE 準拠というより質感オプションの拡張** として位置づける。

## 現状（コミット `da375c3`）

| 項目 | 内容 |
|------|------|
| マスク | `bayerMaskSvg` → `feImage` + `luminanceToAlpha` + `feComposite in` |
| 閾値 | `effectiveReveal = quantize(layerOpacity × (1 − completion))`（64 段） |
| 旧 blendMode | 同じ `ditherMask.ts` の Bayer 8×8 タイル（`mask-image: repeat`） |
| 規則性の原因 | Bayer 行列の空間周期（8px）がそのまま見える |

## 目標

1. **後方互換**: 既定は現行 `ordered`（Bayer 8×8）のまま
2. **不規則モード**: 目視で格子が立たないパターンを 1 つ以上追加
3. **INV-1 / INV-2**: `seededRandom` または静的 LUT のみ。preview ≡ export
4. **live 経路維持**: `executionPath: "live"`, `previewBakeRequired: false`
5. **§5 型変更なし**: EffectDef の `params` 追加のみ（spec §27 散文）

---

## 方式候補（比較）

| 方式 | 質感 | live SVG 適性 | 決定論 | reveal 精度 | 推奨 |
|------|------|---------------|--------|-------------|------|
| **A. Bayer 8×8（現行）** | 規則的格子 | ◎ pattern | ◎ | ◎ 厳密 | 既定のまま |
| **B. Blue noise タイル** | ざらつき・均一 | ◎ 256² pattern repeat | ◎ 静的 LUT | ○ 閾値比較 | **第1候補** |
| **C. feTurbulence マスク** | ランダム風 | ◎ 手続き | ○ seed 固定 | △ 統計的 | 第2候補 |
| **D. 全画面 seeded 白ノイズ PNG** | 最もランダム | △ 4K で重い | ◎ | ○ | 非推奨（キャッシュ爆発） |
| **E. Floyd-Steinberg 誤差拡散** | AE プラグイン風 | × raster 必須 | ○ | ○ | 別エフェクト扱い |

### 推奨: **B. Blue noise タイル**

- Return of the Obra Dinn 系の「ランダムに見えるがクラスタが少ない」質感
- 256×256 程度の **事前計算 blue noise** を SVG `<pattern>` で repeat（Bayer と同型パイプライン）
- 閾値: `noise(x,y) < effectiveReveal`（`ditherVisible` と同型の純関数）
- **格子周期 256px** — 1080p でも目立ちにくい

### 次点: **C. feTurbulence**

- 新規アセット不要。`feTurbulence seed=randomSeed` → `luminanceToAlpha` → reveal で閾値シフト
- 実装は軽いが、**reveal 50% での表示ピクセル率が厳密に 50% にならない**可能性 → キャリブレーション or 統計的許容が必要
- verify は「平均 visible ratio ≈ reveal」で測る

---

## スキーマ（spec §27 追記案・§5 変更なし）

### 新パラメータ

| key | label | kind | default | options | animatable |
|-----|-------|------|---------|---------|------------|
| `pattern` | Pattern | enum | `"ordered"` | `ordered` / `blueNoise` / (`noise` 将来) | ❌ |
| `randomSeed` | Random Seed | scalar | `0` | 0..9999 | ❌（`pattern` が noise 系のときのみ有効） |

- `completion` は現行どおり
- spec に明記: **`pattern` は質感選択。AE Dither Dissolve ブレンドモードの 100% 再現は `ordered` のみが近い**

---

## 実装ステップ

### Phase 1 — 純関数コア（`ditherMask.ts` / `ditherReveal.ts`）

1. `ditherVisibleOrdered(x, y, reveal)` — 現行 `ditherVisible` をリネーム/export
2. `ditherVisibleBlueNoise(x, y, reveal)` — 静的 `BLUE_NOISE_256: Uint8Array` を参照
   - 値 0..255 を `reveal` と比較（`value/256 < reveal`）
3. `buildDitherMaskSvg(w, h, reveal, pattern, seed?)` — pattern 分岐
4. unit: 各 pattern で **reveal 単調性**・**決定論**・**平均 coverage ≈ reveal**（±許容）

### Phase 2 — effect 配線

1. `builtinEffects.ts` — `pattern` / `randomSeed` を `ditherDissolveMask` に渡す
2. `effectSvg.ts` — `ditherDissolveMask(reveal, w, h, opts)` 拡張
3. `feTurbulence` 経路を入れるなら `noiseMaskPrimitives(reveal, w, h, seed)` を追加

### Phase 3 — アセット

- `src/runtime/assets/blueNoise256.ts` — 256×256 単チャネル LUT（base64 または数値配列）
- 生成は **ビルド時 1 回**（リポジトリにコミット）。ランタイム `Math.random` 禁止

### Phase 4 — 検証

1. `test/ditherMask.test.ts` — blue noise 追加
2. `verify-dither-dissolve.mjs` — `pattern: ordered` と `blueNoise` の **空間周期** 比較
   - ordered: 8px 周期の自己相関ピーク
   - blueNoise: 低周期ピーク・純色ピクセル比は維持
3. export 経路: `verify-export-filter` 系 or 既存 dither verify の screenshot 無回帰
4. `npm run build:player`

---

## リスクと対策

| リスク | 対策 |
|--------|------|
| blue noise LUT が大きい | 256² uint8 ≈ 64KB。1 ファイルに圧縮可 |
| pattern 追加でマスク SVG が重い | data URI キャッシュキーに `pattern|seed|qReveal|w|h` |
| feTurbulence の reveal ずれ | Phase 1 は blue noise のみ。noise は Phase 2 |
| プレビュー縮小で差が見えない | verify は comp 解像度で screenshot |
| AE との期待ギャップ | spec/UI で「ordered = 古典」「blueNoise = ざらつき」と明示 |

---

## スコープ外（今回やらない）

- Floyd-Steinberg / error diffusion（`previewBakeRequired: true` の別エフェクト候補）
- `completion` 以外の AE Transition 全パラメータ再現
- blendMode への `pattern` 復帰

---

## 完了条件

- [ ] `pattern: ordered` — 現行 verify 無回帰
- [ ] `pattern: blueNoise` — 格子感が ordered より弱いことを verify で定量
- [ ] `npm test` / typecheck / build:player 緑
- [ ] spec §27.3 更新（§5 型不変更）

---

## 精査メモ（プラン自己レビュー）

### 修正・強調した点

1. **AE 準拠の限界**: 旧 blendMode も Bayer だった。不規則モードは「AE 再現」ではなく「質感拡張」とラベルすべき。
2. **第1実装は blue noise のみ**: feTurbulence はキャリブレーションコストが高い。一度に 3 モードやらない。
3. **`randomSeed` は blue noise では不要**（静的 LUT）。`noise` 追加時だけ効かせる。
4. **feTile 不使用方針は維持**: `<pattern>` + `feImage` 全面 rect で Bayer と同型。
5. **ユーザー確認不要**（§5/INV 不変更、EffectDef params のみ）— 実装に進んでよい。

### 残る不確実性

- 実機で blue noise が「AE っぽい」と感じるかは目視確認が必要（Obra Dinn 寄りになる可能性）
- AE の Transition 版 Dither Dissolve を実測していない — 必要なら参考 MP4 でピクセルサンプリング
