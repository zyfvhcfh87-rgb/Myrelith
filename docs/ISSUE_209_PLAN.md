# Issue #209 — local voiceover, camera, and screen capture

Status: proposed; awaiting user approval before product implementation.
Prepared 2026-09-21 on `codex/209`, based on `5b7a458` plus the local #203
commit `f738172`. Issue: https://github.com/zyfvhcfh87-rgb/Myrelith/issues/209

## Outcome and approval boundary

Record local media through an explicit editor action and browser permission,
finalize it as an ordinary Media Pool asset, and optionally place it at a pinned
timeline destination. Deliver microphone voiceover first. Advance to camera and
screen capture only after the voiceover clock, bounded-write, and recovery gates
pass. The later slices must prove their own A/V timestamp and storage contracts
before product UI is enabled. A failed gate is a documented no-go, not a reason
to silently accept drift or unbounded buffering.

This is the post-MVP plan gate required by `docs/PLAN.md`. Approval authorizes
the scoped implementation and validation below. A change to the product
boundaries or an unproven browser path requires a new decision. Publication,
merge, and issue closure are separate decisions.

## Existing seams

- `app/transportController.ts` and `pipeline/playback-audio.ts` share the exact
  `AudioContext` playback anchor with the video engine. Recording must join that
  owner; wall-clock timers and MediaRecorder chunk counts cannot place audio on
  integer timeline frames.
- `app/mediaImportController.ts` inspects a `File`, handles compatibility and
  frame-rate decisions, then atomically adds a ready asset. Capture may produce
  a file and local handle, but must not create a second asset/provenance path.
- `app/mediaPlacementController.ts` validates the live lane, collision policy,
  and one-history clip insertion. A recording destination is pinned before
  permission and revalidated after import; a failed placement leaves the media
  available in the Pool.
- `app/localMediaHandles.ts` stores origin-local file capabilities by local
  project binding and asset id. Portable projects retain metadata, not recorded
  bytes or browser handles. Capture storage needs its own explicit retention and
  reconnect policy; existing proxy/analysis caches are disposable and cannot
  own original recordings.
- `domain/time.ts` owns rational frame/sample conversion. New placement and
  compensation math stays there or in another pure domain module; UI only reads
  serializable capture status and calls an app-owned facade.

## Product contract

### Permission and session ownership

One app-owned capture controller owns one session, tracks, AudioContext/worklet,
writer, and cancellation/cleanup chain. Capture starts only from a visible,
focused user action. The click calls `getUserMedia()` or `getDisplayMedia()`
directly before an unrelated await can lose transient activation. Preflight
checks support, storage, destination, and conflicts first; the browser's native
permission chooser appears when the browser requires it, and Myrelith always
shows an active-capture indicator. Denial, dismissal, unsupported APIs, and
device loss produce distinct actionable states. No device is opened at startup,
after reload, or to preview a permission prompt. All tracks stop on every
terminal path. Project replacement waits for capture cleanup and prevents a
late finalization from entering the new project.

Only small status, source labels, elapsed sample/frame counts, and diagnostics
enter Zustand. Streams, buffers, Files, handles, object URLs, and native nodes
stay with app/pipeline owners. Capture does not enter project history until a
user keeps finalized media and optionally places it. Never record in a hidden
or frozen page. A visibility/freeze/pagehide event requests a stop and marks
the result interrupted; JavaScript suspension may prevent cleanup until resume,
so the UI must never claim uninterrupted capture in that case.

### Voiceover clock and monitoring

The user chooses one unlocked audio lane and an integer start frame. The
destination, project identity, sequence, rate, and starting edit revision are
pinned before the permission request. Count-in is scheduled on the same
`AudioContext` clock as timeline playback. The microphone enters a capture-only
`AudioWorklet` graph: no microphone signal is routed to speakers by default.
Playback/count-in may still leak acoustically through speakers; the UI advises
headphones and offers an explicit playback-muted option.

The worklet reports its sample-frame position. An exact rational conversion
maps the capture window to the selected timeline frame; samples before the
anchor are discarded and an under-run is padded or reported, never hidden by
moving the clip. The graph anchor defines deterministic *software* placement.
Browser/device input and output latency are estimates, so expose the measured
values and a bounded, signed user compensation in samples/frames. Do not claim
physical lip sync from `performance.now()`, `MediaRecorder.timeslice`, or an
unverified latency estimate. A focused loopback test and real-device check must
set the default policy and permitted adjustment range before the UI ships.
Count-in, stop, cancel, source ending, and keep produce exact, testable sample
boundaries. Playback edits or transport seeks during recording are locked or
stop the take with an explanation; a changed destination never receives a
late clip.

### Storage, finalization, and recovery

The first slice writes mono PCM/WAV to a dedicated OPFS recording directory
through a worker-owned sync access handle. The worklet transfers bounded sample
batches. The writer acknowledges batches; reaching a fixed in-flight byte
limit stops the take with an overrun diagnostic instead of growing a queue.
The worker checks every write count and flushes periodic valid checkpoints.
Keep patches the WAV header, closes the handle, reopens the file, verifies its
length and decode compatibility, then passes its `File` and handle to the
existing import controller. The first candidate limits one take to 60 minutes
and 512 MiB including header and staging; the measured gate may lower these.
Check estimated quota before start, but treat it as advisory and handle actual
quota/write failures. No entire-recording Blob or PCM array is assembled in RAM.

Cancel removes the draft after writer shutdown. A crash/reload enumerates
recording drafts and offers Recover valid flushed audio or Discard; a draft is
never silently imported. A kept OPFS original is retained as source media,
excluded from proxy/cache eviction, and is user-manageable. Its asset descriptor
remains portable; a project opened on another origin/device is offline until
relinked. Define removal and local-project-forget behavior so neither clips nor
undo history can refer to silently deleted original bytes. A browser storage
clear can remove OPFS files; recovery/relink must report that as missing media.
If OPFS or safe checkpointing is unavailable, voiceover is unavailable with a
clear reason; do not fall back to an unbounded in-memory recording.

### Camera and screen expansion

Camera plus microphone and screen/window/tab capture use a fresh chooser per
session. Screen audio and microphone are separate, explicit options; the UI
reports the audio tracks actually returned by the browser. Native display
sharing controls and source-ended events remain authoritative. Use one bounded
encoded-file writer with source timestamps carried from a documented common
clock; never infer A/V timing from event cadence. Before enabling either mode,
prove in real Chromium that capture, encoder/muxer, writer backpressure,
timestamp discontinuities, suspension, and final-file reopen preserve the A/V
relationship or report drift that cannot be corrected. `MediaRecorder` timeslice
is not a memory or clock bound, so it is not the planned capture foundation.
If the browser lacks a provable streaming path, leave that mode unavailable and
record the no-go evidence. No cloud, live stream, remote guest, unattended
recording, auto-upload, or implicit system-audio capture.

## Implementation and acceptance gates

1. **Feasibility proof.** Build disposable real-Chromium probes for worklet
   sample position, shared playback/count-in anchor, input/output latency,
   OPFS checkpoint/reopen/quota, and microphone permission/track ending. Measure
   main-thread suspension and writer backpressure. Record device/browser and
   exact thresholds. Resolve the voiceover default compensation and recovery
   format before production code. Stop if a bounded, decodable partial cannot
   be recovered.
2. **Pure contracts.** Add a browser-free capture state machine, exact rational
   sample-to-frame placement and signed compensation, pinned-destination
   validation, and size/duration limits. Test fractional rates, one-sample
   boundaries, count-in cancellation, source loss, stale project/lane,
   collisions, and keep/cancel idempotence.
3. **Voiceover runtime and storage.** Add app-owned session and worker writer
   with bounded ownership, flush acknowledgements, draft recovery, explicit
   failure classes, and complete cleanup. Connect to transport without a
   second timeline clock or a digital microphone monitor. Fault-inject denied
   permission, writer quota/short write, queue overrun, device ending,
   visibility loss, import refusal, and failed cleanup.
4. **Voiceover UI and import.** Add accessible source/destination/count-in,
   record/stop/cancel/keep/compensation controls with live status. Import via
   the existing compatibility/provenance path; place through the shared
   planner, leaving an unplaceable kept take in the Pool. Verify keyboard,
   focus, 720px layout, undo/redo, save/reload/relink, and no feedback route.
5. **Camera and screen go/no-go.** Research available Chromium track timestamp,
   encoding, muxing, and streaming APIs with bounded prototypes. Lock an
   explicit drift tolerance and discontinuity report from measurements before
   implementation. Prove source-ended, missing audio, permission denial,
   storage exhaustion, and partial-file behavior for both modes separately.
6. **Expanded runtime and final acceptance.** Implement only modes that pass
   Gate 5, using the same import/provenance and lifecycle owners. Run focused
   state/clock/storage tests, full Vitest, runner checks, production build,
   lint, and `git diff --check`. Run genuine headed Chromium microphone,
   camera, and screen permission/capture where available, reopen the produced
   files, inspect A/V alignment and storage behavior, and clearly label any
   host/device limitation. Fake-device automation is supplemental evidence,
   not a substitute for native chooser and physical latency checks.

Update ARCHITECTURE/HANDOFF/PLAN with the accepted ownership and actual gate
results. Commit accepted implementation with the Aryel author, message-file,
and Codex co-author convention. No product implementation occurs before this
plan is approved.

## Browser references checked during planning

- [MDN `getUserMedia()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia): secure context and browser permission are required.
- [MDN `getDisplayMedia()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia): transient activation and a fresh chooser are required; returned audio is optional.
- [MDN `AudioWorkletGlobalScope.currentFrame`](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletGlobalScope/currentFrame) and [audio track latency](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/latency): sample-frame position is available, while device latency is an estimate.
- [MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) and [storage estimates](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate): origin-private files can be streamed, but quota estimates are approximate.
- [MDN `MediaRecorder.dataavailable`](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/dataavailable_event): timeslice delivery may be delayed and chunks may become much larger than expected.
