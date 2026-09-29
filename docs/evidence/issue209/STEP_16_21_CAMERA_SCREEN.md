# Issue #209 — Steps 16–21: camera and screen recording, final integration

Date: 2026-09-29. Built only on the substrate proven in
[Steps 13–15](STEP_13_15_AV_FEASIBILITY.md).

## Delivered

- **Pure rules:**
  - `domain/avCaptureClock` (timestamp, trim, pad, and drift rules)
  - `domain/avClockBridge` (the exact stamp→page-time bridge)
  - `domain/avCaptureSession` (session transitions with operation tokens and
    a pinned project)
- **Worker substrate:**
  - `workers/av-capture.worker.ts` owns the captures directory
    (`myrelith-captures-v1`), the transferred processor streams, and one
    sync-handle file.
  - `pipeline/avCaptureRecorder` encodes H.264 (VP9 fallback) and AAC (Opus
    fallback) through Mediabunny into a fragmented MP4 (1 s fragments, keyframe
    every 1 s). Writes are synchronous and bounded, with a flush every ≥ 1 MiB.
    Limits are 4 GiB / 60 min, and the recorder stops itself at either one,
    with a 64 MiB reserve for finalize.
  - `pipeline/fragmentedMp4Recovery` truncates a torn capture to its last
    complete `moof`+`mdat`.
  - The architecture guard sanctions exactly those three imports.
- **App owner** (`app/avCaptureOwner`), which mirrors the voiceover owner:
  - The browser prompt is requested inside the click.
  - The clock bridge is measured before recording.
  - A Web Lock is held per draft.
  - Every terminal path stops the tracks and closes the worker.
  - The source ending ("Stop sharing", tab closed, camera gone) finalizes the
    take for review. `freeze`/`pagehide` do the same. `visibilitychange` does
    **not**, because screen recording normally hides the editor.
  - A failed finalize recovers the flushed fragments.
  - A take never imports into a different project, and project replacement
    keeps the draft for recovery.
  - Keep goes through the ordinary `importMediaFromHandle` path, including its
    frame-rate decision dialog (live capture is variable-rate), and remembers
    the OPFS original.
- **Voiceover and capture are mutually exclusive.** Project exit drains both
  owners.
- **Recovery** lists `.wav` and `.mp4` drafts together and routes each to its
  own worker. Recover truncates and imports; Delete and Delete file work for
  both kinds.
- **UI:**
  - The toolbar entry is now **Record**: a REC badge with Stop for any active
    capture, plus a draft badge.
  - The panel is now **Record**, with Voiceover / Camera / Screen tabs
    (roving tablist with arrow/Home/End keys) and a live preview during camera
    and screen takes. The app attaches a muted clone of the track; React never
    holds a stream.
  - Camera: camera and microphone (or none) choices.
  - Screen: audio choice of none, tab/system audio, or microphone, plus hints
    about the browser chooser.
  - Plain-language failure text, including the macOS Screen Recording
    setting. Estimated-sync and drift notices; display-audio-withheld notice.

## Verification

- Focused unit tests:
  - clock (9), bridge (4), session (7)
  - fragment scan (5), worklet (9)
  - capture owner (11)
  - recovery (29, including capture routing)
  - Record panel UI (8 camera/screen, 12 voiceover/indicator)
- Real Chromium, `tests/browser/issue-209-av-capture-ui.spec.ts` (fake camera,
  auto-selected tab):
  - Camera take through the UI: Record → preview → Stop → Keep → Media Pool
    asset, 1280 wide, with audio. It is placed on V1 and plays 1.5 s with no
    render error; frames decode at start, middle and end; clean console.
  - Screen take of a real tab: closing the tab ends the take for review with
    an explanation, and Discard deletes the file.
  - A reload mid-camera-take badges one draft. Nothing is imported until
    Recover, which keeps the complete fragments.
- Final gate after the review fixes:
  - full Vitest: 5,596 tests in 425 files
  - runner: 28/28
  - `npm run build` passed
  - `npm run lint`: 5 existing warnings only
  - `git diff --check` passed
  - all 17 Issue #209 Chromium specs passed

## Qualification and limits

- Physical camera lip sync and whole-screen/window capture are unverified on
  this host (no usable camera; OS screen permission not granted to the test
  browser). The code paths are the ones proven with tab capture and Chromium's
  camera device.
- Tab audio carries Chromium's constant capture latency (66 ms measured). It
  is preserved as recorded, not "corrected".
- One audio source per screen take (no display + microphone mix).
- Captures import with the ordinary frame-rate decision because live capture
  is variable-rate.

## Final review (Step 21) and fixes

An independent review of the complete camera/screen diff found nine defects.
All are fixed and covered:

1. **One ending or silent source stalled the muxer.** Mediabunny's
   fragmented interleaver writes nothing while any open track has an empty
   queue, so the other track piled up in worker memory and nothing reached
   disk. Now either source ending self-stops at once. A watchdog re-encodes
   one retained clone of the last frame every second while the picture is
   static, and ends the take for review if audio falls more than 2 s behind
   video. The 60-minute limit is checked on the audio clock too. A new
   real-Chromium test records a never-changing tab with a microphone: bytes
   keep growing on disk mid-take, and video and audio both run past 4.5 s,
   within 1.1 s of each other.
2. **The clock bridge chose the wrong lag for perfectly regular frames.**
   Neighbouring lags were equally dense and the tie went to the lowest (the
   reviewer reproduced +100 ms). Delivery times now bound the offset from
   below (a frame cannot arrive before capture). The smallest causal dense
   cluster wins, and without delivery times an ambiguous result is refused.
3. **A static screen's only frame could lose the race to the first audio.**
   One clone is now kept and becomes the base once audio exists.
4. **A worker crash during recording went unnoticed.** The bridge now reports
   `onCrash`, the owner interrupts (`worker-lost`), and Stop recovers the
   complete fragments.
5. **Tab capture focused the shared tab, hiding the editor**, which stops
   `requestVideoFrameCallback` and forced the estimated fallback.
   `CaptureController.setFocusBehavior('no-focus-change')` is now set.
   `play()` is raced against the calibration timeout.
6. **A failed start left an empty draft** and could not cancel streams locked
   by the recorder. The worker now aborts through the recorder and deletes the
   file.
7. **Leaks:** held audio is closed if a replay throws, and a frame still in
   flight when calibration times out is closed.
8. **An unrecoverable take could reach review via retry.** Takes now track
   `finalized`; with nothing playable, they fail with a plain message and the
   empty file is removed.
9. **Keep versus project exit:** project exit waits for a committed Keep, and
   the original is remembered under the binding pinned when Keep started.

While fixing (1), a first attempt cloned the frame *after* encoding. Closing a
`VideoSample` closes its frame, so every take failed. The clone is now taken
before encoding. The tab flash/beep take was rerun after these changes:
9/9 paired, audio 65.5 ms after picture, spread 9.8 ms (unchanged).
