# MediaPipe Tasks Vision — Subject Extract

- **Package**: `@mediapipe/tasks-vision@0.10.18` (npm)
- **License**: Apache-2.0
- **Usage**: editor-only lazy load on Subject Extract (Person). Not bundled in main app or `player.js`.
- **WASM**: copied from `node_modules/@mediapipe/tasks-vision/wasm/` → `public/subject-extract/mediapipe/wasm/`
- **Model**: `selfie_segmenter.tflite` (float16) from Google MediaPipe model bucket
  - URL: https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite
- **APIs used**: `FilesetResolver.forVisionTasks`, `ImageSegmenter.createFromOptions`, `segment` (category mask)
