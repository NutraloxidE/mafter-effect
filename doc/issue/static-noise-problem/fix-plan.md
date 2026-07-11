# Fix plan: sample-safe bundle loop audio

## Goal

Eliminate loop-seam clicks for video embedded audio and standalone audio in HTML
bundles, including when adaptive visual frame skipping is active.  Timeline frame
progression remains audio-first; no schema, invariant, or `project.json` format
change is required.

## Design decision

Move audible bundle footage through a single Web Audio graph rather than relying on
per-render `HTMLMediaElement.volume` writes:

```text
HTMLVideoElement / HTMLAudioElement
  -> MediaElementAudioSourceNode
  -> fadeGain (sample-accurate loop/cut envelope)
  -> userGain (animated gain, control-rate)
  -> AudioContext.destination
```

The media elements remain the native decoders and video clock.  The audio graph owns
only audible gain and loop/cut transitions.  It must be created or resumed from the
existing autoplay-unlock gesture.

## Implementation steps

1. Add a bundle-only media-audio controller under `src/player/`.
   - Own one `AudioContext` and one media-element source per element.
   - Never create a second `MediaElementAudioSourceNode` for the same element.
   - Expose `prepare`, `unlock`, `setFrame`, `setPlayback`, `pause`, and `dispose`.

2. Route video embedded audio through the controller.
   - Keep `DomRenderer` responsible for video decoding, image presentation, and
     clock samples.
   - Disable direct audible `video.volume` automation for controller-owned bundle
     videos; leave preview and export behavior unchanged.
   - Schedule a sample-accurate fade-out before a loop seek, hold silence through
     the seek, then fade in after the new position is playable.

3. Route standalone audio layers through the same timing model.
   - Correctly map composition time to each layer with `inPoint`, `outPoint`, and
     `trimStart`.
   - Preserve `sampleGain` as the single source for animated user gain.
   - Stop or mute inactive layers independently of visual render cadence.

4. Make loop handoff explicit in the playback loops.
   - Add a loop-boundary callback separate from `renderFrame`; it must run even if
     `renderGate` suppresses visual rendering.
   - Do not use a final visual render as an audio-fade guarantee.
   - Await only the bounded readiness needed for an unmuted seek; prevent duplicate
     loop handoffs while one is pending.

5. Keep the existing non-bundle paths intact.
   - Editor `PreviewAudioClock` and browser export retain their existing Web Audio
     / OfflineAudioContext paths.
   - Non-audio bundles still use the current adaptive render gate unchanged.

## Tests and verification

1. Unit-test pure layer-time mapping and loop-boundary state transitions.
2. Add a controller test with a fake AudioParam that asserts fade-to-zero is
   scheduled before every seek and that duplicate source-node creation is rejected.
3. Extend bundle tests for a video-only comp and an audio-layer comp with non-zero
   `inPoint` and `trimStart`.
4. Run the diagnostic in this directory before and after the fix.  After the fix,
   its code-path assertion should pass even though the source itself remains an
   intentionally unsafe raw loop seam.
5. Run `npm run typecheck`, focused audio/bundle tests, `npm test`,
   `npm run build:player`, and `playerBuildFreshness`.
6. In Chromium, record several Comp 10 loop handoffs.  Require no audible seek while
   fade gain is above the configured silence threshold, no unhandled `play()`
   rejections, and continuous visual playback.

## Risks

- `MediaElementAudioSourceNode` is one-shot per element/context.  Renderer pooling
  must notify the controller about reuse and disposal instead of rebuilding nodes.
- Autoplay policy requires the AudioContext resume and media unmute to happen in the
  first user gesture.  The present muted-autoplay behavior must remain intact.
- The graph changes the bundle audio path only.  Do not use it to refactor export or
  editor preview in the same patch.
