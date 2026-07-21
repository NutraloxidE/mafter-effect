# Browser Export Phase 6 — Experimental multi-render-context ベンチマーク

`doc/cloudplan/browser-export-max-speed-plan.md` の **Phase 6（Experimental multi-render-context）** の
実装・計測・採否判定の記録。

## 何を試したか

browser export のフレーム描画（`resolve` → DOM render → foreignObject capture → Canvas2D 合成）は
本来 1 renderer で直列。dominant cost は foreignObject SVG の `img.decode()`。**複数の隔離 render
context** を作り、frame を `fi % N` でラウンドロビン分配して並行実行し、ある context が decode を
待つ間に別 context の同期描画を進めることで capture-bound comp の wall 短縮を狙った（Remotion 型の
frame concurrency）。

- フラグ（非直列化・既定 OFF）: `globalThis.__mafterMultiRenderContext=true` / context 数
  `__mafterMultiRenderContextCount`（2..4、既定 2）。
- 実装: [src/runtime/multiRenderContext.ts](../../src/runtime/multiRenderContext.ts)（純関数ドライバ
  `runOrderedMultiContext` + フラグ + `compTreeHasVideo`）、[src/runtime/exporter.ts](../../src/runtime/exporter.ts)
  に追加 context 構築と png/mp4/webm 経路の分岐。
- **決定論の担保**: どの context が描いても `resolve()` は純関数（INV-1）で同一結果。frame 結果は
  timestamp 昇順の bounded reorder queue（window = 2·N）で整列してから encoder / zip へ渡す。
- **共有と分離**: イミュータブルな `FontOutlineCache` / `ImageAssetCache` / 純関数 evaluator は context
  間で共有（duplicate decode 回避）、mutable な DOM / `DomRenderer` / HTML comp player は完全分離。
- **排他条件**: GPU compositor / 直接 capture 系最適化とは排他（常に純 Canvas2D 合成）。comp（ネスト
  先含む）に `video` component を含む場合・video 形式で worker export と併用する条件では無効化して
  従来の単一 context 経路へフォールバック（decoder 重複回避）。

## 計測

- ハーネス: [verify-multi-render-context-export.mjs](../../verify-multi-render-context-export.mjs)
  （実 Chromium / 実 WebGL）。fixture = 1280×720・video なし・HTML-heavy / frame 独立（BG + blend solid
  ×4 + text ×3、各 per-frame position keyframe）＝ capture-bound。
- N = 2 contexts、24 frame。

### 正しさ（PNG 連番 per-frame parity・正準ゲート）

| 指標 | 結果 |
|------|------|
| single vs multi の per-frame PNG **SHA-256 一致** | **24/24 完全一致（mismatch 0）** |
| context 別描画数（負荷分散） | `[12, 12]`（均等） |
| single 側 multi-context frame 数 | 0（既定経路が未変更なことを確認） |
| pageErrors | 0 |

→ **INV-2 成立**: どの context が描いても scene 解決値・capture 結果・合成順・timestamp が単一 context
経路とバイト単位で一致する。

### 性能（wall・情報）

| 経路 | single median | multi(2) median | 変化 |
|------|---------------|-----------------|------|
| PNG 連番 wall | 2533.4ms | 2756.4ms | **改善なし（やや悪化）** |
| mp4 wall（3 pair median） | ~2612ms | ~2827ms | **改善なし（+8%・ノイズ域）** |

- headless Chromium では WebCodecs mp4 encode が png-seq へフォールバックするため mp4 の絶対値は
  参考値（`mp4 encode ok=false`）。正準は PNG 連番の parity。

## 判定

**採用しない（既定 OFF・runtime opt-in のまま維持）。** PLAN Phase 6 の採用線
「2 contexts で wall ≥20% 改善 かつ peak memory 許容内」に届かない。

理由: browser export は single main thread で走り、この環境（headless / SwiftShader）では foreignObject
capture と `drawImage` が実質同期・CPU バウンドで、context を増やしても重ねられる非同期 decode 待ちが
少ない。2 context 目は DOM・メモリのオーバーヘッドだけを足す。Phase 4（worker・+2.9%）/ Phase 5（audio
overlap・+8.5%）と同じく、**正しく gate された opt-in 実験として温存**し、既定は単一 context に据える。

実 GPU で `img.decode()` が真に off-main-thread になる環境なら overlap が効く可能性は残るが、本 repo の
CI 相当環境では価値が出ないため既定 OFF が妥当。

## 恒久ゲート

- 純関数 unit: [test/multiRenderContext.test.ts](../../test/multiRenderContext.test.ts)（順序保証・有界
  reorder window・error/abort 伝播・`compTreeHasVideo`・フラグ clamp）。
- 実機 parity: `node verify-multi-render-context-export.mjs`（PNG per-frame SHA-256 一致 + pageErrors 0
  で exit 0。mp4 encode は headless フォールバックのため exit code に含めない）。
