# Issue #203 — persistent render jobs, custom presets, and range exports

Status: approved by the user on 2026-09-10; implementation complete locally.
Prepared 2026-09-10 on `codex/issue203`, base `5b7a458` (PR #227).
Issue: https://github.com/zyfvhcfh87-rgb/Myrelith/issues/203

## Outcome and scope

Save named local export presets and queue immutable deliverables for the active
sequence: full duration, the existing In/Out selection, or an explicitly chosen
pair of timeline markers. Run one export at a time, with inspectable pending
jobs, cancellation, fresh retries, reordering and removal of inactive jobs.
Keep all processing local. Do not add parallel encodes, background services,
cloud rendering, resumable encoding, HDR, or new codec/container combinations.

This document is the approval gate required by `docs/PLAN.md`. Approval covers
the implementation and verification gates below. A failed correctness or
ownership gate blocks dependent work; changing the product boundaries below
requires another decision. Publication and merge remain separate actions.

## Current code and required changes

- `domain/exportProfile.ts` already strictly validates concrete export profiles.
  Dimensions, rational frame rate and sample rate belong to the sequence.
- `app/exportController.ts` already holds its single active owner through cleanup,
  drains playback/preview and retires speech before export allocations. Its
  ordinary entry captures the current document and media when Start is called.
  Queued jobs need an explicit immutable input path, shared with ordinary export.
- `pipeline/export.ts` currently renders `0..duration-1` and timestamps from zero.
  The visual adapter plans source requests across that duration. The sink calls
  `TimelineAudioMixer.writeFrame(nextFrame)` from zero, so range support must
  propagate through admission, decode planning, mixing, resampling and muxing.
- Prepared plugin attempts pin a snapshot but are one-shot runtime owners.
  Queues must retain intent and prepare fresh attempts at execution, never
  retain ready plugin tokens/workers for pending jobs.
- `transportStore` has exact half-open In/Out geometry. Markers are point
  annotations; they do not extend sequence duration or already define zones.
- Local preset adapters demonstrate bounded validation, read-only future
  envelopes and IndexedDB transaction-completion semantics.
- `ExportDialog` currently owns the export UI lifecycle and result URL.
  A queue needs app-owned lifetime independent of dialog mount, with lazy UI
  and serializable status. Update the corresponding architecture contract.

## Proposed product decisions

### Immutable jobs and reload recovery

Capture the committed whole-project snapshot, selected sequence id, portable
media descriptors, resolved concrete profile and exact range when enqueueing.
Later timeline edits, marker moves, preset edits and active-sequence switches
must not change this job. Temporary gesture previews are not captured.

Persist bounded job metadata only: identity, ordering, names, exact range,
profile, project/revision digest, source-descriptor digest, local-project binding,
attempt count and classified terminal/delivery facts. Do not store project
snapshots, media, encoded output, URLs, handles, plugin grants or runtime tokens
in the queue database. Project/recovery storage remains independently owned.

In-memory immutable project references are app-owned and separately bounded.
After reload, jobs remain inspectable but need an explicitly reopened matching
project revision and reconnected media before a fresh run. A digest is evidence
of matching data, not permission or proof of source bytes. Use existing source
matching and local-project provenance checks as separate conditions. If the
exact revision was never saved or recovered, explain that the job cannot be
reconstructed; creating a job from the current edit creates a new job identity.
Do not silently replace the old snapshot or automatically start after reload.

Pending jobs own no media Blobs, decoders or native file handles. On execution,
resolve and validate current connected originals against captured descriptors;
missing or changed media blocks explicitly. Project exit drains the active job,
retains metadata and releases in-memory snapshots. Existing export media and
plugin ownership rules remain binding.

Proposed initial limits: 100 total job records, 100 custom presets, 1 MiB for
each persisted library, 128-character display names, 512-character diagnostics,
and 64 MiB of additional retained project/descriptor snapshot data. Count
distinct shared snapshots once with conservative retained-data accounting;
validate before publishing. Include hashing/serialization scratch in the proof.
No silent eviction of pending jobs; report capacity and offer explicit removal.
These are data limits, not claims about total browser/native memory.

### Exact ranges

Use one pure `[startFrame, endFrame)` contract. Full means `[0, duration)`;
In/Out uses the existing complete timeline selection; marker range requires
explicit Start and End markers. Show both frames, exclusive End and frame count.
Reject empty, inverted, fractional, unsafe or out-of-duration ranges. Equal-frame
markers reject; do not infer an end from the next marker or extend the sequence.

Render absolute source/project frames while writing zero-based output timestamps.
Do not crop/rewrite the timeline: that would disturb transitions, nested frame
mapping, captions, animation and audio-effect state. Preserve exact rational
frame/sample arithmetic at fractional rates and at 96→48 kHz conversion.

The correctness reference is the selected window of the same full render.
Stateful audio processing may require sequential pre-roll from frame zero;
stream/discard that prefix with cancellation and progress rather than resetting
effects at In. Preserve resampler phase and exact output sample counts. Determine
the exact endpoint/sample-grid contract in Gate 1 and lock it with pure tests;
do not independently round a start offset and duration. Charge pre-roll against
work limits and disclose it in progress. Output-size estimates charge only output.
Plugin calls retain ascending requested absolute-frame order with fresh runtime
state per attempt; do not promise third-party plugin history equivalence beyond
the existing per-attempt contract.

### Queue ownership and delivery

Use one app controller and one state-machine authority for queue transitions.
Both immediate export and queued export use the same active pipeline guard.
Pending work never acquires encoder ownership; cancel retains ownership until
writer, decoder, mixer, plugin and admission cleanup has settled. Stop queue
advancement on an unresolved cleanup-integrity failure.

Use an origin-wide exclusive execution lock where supported, with atomic
versioned storage mutations to prevent two tabs consuming the same job. Fail
queue execution explicitly if safe ownership cannot be established; keep the
existing single-export capability available. Never steal a lock on a heartbeat
timeout: suspension is not proof the old owner is gone.

Suggested states: queued, needs-project, needs-media, needs-destination,
needs-review, preparing, rendering, cancelling, interrupted, cancelled, failed,
completed. Delivery facts are separate: no output, uncommitted/aborted,
cleanup uncertain, committed file, or download available in this session.
Persist an attempt-start record before resource acquisition; after reload an
unfinished attempt is interrupted with output unverified, never rendering.

For direct files, Choose destination is a fresh user-gesture action for the
next eligible job. Keep the existing one-shot capability; no queued overwrite
grants or automatic permission prompts. After a successful file job, the next
job may wait for its own destination. Retry is a new attempt from range start
with fresh destination and capability/plugin preflight.

For buffered downloads, retain at most one completed result under the existing
buffered-output limit. Wait for explicit Download and continue, or discard,
before producing another result. Never report a browser download as a verified
disk save. Reload loses its bytes and requires rerendering. Removing a job
never deletes a user output file. File errors distinguish failed writes,
confirmed abort and uncertain cleanup; never promise deletion of partial files.

### Browser lifecycle and presets

Queue admission is visible-page-only. Hidden state stops queue advancement and
labels any active export as background/unverified rather than asserting live
progress. Freeze/pagehide request interruption; restored pages reconcile and
drain the old attempt before Retry. Do not depend on an asynchronous write or
cleanup finishing during freeze/unload. No auto-resume after interruption.
Feature-detect lifecycle signals and disclose that unannounced device suspension
cannot be detected while JavaScript itself is suspended.

Custom presets save concrete validated profiles; resolve Auto before saving or
enqueueing. Copy settings into each job so changing/deleting a preset cannot
alter queued output. Keep sequence size/rate/sample rate authoritative. Support
save, rename, replace and delete, without new codec options or stored capability
claims. Corrupt records and unknown versions stay visible/read-only where
appropriate; never erase unrelated records on a failed mutation.

## Implementation and acceptance gates

1. **Pure contracts and range proof.** Add range/job/preset validation, bounded
   serialization, deterministic ordering/transitions, revision identity and
   recovery rules. Prove one-frame and end-exclusive bounds, rational video
   times, absolute audio boundaries, resampling phase and pre-roll behavior.
   Document the exact resource/work accounting before runtime changes.
2. **Shared ranged export.** Thread explicit immutable inputs/ranges through
   ordinary and prepared export, media scheduling, audio and sink paths. Prove
   nonzero-start A/V exports, animation/captions/transition/nested/multicam
   boundaries, audio-effect pre-roll, and cancellation during pre-roll and mux.
   Preserve full-export behavior and exact capability failures.
3. **Local libraries and recovery.** Implement app-owned IndexedDB repositories,
   serializable stores, transaction-safe revisions and snapshot retention.
   Test reload, unavailable/quota storage, future/corrupt records, stale writes,
   project/source mismatches and aggregate limits. A failed save cannot claim
   that a queued job or preset will survive reload.
4. **Serialized execution.** Wire the queue owner, fresh plugin attempts,
   cross-tab execution guard, direct-file/download waiting, deterministic retry,
   interruption and project teardown. Test two starts/tabs, cancellation at
   every awaited boundary, permission loss, blocked review, late callbacks and
   cleanup failure. Prove the next job never allocates before prior cleanup.
5. **Accessible product UI.** Extend lazy export UI with custom preset actions,
   Full/In-Out/marker selection, immutable job summaries, order controls and
   actionable statuses. Closing the dialog preserves queue ownership. Verify
   keyboard/focus, compact layouts, reload and project replacement through UI.
6. **Final acceptance.** Run full Vitest plus runner checks, production
   build/typecheck, lint and focused muted headless Chromium flows. Reopen
   rendered files and check exact frame counts, first/last content, A/V timing
   and cleanup. Exercise actual browser freeze/reload where available and
   distinguish controlled file-adapter fault tests from native-picker coverage.
   Use the in-app browser for visual inspection. Record broader browser results
   separately; baseline-reproduce failures before calling them unrelated.

Update ARCHITECTURE/HANDOFF/PLAN with the final ownership, recovery contract and
measured acceptance. Commit accepted implementation with the repository's Aryel
author/message-file/Co-authored-by convention. No product implementation
started during the planning gate itself.

## Browser references checked during planning

- [Chrome Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api):
  hidden differs from frozen; discard can occur without an event, and frozen
  task queues cannot reliably finish asynchronous work.
- [Save picker activation](https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker):
  secure context and transient user activation constrain direct-file selection.

## Planning validation

Passed 127 existing tests across six export-profile, work-budget, marker,
controller, lifecycle and file-target suites, plus all 17 repository runner
checks. Command: `npm test -- src/domain/exportProfile.test.ts
src/domain/exportWorkBudget.test.ts src/domain/timelineMarkers.test.ts
src/app/exportController.test.ts src/app/exportLifecycle.test.ts
src/pipeline/export-file-target.test.ts`.

That command was planning validation rather than implementation acceptance;
the implementation gates are recorded below. GitHub CLI access failed in the
restricted shell; the connected GitHub issue tool successfully retrieved the
open issue and its complete acceptance criteria.

## Implementation acceptance (2026-09-10)

The approved scope is implemented locally. The final ownership contract is
recorded in [ARCHITECTURE.md](../ARCHITECTURE.md), with the session map and
qualification limits in [HANDOFF.md](HANDOFF.md).

- 86 focused Issue #203 unit/controller/pipeline/storage cases pass.
- Two muted headless Chromium flows pass: exact non-zero range picture order
  with 96 kHz source audio, plus presets, marker/In-Out queueing, download
  gating, recovery and rerun after reload.
- `npm run build`, `npm run lint`, and `git diff --check` pass.
- Full Vitest is 5,252/5,253; the single plugin startup `safe-mode` failure is
  reproduced independently in the existing baseline suite. Browser AAC
  duration metadata exposes codec packet padding for very short outputs, so
  Chromium acceptance checks no truncation while focused sink tests assert the
  exact sample schedule.

No GitHub PR, merge, or issue closure has been performed.
