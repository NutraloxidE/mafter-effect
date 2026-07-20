# Browser Export Phase 3d — simple 2D solid direct capture

Date: 2026-07-20

## Change

For non-alpha browser MP4/WebM export, an effect-free single 2D solid with resolved color and size is painted directly into a full-composition transparent canvas using its resolved affine transform and opacity. Invalid geometry/color, effects, mattes, adjustment, 3D/non-affine transforms, nested or multi-component content use the existing foreignObject path.

The direct result participates in the existing one-entry layer cache. A static solid is directly painted once and then reuses that canvas; a transform/opacity/color/size animated solid receives a fresh direct paint only when its resolved signature changes. This avoids replacing cheap cache hits with repeated full-canvas allocation.

## Method

- Harness: `bench-gpu-raster-export-baseline.mjs`
- Fixture: existing 1280×720 heavy composition; one otherwise-safe solid receives a linear position animation over the 24-frame range
- Output: MP4, 24 frames at 30fps, native scale, GPU compositor/direct surface enabled
- A/B seam: `BENCH_DIRECT_SOLID=0|1`, same build
- Repetitions: 3 refined paired runs
- Pixel check: decoded midpoint at 64×36 RGBA for every run

## Result

| Metric | Before median | After median | Change |
|---|---:|---:|---:|
| Wall time | 3887.4 ms | 3365.3 ms | **-13.4%** |
| Steady frame average | 111.8 ms | 94.4 ms | **-15.6%** |
| SVG image decodes / 24 frames | 242 | 215 | **-27** |
| `drawImage` calls / 24 frames | 315 | 288 | **-27** |

All three pairs improved. Direct solid capture ran 27 times in each ON run: four first-frame solid paints plus 23 changed frames of the animated solid. Static solids then hit the existing cache. OFF runs used direct capture zero times.

## Parity

- MP4 size: **14,880 bytes in every OFF and ON run**
- Decoded metadata: **1280×720, 0.8 seconds** in every run
- Midpoint 64×36 RGBA: **byte-identical** in all three pairs (`maxAbs=0`, differing values=0)
- Page errors: zero

## Decision

Enable by default for the narrow non-alpha browser-video-export eligibility set. Preserve `globalThis.__mafterDirectSolidCapture = false` as a non-serialized rollback/A-B seam. Keep static cache lookup ahead of direct repaint so unchanged solids retain one-canvas reuse.
