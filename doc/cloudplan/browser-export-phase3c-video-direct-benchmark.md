# Browser Export Phase 3c — simple 2D video direct capture

Date: 2026-07-20

## Change

For browser MP4/WebM export only, a decoded, effect-free single 2D video component is drawn from its seeked `<video>` element directly into a full-composition transparent canvas. This removes the former per-frame video-to-JPEG data URL, foreignObject SVG decode, and extra image draw. The adapter preserves resolved affine transform, opacity, and `contain` / `cover` / `fill` placement.

The adapter is deliberately narrow. Split/packed alpha, effects, mattes, matte sources, adjustment layers, 3D/non-affine transforms, nested or multi-component content, and undecoded media use the existing foreignObject fallback. PNG sequence, `compFrameCapture`, bundle bake, and preview do not opt in.

## Method

- Harness: `bench-gpu-raster-export-baseline.mjs`
- Input: `for-debug-data/video_motion.mp4`
- Fixture: existing 1280×720 heavy composition plus one top-level 2D video layer
- Output: MP4, 24 frames at 30fps, native scale, GPU compositor/direct surface enabled
- A/B seam: `BENCH_DIRECT_VIDEO=0|1`, same build
- Repetitions: 3 paired runs
- Pixel check: decoded output at the midpoint, downsampled to 64×36 RGBA (`BENCH_OUTPUT_SAMPLE=1`)

## Result

| Metric | Before median | After median | Change |
|---|---:|---:|---:|
| Wall time | 5756.8 ms | 4717.8 ms | **-18.0%** |
| Steady frame average | 195.6 ms | 105.5 ms | **-46.1%** |
| `toDataURL` calls / 24 frames | 96 | 72 | **-24** |
| SVG image decodes / 24 frames | 243 | 219 | **-24** |
| `drawImage` calls / 24 frames | 340 | 316 | **-24** |

All three pairs improved in both wall time and steady frame time. The direct adapter ran for 24/24 frames in every ON run and 0/24 in every OFF run. Output metadata remained MP4, 1280×720, 0.8 seconds; page errors remained zero.

The encoded byte size changed from 425,642 to 244,167 bytes because the old path JPEG-compressed each decoded source frame before final encoding while the direct path preserves the decoded video pixels. This is an expected raster-quality improvement, not a scene/timing change.

## Pixel parity

Two sampled A/B pairs produced the same metrics:

- RGB MAE: **0.179 / 255**
- maximum absolute channel difference: **9 / 255**
- channels with absolute difference greater than 3: **0.839%**
- channels with absolute difference greater than 10: **0%**

The small difference is consistent with removing the lossy intermediate JPEG. Resolved scene values, source seek time, frame timestamps, dimensions, and duration are unchanged.

## Decision

Enable the adapter by default for its narrow browser-video-export eligibility set. Keep `globalThis.__mafterDirectVideoCapture = false` as a non-serialized A/B/rollback seam. Any failed readiness check or direct `drawImage` falls back to the established foreignObject capture in the same frame.
