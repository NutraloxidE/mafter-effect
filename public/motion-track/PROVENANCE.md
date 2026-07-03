# QUAR Engine — Vendored Artifacts Provenance

Vendored WASM artifacts for the Video Motion Tracking feature.

- **Upstream project**: QUAR Engine — https://github.com/FunwayHQ/quar_engine
- **License**: MIT (see `pkg/LICENSE`)

## Current `pkg/` — built from source (2026-07-03)

- **Source commit**: `c3a04b11dddec7ded1981b966a1d675364a7756b` (upstream `main` HEAD, 2026-07-03)
- **Build**: `wasm-pack build --target web --release --out-dir pkg`
- **Toolchain**: rustc 1.96.1 (`stable-x86_64-pc-windows-gnu`), wasm-pack 0.15.0, wasm-opt via wasm-pack
- Note: `wasm-pack` emits a `pkg/.gitignore` containing `*`; it was removed so the artifacts can be committed.

| File | Size (bytes) | sha256 |
|------|--------------|--------|
| `quar_engine.js` | 103,340 | `DE84504DDEBF1F353946F48A51F6B0AAABDE7A21735AB78E16FD5549550902E1` |
| `quar_engine_bg.wasm` | 371,634 | `8F0B389535CBFDAC2155CC9AC2F7573DAC6FB3CCFA3477E73C6311D152C3A6C3` |

## Snapshot `pkg-pages-snapshot/` — original GitHub Pages prebuilt (superseded)

- **Distribution source**: GitHub Pages prebuilt `pkg/` — the repo ships no npm release / tagged binary.
- **Fetched**: 2026-07-03. Kept for reference; its `Tracker6DoFHandle` was measured inert (identity pose), same as the source build.

| File | Source URL | Size (bytes) | sha256 |
|------|-----------|--------------|--------|
| `quar_engine.js` | https://funwayhq.github.io/quar_engine/pkg/quar_engine.js | 103,342 | `8c483a1f061c9aa0af2973c5ff754e25bd677940b70394a912a9bccbe0de855d` |
| `quar_engine_bg.wasm` | https://funwayhq.github.io/quar_engine/pkg/quar_engine_bg.wasm | 334,329 | `6e051450914e3cee5955a94aa42d26b3faffe0486b4ce0a651501cd6043e73ca` |
| `quar_engine.d.ts` | https://funwayhq.github.io/quar_engine/pkg/quar_engine.d.ts | 47,311 | `0878dc205aeee60df74b06ce4393484d004d288f1bdfdee8f8a480bdebc8728e` |

## Notes

- These are wasm-bindgen (`--target web`) artifacts: `quar_engine.js` is the ES-module glue
  whose default export `__wbg_init(module_or_path?)` async-instantiates `quar_engine_bg.wasm`.
- Vendored for **editor-only** use. Must NOT be bundled into `public/player.js` or the HTML
  bundle export (loaded lazily via dynamic `import()` inside a Web Worker only when the user
  runs "Track Motion").
- License attribution (MIT) to be added to NOTICE / credits in Phase 1a (todo: notice-license).
