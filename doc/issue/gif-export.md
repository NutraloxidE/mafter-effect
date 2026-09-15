# GIF export — §11.2 additive behavior

Status: approved by user request on 2026-09-15.

## Scope

Add **GIF** to the normal download export dialog. This is an additive browser export format and does not change `project.json`, `CURRENT_SCHEMA_VERSION`, preview rendering, pre-render, or the MP4/WebM/HTML bundle contracts.

To keep INV-2 and the existing export pipeline stable, GIF does **not** add a second scene renderer. It reuses the canonical deterministic **PNG Sequence** export as its frame source, then post-processes those rendered PNG frames into one GIF file. The scene resolution, DOM render, video seeking, raster effects, adjustment compositing, proxy selection, and optional swarm frame production therefore stay on the existing PNG export path.

## User-visible contract

- Download mode exposes `GIF (animated, no audio)` alongside MP4, WebM, PNG Sequence, and Static HTML.
- GIF export uses the selected frame range, FPS, scale, alpha setting, and text render mode.
- GIF has **no audio**.
- The animation loops indefinitely.
- GIF is palette based: output is limited to 256 palette entries. The first implementation uses a deterministic fixed palette so identical rendered frames produce identical GIF bytes.
- When Alpha is enabled, GIF transparency is **1-bit** (`alpha < 128` becomes transparent); partial alpha cannot be represented by GIF.
- GIF delay units are centiseconds. Frame delay is derived from cumulative rounded frame times so common rates such as 24/25/30/50/60 fps preserve average timing as closely as GIF permits. Delays are at least 1 cs, so rates above 100 fps cannot be represented exactly.
- Cancellation remains available while rendering and while GIF frames are being encoded.

## Non-goals

- Do not route GIF through WebCodecs or audio mixing.
- Do not change `ExportConfig["format"]`; GIF is a download/UI post-processing format whose canonical frame export remains `png-seq`.
- Do not alter `src/runtime/exporter.ts`, renderer behavior, bundle export, pre-render, or project serialization.
- Do not add a third-party GIF dependency in the first implementation.

## Verification

- Unit-test GIF timing, RGBA-to-palette quantization, deterministic output header/trailer, and input validation.
- Validate the encoder output with an independent GIF decoder during implementation.
- Run the repository typecheck/test/build gates and a browser export smoke when the execution environment permits it.
