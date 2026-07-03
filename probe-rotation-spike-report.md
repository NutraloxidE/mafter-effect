# Motion Track Phase 0b — Rotation Spike Report

- Date: 2026-07-03
- Gate: yaw error < 10%, |axis·Y| > 0.9, Horn+RANSAC median < 150 ms/frame

## 0b-1 — QUAR `inlier_points()`

| Check | Result |
|-------|--------|
| Return type | `number` |
| Coordinate pairs | **NO** — returns inlier **count** only |
| Sample counts (f0–9) | 0, 171, 170, 168, 168, 166, 164, 161, 161, 160 |

**Conclusion**: OpenCV.js KLT path required for real-footage correspondences (user-approved vendor).

## Horn self-test (200 point pairs, known Δ=0.006)

| est Δ | err |
|-------|-----|
| 0.006010 | 0.17% |

## 0b-3 — Horn on synthetic yaw clip B

| Metric | Value | Threshold | Pass |
|--------|-------|-----------|------|
| Cumulative yaw error | 0.10% | < 10% | ✅ |
| Mean \|axis·Y\| | 1.0000 | > 0.9 | ✅ |
| Horn+RANSAC median | 0.10 ms | < 150 ms | ✅ |
| GT cumulative yaw | 0.3300 rad | — | — |
| Est cumulative yaw | 0.3303 rad | — | — |

Correspondence source for this gate: **synthetic_pinhole_3d_unit_dirs (production uses pixel bearings + focal length; OpenCV KLT for real footage)**

## Gate decision

**PASS** — Phase 1b-a implementation may proceed (delegate-to-cursor).
