# Issue #209 — Step 8 transport join

Date: 2026-09-23. Branch/worktree: `codex/issue209`, `.worktrees/issue209`.

## Delivered

The capture owner arms the existing Program transport after permission and
writer preparation. Audible timeline content supplies its playback session's
future anchor; a silent timeline gets a future sample-aligned anchor from the
same 48 kHz `AudioContext`. Count-in clicks, the video playback engine, and the
capture-only microphone worklet use that one anchor. The selected timeline
start frame maps to the worklet's first recorded sample with exact rational
frame/sample math. The count-in never enters the WAV.

Normal Stop schedules an exact timeline-frame boundary at least 4,800 samples
ahead, keeps the input live through that boundary, then verifies the complete
sample window and committed WAV length before review. The status records the
anchor, count-in start, selected frame, stop frame/sample, and latency
estimates. Physical compensation defaults to **zero samples**, consistent with
[Step 1's measured policy](STEP_1_CLOCK_PROOF.md); the reported latency values
do not silently shift a take. A missed anchor or short input fails explicitly
instead of padding an apparently valid draft. A deliberate late connection in
Chromium reached that missed-anchor failure and retired its microphone track.

Transport changes during a take interrupt it. Direct seek, scrub, play/pause,
device change, project/sequence change, media change, and existing edit
revision checks stop or reject conflicting work. A cancelled count-in stops
the graph, count-in cues, transport, and input track before the planned anchor.
The worklet permits skipped render callbacks before its anchor because no
samples exist yet, while retaining strict continuity after capture starts.

## Verification

- Focused Vitest: 117 cases passed across clock math, capture owner, transport,
  and audio playback scheduling. The 28 Node runner checks also passed. An
  audible timeline unit case checks the requested lead, adoption of the audio
  session anchor, frame progression, seek interruption, and cleanup. Another
  interrupts an in-flight audio prime on an edit.
- Real Playwright Chromium exercised the production transport, `AudioWorklet`,
  OPFS writer, and a generated live `MediaStreamDestination` input. The normal
  take reached review with `capturedSamples = stopSample - anchorSample`, and
  `stopSample` equalled the exact selected timeline-frame boundary. The video
  playhead tracked the same anchor within two frames when sampled from the main
  thread. The missed-anchor case failed and stopped input. The count-in cancel
  case stayed cancelled past its former anchor. All three Step 8 cases and all
  four adjacent owner/worklet browser cases passed.
- `npm run build` passed TypeScript and production build, with the existing
  large-chunk notice. `npm run lint` passed with five existing warnings in
  unrelated files. `git diff --check` passed.

Commands:

```text
NODE_OPTIONS=--no-experimental-webstorage npm test -- src/domain/voiceoverClock.test.ts src/app/voiceoverCaptureOwner.test.ts src/app/transportController.test.ts src/pipeline/playback-audio.test.ts src/app/voiceoverMicrophoneBridge.test.ts
npx playwright test tests/browser/issue-209-transport-join.spec.ts tests/browser/issue-209-capture-owner.spec.ts tests/browser/issue-209-microphone-bridge.spec.ts
npm run build
npm run lint
git diff --check
```

## Qualification limit and next step

The Chromium stream was generated in the browser, so this step proves shared
clock/sample alignment and cleanup, not the acoustic latency of a physical
microphone and speakers. Step 1 found variable round-trip delay and could not
justify automatic correction. Physical-device capture and calibrated placement
remain the Step 12 acceptance gate. There is no record/keep product UI yet.
Step 9 must verify the finalized WAV, import it through the existing media
path, and optionally place it at the pinned destination.
