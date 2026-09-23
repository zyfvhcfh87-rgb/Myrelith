# Issue #209 — local voiceover, camera, and screen capture

Status: scope approved in principle on 2026-09-21; Steps 0–8 complete; Step 9
is next and starts only on the user's request.
Prepared 2026-09-21 on `codex/209`; isolated onto `codex/issue209` from
`master` at `29d4071`. Issue: https://github.com/zyfvhcfh87-rgb/Myrelith/issues/209

## Outcome and approval boundary

Record local media through an explicit editor action and browser permission,
finalize it as an ordinary Media Pool asset, and optionally place it at a pinned
timeline destination. Deliver microphone voiceover first. Advance to camera and
screen capture only after the voiceover clock, bounded-write, and recovery gates
pass. The later slices must prove their own A/V timestamp and storage contracts
before product UI is enabled. A failed gate is a documented no-go, not a reason
to silently accept drift or unbounded buffering.

This is the post-MVP plan gate required by `docs/PLAN.md`. The user accepted
the scope and requested smaller execution steps to manage usage. A change to
the product boundaries or an unproven browser path requires a new decision.
Publication, merge, and issue closure are separate decisions.

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

## Staged execution and usage checkpoints

**One numbered step per user-requested work turn.** Finish its stated proof,
record the result, and stop with a concise handoff naming the next step. Do not
automatically continue into the next numbered step, even when usage remains.
Each implementation step ends with focused tests, production build/typecheck,
lint, `git diff --check`, and browser verification when its behavior is
observable. Commit a passing step with the Aryel author, message-file, and
Codex co-author convention. Research-only steps end with a committed evidence
note. The full suite is reserved for the integrated voiceover and final gates;
the focused suite stays small within each step. If a step becomes larger than
its described seam, split it into two numbered checkpoints *before* adding
more code. Each handoff records what changed, exact commands/results, remaining
risk, commit, and the next step's entry condition. This gives the user a clean
place to stop when usage is low.

### Preparation and voiceover proof

| Step | Bounded deliverable | Done when |
| --- | --- | --- |
| **0. Isolate #209** | Create a clean issue branch/worktree from current `master` and carry only this plan. The original `codex/209` started on an older base. | The #209 diff contains only its plan files, with no extra product commits or source changes; base/head and clean tree are recorded. |
| **1. Prove the voiceover clock** | Disposable Chromium probe for microphone worklet sample positions, shared playback/count-in anchor, track ending, and input/output latency on a real device. | Evidence names browser/device, observed jitter and latency, and the candidate compensation policy. No production capture code. |
| **2. Prove the recording store** | Disposable OPFS worker probe for bounded batches, backpressure, short writes, quota, periodic valid WAV checkpoints, crash/reopen, and cleanup. | A partially flushed take reopens and decodes within a measured memory/write bound; otherwise voiceover is a no-go pending redesign. Lock the recovery format and actual limits. |

Steps 1 and 2 are the **voiceover go/no-go gate**. Record the result before
starting Step 3. If either fails, stop at its evidence report and revise the
plan instead of building the dependent product path.

**Step 0 checkpoint (2026-09-21):** Fetched `origin/master`, fast-forwarded
local `master` to `29d4071`, and created `.worktrees/issue209` on
`codex/issue209`. Carried the two plan-only commits as `5db180f` and `93edc4b`.
The current issue branch differs from its base only in this plan and its
`docs/PLAN.md` link. The #203 product commit was merged into `master` by PR
#228 before this worktree was created; it adds no separate #209 branch diff.

**Step 1 checkpoint (2026-09-21):** A disposable headed Chromium probe on the
real USB microphone proved continuous worklet sample frames and shared-context
reference starts under a main-thread stall. Temporary permission revocation
ended the track. Acoustic round-trip delay varied, so the candidate automatic
physical offset is zero until the user calibrates it. The measurements and
limits are in [the Step 1 clock proof](evidence/issue209/STEP_1_CLOCK_PROOF.md).
At this checkpoint, the clock was a GO and the storage gate remained open.

**Step 2 checkpoint (2026-09-21):** A disposable Chromium OPFS worker probe
streamed a 60-minute-size WAV with a 64 KiB in-flight cap and recovered
decodable partial takes after worker termination, browser process kill,
short write, injected quota failure, and damaged checkpoint/header data.
The alternating checkpoint journal, bounds, observations, and limits are in
[the Step 2 storage proof](evidence/issue209/STEP_2_STORAGE_PROOF.md). Storage
is a qualified GO; together with Step 1, the voiceover feasibility gate passed.
Step 3 is the next requested unit. Product implementation remains unstarted.

**Step 3 checkpoint (2026-09-22):** Added pure `domain/voiceoverClock.ts`
sample/frame anchors, an exact count-in window, a fixed-length trim/pad plan,
and signed sample/frame compensation capped at ±0.5 seconds. Count-in and
recording both use the canonical rational audio sample grid; samples before
the capture anchor are never borrowed. Focused `voiceoverClock` and `time`
tests passed (39 Vitest cases); the test runner's 28 Node checks, build/
typecheck, and lint passed. Lint still reports five existing warnings outside
this change. No product UI or browser behavior is added in this step, so no
browser flow was needed. Step 4 owns session transitions and destination
validation; actual transport joining, real input, and placement remain later
gates.

**Step 4 checkpoint (2026-09-22):** Added pure `domain/voiceoverSession.ts`
and `domain/voiceoverDestination.ts`. The session rules cover permission,
preparation, count-in, recording, cleanup, review, keep, discard, and failure.
Session ids and operation tokens reject stale completions; repeated actions
issue no duplicate effect. A cancelled Stop cannot be completed by the older
Stop reply. Cleanup failure blocks a new session until cleanup succeeds.
Keep is accepted only from review; Cancel is disabled during that import
attempt, and a failed Keep returns to review. Source ending or interruption
stops an active take for explicit review. Project replacement retains the
draft and invalidates pending import completion.

Pinned intent copies project identity/generation, active sequence, edit
revision, lane, integer start frame, and rates. Existing media-placement rules
check lane kind/lock and full-range overlap, including compound items. Failed
placement leaves the take in the same project's Pool; project replacement
instead retains the draft. Step 7 must supply a monotonic edit revision that
includes undo/redo and navigation, dispose late resources even when their
events are ignored, and execute/acknowledge each cleanup effect. Step 9 must
revalidate before import and again immediately before placement; the pure
decision does not itself authorize a later commit after another await.

Validation: `NODE_OPTIONS=--no-experimental-webstorage npm test --
src/domain/voiceoverDestination.test.ts src/domain/voiceoverSession.test.ts
src/domain/mediaPlacement.test.ts` passed 41 Vitest cases and 28 Node runner
checks. `npm run build`, `npm run lint`, and `git diff --check` passed; the
existing bundle-size notice and five unrelated lint warnings remain. This
step adds pure domain rules with no observable browser behavior. Step 5 is
the next requested unit: implement the OPFS WAV writer proven in Step 2.

**Step 5 checkpoint (2026-09-22):** Added `pipeline/voiceoverWavDraft.ts`
with injected synchronous file I/O, the Step 2 two-slot checkpoint format,
exact write-count checks, periodic flushes, tail-truncating recovery, bounded
header/length finalization, and retryable close/discard. A dedicated OPFS
worker owns the recordings directory and serializes operations. The app bridge
transfers at most four 16 KiB batches (64 KiB total) before acknowledgements;
an overrun faults the take, so it cannot silently build a queue. Original WAVs
stay outside the disposable proxy and analysis caches. This step exposes a
production writer seam, not a microphone source or Media Pool import.

Focused tests covered short audio and journal writes, injected quota failure,
worker-loss tail recovery, torn newest checkpoint, invalid journal, changed
final length, close/discard retries, transfer credit, worker failure, and
reply mismatch: 11 Vitest cases plus the test runner's 28 Node checks passed.
`npm run build`, `npm run lint`, and `git diff --check` passed; lint still
reports the five existing unrelated warnings and Vite reports its existing
large-chunk notice. The checked-in Playwright test passed in real Chromium:
it wrote a 262,144-byte checkpoint, terminated the worker with a 16,384-byte
tail, recovered exactly 262,144 PCM bytes in a new worker, and decoded the
262,188-byte WAV as 131,072 mono samples at 48 kHz. This is worker-loss
evidence, not a power-loss or real-quota guarantee. Step 6 must connect the
microphone worklet to this bridge and prove real-time sample ordering, transfer
bound, overrun stop, and silent monitoring in Chromium.

**Step 6 checkpoint (2026-09-23):** Added a capture-only mono PCM16
`AudioWorkletProcessor` and `app/voiceoverMicrophoneBridge.ts`. The worklet
reports exact `AudioContext` sample frames, transfers at most four unacknowledged
16 KiB batches, and stops on overrun. The app bridge validates contiguous
frames and byte counts, acknowledges only completed writer appends, and
stops/checkpoints the writer after all accepted batches settle. The worklet fills its
output with zeroes; a zero-gain node guards the destination connection. Its
source stream is supplied by a later capture owner. [Step 6 evidence](evidence/issue209/STEP_6_MICROPHONE_BRIDGE.md)
records two passing real Chromium flows. The focused writer suite (11 Vitest
cases and 28 Node checks), build/typecheck, lint and diff check passed; lint
retains five unrelated warnings. Physical microphone and transport alignment
remain unqualified. Step 7 owns permissions, tracks, interruption and project teardown.

**Step 7 checkpoint (2026-09-23):** Added an app-owned microphone session
controller that requests permission on the initiating call, pins the destination,
owns stream, tracks, worklet and WAV writer, and publishes only serializable
status. It stops tracks on stop, cancel, source loss, hidden/frozen/pagehide,
failure, and project replacement. Project exit/activation waits for voiceover
cleanup before transport or media teardown. Delayed permission and worklet
callbacks cannot revive a cancelled or replaced session; cleanup failure blocks
the next take until retry. A monotonic app revision invalidates pinned intent
through edits, undo/redo and navigation. Interrupted takes reopen the last
durable checkpoint with a diagnostic that recent audio may be lost.

[Step 7 evidence](evidence/issue209/STEP_7_CAPTURE_OWNER.md) records the fault
matrix and synthetic-source Chromium checks. Focused tests passed 101 Vitest
cases plus 28 Node runner checks; build/typecheck, lint, and diff check passed
with the existing five lint warnings and Vite size notice. Four Chromium tests
passed across the owner and Step 6 bridge. There is no product recording UI yet;
the provisional start frame is not aligned to playback or timeline. Step 8
must join the shared transport clock and prove alignment before Step 9 keep/import.

**Step 8 checkpoint (2026-09-23):** The capture owner now arms Program
playback, count-in cues, the microphone worklet, and video transport on one
future 48 kHz sample anchor. An audible timeline uses the existing audio
session's anchor; an empty/silent timeline uses the same shared context clock.
Stop targets the next exact integer timeline frame with a bounded lead. Seek,
scrub, playback, device, project, and media changes interrupt the take; count-in
cancel stops the microphone and transport. The worklet tolerates inactive
pre-anchor render gaps but rejects missed anchors and in-take discontinuities.
Default physical compensation remains zero pending per-device qualification.
[Step 8 evidence](evidence/issue209/STEP_8_TRANSPORT_JOIN.md) records focused
tests, Chromium sample alignment and failure paths, build/lint, and limits.
Step 9 may now implement keep/import and optional placement.

### Voiceover implementation

| Step | Bounded deliverable | Done when |
| --- | --- | --- |
| **3. Clock math** | Pure sample/frame anchor, count-in window, trim/pad, and signed compensation functions. | Fractional frame rates, one-sample edges, and offset bounds pass focused tests. |
| **4. Session rules** | Pure state transitions and pinned project/sequence/lane destination validation. | Cancel/keep, source loss, stale destination, collisions, and repeat actions have deterministic tested outcomes. |
| **5. WAV writer** | Production worker-owned OPFS draft writer and checkpoint/recovery reader behind injected I/O. | Short write, quota, crash, discard, close, and final-file length tests pass; a bounded in-flight limit is enforced. |
| **6. Microphone bridge** | Worklet capture batches and acknowledgements into the writer with silence at the output. | Real Chromium proves bounded transfer, exact sample numbering, overrun stop, and no digital monitor signal. |
| **7. Capture owner** | App-owned permission, track, writer, cancellation, visibility, and project-teardown lifecycle with serializable UI status. | Denial, device ending, hidden/frozen page, cleanup failure, and late callbacks are fault-tested; every terminal path stops tracks. |
| **8. Transport join** | Schedule count-in and recording against the existing audio-master playback anchor; lock/stop conflicting seeks and edits. | A real take aligns with the selected integer frame under the measured compensation policy; cancel and under-run behavior is explicit. |
| **9. Keep and place** | Verify finalized WAV, import through `mediaImportController`, remember the OPFS original, and optionally place through `mediaPlacementController`. | Pool-only fallback, stale destination, collision, and one-history undo/redo pass. |
| **10. Drafts and reconnect** | Add explicit draft recovery/discard and safe kept-original removal/reconnect rules. | Crash/reload, missing-file relink, project save/reload, and local-project forget behavior pass without deleting referenced media. |
| **11. Voiceover controls** | Accessible source, lane, count-in, monitoring advice, compensation, record/stop/cancel/keep, and recovery controls. | Keyboard/focus, 720px layout, active-capture indicator, and in-app browser flows pass. |
| **12. Voiceover acceptance** | Run real-device capture/reopen/latency and interruption matrix, focused tests plus full Vitest/runner checks, build and lint; update ownership/evidence docs. | Voiceover acceptance is recorded with measured limits and any native-device qualification. Camera/screen remain disabled. |

Each row is a stopping point, including Step 12. A passing voiceover gate is
required before the A/V expansion below.

### Camera and screen expansion

| Step | Bounded deliverable | Done when |
| --- | --- | --- |
| **13. Prove common A/V timing** | Disposable Chromium probe for track timestamps, encode/mux order, writer backpressure, discontinuity, drift, and final-file reopen. | Evidence locks a candidate clock rule, drift tolerance/report, and memory bound; no product mode is enabled. |
| **14. Camera feasibility** | Real camera+mic probe for permission, source ending, suspension, storage failure, and partial-file behavior using the candidate path. | A separate camera go/no-go and measured A/V evidence are recorded. |
| **15. Screen feasibility** | Real display chooser probe for screen/window/tab frames, available audio, optional mic, self-capture, source ending, and partial output. | A separate screen go/no-go records which audio combinations and surfaces can be supported without unbounded storage or hidden drift. |
| **16. Shared A/V writer** | Implement only the encoded-stream/mux/storage substrate proven by Steps 13–15, reusing capture ownership rules. | Timestamp discontinuity, quota, bounded queue, partial-file, and final-file tests pass. Skip if both modes are no-go. |
| **17. Camera session** | Add camera+mic acquisition, lifecycle, finalization, ordinary import, and accessible camera controls. | Real permission, source loss, A/V sync, keep/cancel, and recoverable failure pass. Only attempt if camera passed Step 14. |
| **18. Camera acceptance** | Reopen real camera takes, measure drift, exercise storage/suspension/recovery, and run focused plus build/lint/browser gates. | Camera evidence records pass/no-go and device/browser limits. |
| **19. Screen session** | Add gesture-bound display acquisition, only the proven optional audio combinations, lifecycle, ordinary import, and accessible controls. | Source-ended, permission denial, no-audio, storage failure, keep/cancel, and track cleanup pass with real chooser evidence. Only attempt if screen passed Step 15. |
| **20. Screen acceptance** | Reopen real screen/window/tab takes and measure A/V relationship, partial recovery, and browser UI behavior. | Evidence records each available display mode and qualification; failed modes remain unavailable. |
| **21. Final integration** | Run full Vitest, runner checks, build, lint, exact browser capture matrix, and update ARCHITECTURE/HANDOFF/PLAN. Review the complete issue diff. | Every enabled mode has proven acceptance, limitations are explicit, and the clean committed branch is ready for a separate publication decision. |

Steps 16–20 depend on the relevant go/no-go result. A no-go for one mode does not silently
waive its acceptance criterion; report the reason and ask for a scoped issue
decision before calling #209 complete. Fake-device automation supplements
genuine headed Chromium permission/capture; it cannot substitute for a native
chooser or physical latency check. Publication, PR review, merge, and issue
closure are outside Step 21 and require their own requested delivery action.

## Browser references checked during planning

- [MDN `getUserMedia()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia): secure context and browser permission are required.
- [MDN `getDisplayMedia()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia): transient activation and a fresh chooser are required; returned audio is optional.
- [MDN `AudioWorkletGlobalScope.currentFrame`](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletGlobalScope/currentFrame) and [audio track latency](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/latency): sample-frame position is available, while device latency is an estimate.
- [MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) and [storage estimates](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate): origin-private files can be streamed, but quota estimates are approximate.
- [MDN `MediaRecorder.dataavailable`](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/dataavailable_event): timeslice delivery may be delayed and chunks may become much larger than expected.
