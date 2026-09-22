# Issue #209 — Step 7 capture owner

Date: 2026-09-23. Branch/worktree: `codex/issue209`, `.worktrees/issue209`.

## Delivered

`app/voiceoverCaptureOwner.ts` owns one microphone permission request, stream,
tracks, shared playback `AudioContext` reference, worklet capture, WAV worker,
and serialized cleanup. `start()` pins the active audio lane and calls
`getUserMedia()` in the same synchronous initiating call, after visible/focused,
format, destination and capability checks. Permission rejection is classified as
denied, dismissed, or device unavailable. The app owner retains native objects;
`state/voiceoverCaptureStore.ts` contains only session status, source label,
sample count, and diagnostic text. Closing replaces the live batch count with
the committed or recovered count.

A first-sample worklet message moves the session out of count-in. The worklet
module loads before the provisional sample frame is chosen. Step 8 will replace
that provisional frame with the shared playback/count-in anchor. Stop sends the
worklet command before stopping input tracks. Interruption aborts the graph and
releases the writer; explicit review reopens the last valid OPFS checkpoint.
That checkpoint can contain zero samples for a short interrupted take. The
status says how many samples survived and warns that recent audio may be lost.
Manual stop flushes the final partial batch and reports the committed sample
count. There is no product record/keep UI yet.

Project exit and project activation call the voiceover teardown hook before
transport and media teardown. A failed cleanup leaves the old editor active.
A pending permission chooser cannot be forcibly closed; if it resolves after
cancel/project replacement, its returned stream is stopped and cannot enter a
writer or the new project. Changed project/sequence/edit identity interrupts a
live take. The app revision advances on each store change, including undo/redo
and active sequence navigation.

## Fault and browser evidence

- Unit faults cover denial, dismissal, missing device, unsupported capability,
  hidden/unfocused or invalid destination, late permission after cancel,
  track ending, hidden/freeze/pagehide events, normal stop, interrupted
  checkpoint recovery, failed discard and retry, failed graph stop and recovery
  retry, project replacement during pending writer creation, review draft
  retention, stale worklet callbacks, and monotonic edit revision. Project
  controller tests prove exit waits for voiceover and a teardown error prevents
  transport/media disposal.
- Real Chromium with a synthetic `MediaStreamDestination` source exercised the
  production AudioWorklet and OPFS writer through the app owner. Normal stop
  reached review with samples committed, track ended, and cancel removed the
  draft. Hidden interruption ended the track and reached review by reopening
  the last durable checkpoint. The short hidden take recovered zero samples,
  as permitted by the 256 KiB checkpoint interval, and showed the loss
  diagnostic. The two Step 6 Chromium bridge tests also passed. These flows
  do not qualify a physical microphone, native permission UI, operating-system
  device loss, real tab suspension, or transport alignment; those remain for
  the later acceptance gate.

Commands and results:

```text
NODE_OPTIONS=--no-experimental-webstorage npm test -- src/app/voiceoverCaptureOwner.test.ts src/app/voiceoverWavBridge.test.ts src/app/projectController.test.ts src/domain/voiceoverSession.test.ts
  101 Vitest cases and 28 Node checks passed
npx playwright test tests/browser/issue-209-capture-owner.spec.ts tests/browser/issue-209-microphone-bridge.spec.ts
  4 Chromium tests passed
npm run build
  TypeScript and production build passed; existing large-chunk notice
npm run lint
  Passed; five existing warnings outside this step
git diff --check
  Passed
```

## Step 8 entry

The capture owner is callable and its native lifetime is bounded. Step 8 must
provide the actual transport/count-in sample anchor, edit/seek conflict policy,
and real alignment evidence. Its clock work should retain this cleanup owner and
keep the microphone graph digitally silent.
