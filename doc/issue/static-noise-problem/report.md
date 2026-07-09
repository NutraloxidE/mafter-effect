# Static noise at bundle loop seams

- Status: investigated; no production fix in this issue directory yet.
- Scope: HTML bundle playback of video footage with embedded audio, using Downloads `mafter-project (25).zip` / `Comp 10` and `Comp_10_bundle (4).zip`.
- Date: 2026-07-10

## Conclusion

The primary cause is an audible discontinuity when a looping bundle seeks a native
`<video>` from the work-area end back to its start.  The existing declick mechanism
uses `HTMLVideoElement.volume`, which is only updated when the scene is rendered.
It cannot make a sample-accurate fade, and adaptive render skipping can omit the
last fade updates entirely.  The result is a click or crackle at every loop seam.

This is not an AAC decoding failure in the source asset.  It is a playback-control
problem at the bundle loop boundary.

## Reproduction fixture and measurements

`Comp 10` has one video layer with embedded audio:

| Item | Value |
| --- | --- |
| Comp | `Comp 10` (`01KVV05RE10X4E9H1AR77JPCH7`) |
| Timeline range | `[0, 112)` at 30 fps |
| Loop cut | 3.733333 s |
| Footage | `assets/01KWA0CRAPAJAKW4TP82JPDAWQ.mp4` |
| Source audio | AAC-LC, 48 kHz stereo |
| Raw seam jump, left | -0.0316361 |
| Raw seam jump, right | -0.0197550 |

The source does not happen to be loop-safe at 3.733333 s.  Its final sample before
the cut is non-zero while its first sample is zero.  A direct `currentTime = 0`
therefore produces a discontinuity unless the output is already effectively silent.

With the current 120 ms `autoFade` evaluated at 30 fps, the resolved video gain is:

| Timeline frame | Multiplier |
| --- | ---: |
| 108 | 0.999976 |
| 109 | 0.969979 |
| 110 | 0.798842 |
| 111 (last frame) | 0.362285 |

Even with every frame rendered, frame 111 resolves its gain at the frame centre but
can only assign `volume` at render cadence; it still leaves a non-zero output at the
seek. Under adaptive skipping, the renderer may instead last update volume at frame
108--110, leaving roughly 80--100% of the raw discontinuity.

## Code path

1. [`BundlePlayer.ts`](../../../src/player/BundlePlayer.ts) uses
   `runPreviewPlaybackLoop` when the composition has no standalone `audio` layer.
   `Comp 10` follows this path.
2. [`previewPlaybackLoop.ts`](../../../src/runtime/previewPlaybackLoop.ts) advances
   the timeline while `renderGate` is allowed to skip `renderFrame` calls.
3. [`resolve.ts`](../../../src/runtime/resolve.ts) applies the footage auto-fade to
   resolved video `gain` only for a rendered timeline frame.
4. [`DomRenderer.ts`](../../../src/runtime/DomRenderer.ts) writes that gain to
   `video.volume` and [`videoElementSync.ts`](../../../src/runtime/videoElementSync.ts)
   seeks the still-playing video at the loop wrap.

The visual frame skip is correct for an audio-master clock.  What is missing is an
audio-control path that remains continuous while visual rendering is skipped.

## Secondary finding

`BundleAudioClock` has a separate correctness gap for standalone `audio` layers:
it starts every `HTMLAudioElement` at `(fromFrame - rangeStart) / fps`, without
applying its layer `inPoint` or `trimStart`, and does not stop it at `outPoint`.
This does not cause the observed Comp 10 noise (it has no `audio` layer), but the
same fix should centralize footage-audio timing so the two HTML-element paths do
not diverge.

## Evidence limits

The numerical seam measurement proves the discontinuity in the actual source and
the code path proves that the discontinuity is directly seeked while non-silent.
Browser speaker output was not captured in this investigation, so the report does
not claim a calibrated loudness measurement.  The verification script records the
same fixture facts and is intended to become the regression gate after the fix.

## Run the diagnostic

```powershell
node doc/issue/static-noise-problem/verify-loop-audio-seam.mjs
```

Use `--help` for a different project zip or composition name.  The current Comp 10
fixture intentionally exits non-zero because it demonstrates the known unsafe seam.
