# Preview Startup Probe Report

Phase 0 計測ハーネス（scripts/probe-preview-startup.mjs）の実測値。
固定テストプロジェクト: for-debug-data/_pj17（動画5本+画像1枚, 27 comps の実プロジェクト展開済みフォルダ）。

| timestamp | label | firstRenderMs(median) | lcpMs(median) | maxLongTaskMs(median) | totalLongTaskMs(median) | longTaskCount(median) | loadFromProjectMs(median) |
|---|---|---|---|---|---|---|---|
| 2026-07-07T10:04:02.180Z | phase0-baseline | 279 | 200 | 69 | 132 | 2 | 290 |
| 2026-07-07T13:24:18.499Z | phase1-https-h2 | 331 | 236 | 82 | 155 | 2 | 367 |
| 2026-07-07T13:31:13.457Z | phase2a-slice-removed | 347 | 236 | 91 | 173 | 2 | 313 |
| 2026-07-07T13:32:07.764Z | ab-with-slice | 356 | 252 | 88 | 168 | 2 | 347 |
| 2026-07-07T13:32:30.616Z | ab-slice-removed | 367 | 240 | 96 | 181 | 2 | 315 |
