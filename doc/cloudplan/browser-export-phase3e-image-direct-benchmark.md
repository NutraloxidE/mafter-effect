# Browser Export Phase 3e — simple 2D image direct capture

Date: 2026-07-20

## Change

For non-alpha browser MP4/WebM export, a decoded, same-origin/CORS-safe, effect-free single 2D image is drawn directly from its live `HTMLImageElement` into a full-composition transparent canvas. The adapter preserves resolved affine transform, opacity, and `contain` / `cover` / `fill` placement.

The direct result uses the existing one-entry layer cache. Static images are drawn once and reused; transform/opacity/asset/fit changes replace the entry without foreignObject serialization. Undecoded or unsafe cross-origin images, effects, mattes, adjustment, 3D/non-affine transforms, nested or multi-component content retain the existing fallback.

## Method

- Harness: `bench-gpu-raster-export-baseline.mjs`
- Fixture: existing 1280×720 heavy composition plus one generated 320×180 PNG with a linear position animation over 24 frames
- Output: MP4, 24 frames at 30fps, native scale, GPU compositor/direct surface enabled
- A/B seam: `BENCH_DIRECT_IMAGE=0|1`, same build
- Repetitions: 3 paired runs
- Pixel check: decoded midpoint at 64×36 RGBA

## Result

| Metric | Before median | After median | Change |
|---|---:|---:|---:|
| Wall time | 4128.4 ms | 3371.8 ms | **-18.3%** |
| Steady frame average | 119.3 ms | 92.2 ms | **-22.7%** |
| SVG image decodes / 24 frames | 239 | 215 | **-24** |

All three pairs improved. Direct image capture ran 24/24 frames in every ON run and 0/24 in every OFF run. Page errors were zero, and output metadata remained MP4, 1280×720, 0.8 seconds.

## Pixel parity

All three pairs produced the same decoded midpoint metrics:

- RGB MAE: **0.054 / 255**
- maximum absolute channel difference: **4 / 255**
- channels with absolute difference greater than 3: **0.101%**
- channels with absolute difference greater than 10: **0%**

Encoded size changed from 70,608 to 64,059 bytes consistently. The small raster difference is the browser's direct Canvas2D image filtering versus the former foreignObject/SVG filtering; it stays within the established raster-fidelity allowance while preserving the same resolved scene and placement.

## Decision

Enable by default for the narrow non-alpha browser-video-export eligibility set. Preserve `globalThis.__mafterDirectImageCapture = false` as a non-serialized rollback/A-B seam. Keep static cache lookup ahead of direct repaint and reject undecoded or unsafe cross-origin DOM images before entering the adapter.
