# GPU Raster Pipeline — Phase 0 ベースライン計測レポート

> `gpu-raster-pipeline-design.md` Phase 0 の成果物。**現行 CPU 経路（foreignObject capture + Canvas2D 合成）の実測ベースライン**。GPU 化後の比較基準としてここに固定する。
> 計測は挙動変更なし・runtime source 非改変（page-only monkey-patch）。再現: `npm run dev` 起動後 `node bench-gpu-raster-baseline.mjs` → `bench-gpu-raster-baseline.json`。

---

## 1. 計測条件

| 項目 | 値 |
|---|---|
| fixture | 重い composite（下記）を store API で構築した synthetic project（外部アセット不要） |
| Main comp | 1280×720 / 30fps / 9 レイヤー |
| Inner precomp（nested） | 640×360 / 4 レイヤー（raster mosaic + wave + screen blend + raster adjustment） |
| Main の内訳 | BG solid / multiply・overlay・screen の blend solid×3 / mosaic(raster) solid / **track matte ペア（alpha）** / **raster adjustment(mosaic)** / **nested precomp インスタンス** |
| 駆動 | preview scrub 48 フレーム（distinct=cold → 同一再走査=warm）。settle 検出（pixel-API idle 100ms） |
| 環境 | Chromium（/opt/pw-browsers）1400×900・実 preview パネル描画 |
| 計測手段 | `getImageData`/`putImageData`/`drawImage`/`toDataURL`/`createImageBitmap`/`readPixels`/`<img data:svg> decode` を page で wrap し call 数と累積 ms を集計 |

> このフレームは preview の重い経路（`runRasterPipeline` / `runAdjustmentRasterPipeline` / `composeTrackMatteToCanvas` / `renderNestedCompRaster`）をすべて通す。軽量 comp は対象外（別 fixture A で後日）。

---

## 2. 結果（実測値）

| 指標 | cold（cache miss） | warm（再走査） |
|---|---|---|
| **avg frame** | **196.8 ms** | **183.5 ms** |
| p50 / p95 / max | 192.8 / 235.5 / 278.3 ms | 183.3 / 192.8 / 199.9 ms |
| 実効 fps | ≈ 5.1 fps | ≈ 5.4 fps |

### pixel-API 内訳（1 フレームあたり）

| API | cold | warm | 備考 |
|---|---|---|---|
| **`<img> SVG decode`（capture）** | **4.0 回 / 73.2 ms** | 4.0 回 / 70.9 ms | **最大コスト。** foreignObject SVG → `Image` decode |
| `toDataURL`（capture の canvas inline） | 2.9 回 / 11.4 ms | 3.0 回 / 11.5 ms | capture 前の canvas→data URL |
| `getImageData`（buffer 化） | 4.0 回 / 10.3 ms | 4.0 回 / 8.6 ms | `canvasToRasterBuffer` |
| `drawImage`（合成/scale） | 4.0 回 / 8.7 ms | 4.0 回 / 8.0 ms | master 累積・scale |
| `putImageData`（overlay 提示） | 3.0 回 / 1.5 ms | 3.0 回 / 1.4 ms | `presentRasterCanvas` |
| `createImageBitmap` | 0 | 0 | export 専用（preview では出ない） |
| **`readPixels`** | **0** | **0** | **preview に GPU readback は現状ゼロ**（plan §7.1 の前提を実測確認） |

生データ: `bench-gpu-raster-baseline.json`。

---

## 3. 読み取り（confirmed / to-investigate を分離）

### confirmed（実測が根拠）

1. **capture（foreignObject SVG decode）が単独で支配的** — cold の実効処理時間のうち `<img> decode` が **~73ms/frame**。`toDataURL`(11) と合わせ **capture 系だけで ~85ms/frame**。plan §0-1 / §2.1 の「capture の直列コストが最大」を裏付ける。
   → **GPU 化の最初の効果は「合成の GPU 化」より前に、まず capture 回数を減らす／decode を避けることに強く依存する。** これは Phase 2（合成のみ GPU 化・capture は foreignObject 据置き）だけでは capture コストが残ることを意味する。**Phase 6（HTML-in-Canvas direct texture capture）の価値が想定より高い**可能性が数値で出た。
2. **getImageData/putImageData 往復が実在** — `getImageData` ~10ms + `putImageData` ~1.5ms/frame。plan §0-2 / §6.3（adjustment ping-pong の GPU 化）・§6.1（matte shader）の直接対象。
3. **preview に `readPixels` はゼロ** — 現状 preview は純 CPU/Canvas2D。GPU compositor 導入後に「preview 中 readPixels を増やさない」（plan §7.1・受け入れ §5）が守れているかを、この 0 を基準に監視できる。
4. **4 capture + 4 getImageData + 3 putImageData / frame** — 9+4 レイヤーの重い comp で、レイヤーごとの個別 raster/合成が積み上がる構造を確認。

### to-investigate（次アクション）

- **[重要] warm ≒ cold（差 ~7%）** — 再走査でも capture 回数が減らない（cold 191 / warm 192 decode）。`frameRenderCache` は PreviewPanel に配線済み（`setFrameRenderCache`）だが、**interactive re-scrub でヒットしていない**。原因候補: (a) memory tier の LRU 上限 < 走査エントリ数（48fr×複数 raster）で先頭が evict、(b) `void put` の非同期完了前に次フレームへ、(c) nested raster / adjustment backdrop が別キーで毎回再計算。
  → Phase 0 追補で `TieredFrameRenderCache` の hit/miss を計測し、**L1 表現の最適化（plan §7.3: ImageBitmap/GPU texture 保持）**の効果見積りに使う。ここは GPU 化と独立に効く可能性がある。
- **合成（blend drawImage）の真コスト** — preview の blend は CSS `mix-blend-mode`（live・capture 不要）で、`drawImage` 8.7ms は主に master 累積 + scale。**export 経路（`compositeExportFrame`）の per-layer capture + Canvas2D 累積は preview と別コスト構造**なので、export 側の実測は別途必要（§4）。

---

## 4. 未計測（Phase 0 残・次セッション候補）

- **export 経路（`compositeExportFrame`）の per-layer 計測** — preview は live blend だが export は per-layer 個別 capture。primary GPU target なので export 側 baseline を別途取る（PNG 連番 or mp4 を UI/exposed hook 経由で駆動）。
- **fixture A（軽量 comp）** — 「GPU 化で軽量 comp が遅くならない」ゲートの下限値。
- **4K / レイヤー数スケール** — capture コストの解像度・枚数依存。
- **cache hit/miss 計測** — 上記 warm≒cold の機序確定。

---

## 5. Phase 2 の投資対効果（この計測からの示唆）

- 合成のみ GPU 化（Phase 2〜3）で削れるのは主に **getImageData/putImageData(~12ms) + drawImage(~9ms) + blend/matte/adjustment の CPU 分**。capture(~85ms) は残る。
  → **Phase 2 単独の preview 改善は「実効処理の 2〜3 割」程度**と見積もる。大きな伸びは capture 削減（Phase 6 / cache L1 表現）と export 経路の per-layer capture 削減に依存。
- したがって導入順の再確認: Phase 1（seam）→ Phase 2/3（合成 GPU 化・parity 確立）は**正しく進めつつ**、`frameRenderCache` の L1 表現最適化（§7.3）を **Phase 2 と並行して早めに評価**する価値が数値上ある（capture 回数そのものを減らす唯一の低リスク手）。
- この結論は plan の Decision（合成を先に GPU 化）を否定しない。Phase 2 は parity/seam の土台として必須。ただし「preview が劇的に速くなる」期待は capture 側の手当てとセットで持つべき、という**定量的な補正**が得られた。

---

## 付録: 再現とベースライン運用

- スクリプト: `bench-gpu-raster-baseline.mjs`（root・page-only 計測・source 非改変）。
- 出力: `bench-gpu-raster-baseline.json`（`when` タイムスタンプ付き）。
- GPU 化の各 Phase 後に同スクリプトを再実行し、`avgFrameMs` と API 内訳（特に `getImageData`/`putImageData`/`imageDecode`/`readPixels`）を本表と比較する。**readPixels が preview で 0 を超えたら plan §7.1 違反として要調査。**
