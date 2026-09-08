# G3 authoring: source review and bounded observable protocol

G2 remains accepted with the qualifications recorded in g2-observable-results.md.
The exact approved integration e6a64a7898111a2c230c57eee890832a74fb88b3 was merged
cleanly at 05b370a88d76791a9481da320fc2e73205968f91. This gate preserves schema24,
the caption owner correction, all four existing preview owners, and the accepted
shared animation APIs. It adds a fifth named title-authoring preview owner.

G3 implementation is authorized; this document requests review of source and the
following six-flow observable protocol. The first run at1fff897 failed flow1; the
fixture/selector-corrected cd24868 run passed flows1–2 and failed flow3. Both runs
and complete first-failure evidence remain preserved in g3-first-authoring-failure.md
and g3-motion-strictmode-failure.md. The motion effect-lifecycle correction has
**not run in a browser** and requires fresh source review and an exclusive grant. No full/performance gate has run. #199's final shared
animation workspace has not been integrated. Its property/dope-sheet wiring is
explicitly pending the supervisor's accepted sync; no second key editor is added.

The source implements accessible ordered element selection, static numeric/style
editing, multi-edit, add/duplicate/delete/reorder, explicit compact Upgrade,
persisted font fallback, transformed monitor movement/resize with keyboard
alternatives, and ephemeral 90% title/95% action guides. Animated gestures use
planSetAnimationKey; roll/crawl uses planAnimationInsertions and the canonical
element resolver. Reapply lists every owned replacement lane and refuses future
movement versions. Both offscreen endpoints use transformed crop bounds, including
rotation, anchor, flips and scale. Templates retain editable title lanes, allocate
fresh clip/element/orphan identities, and disclose uniform centered fitting and
unchanged frame-number timing. Local IDB writes complete only with their owning
transaction; errors/unknown records/future envelopes are surfaced and preserved.
Only bounded serializable summaries enter the template store. Supported lookup and
delete bind to the exact record/index accepted after whole-library duplicate ID/name
validation; unavailable same-ID and duplicate-name siblings survive in either order.

A title session pins project identity/generation, sequence, clip and element
selection, playhead, reset revision and media envelope. Cancellation releases its
subscriptions and captured project. Replacement releases the old draft without
reacquiring preview priority. All five named previews, including hidden owners, are projected by the shared app
admission facade and actual store commit boundary. Candidate and sampled-preview retention are checked
against current, both history branches and clipboards; commits repeat the portable
file and store admission checks. A sampled motion preview resolves the title at
an explicit local integer frame without moving the playhead or authoring keys.

## Proposed six-flow browser run

One muted headless Chromium worker, port5200, no retries, maxFailures1, each test
at most60seconds. Exclusive supervisor slot required before launch. Source is
frozen: a clean checkpoint manifest is recorded with verify-g3-source.mjs and
verified immediately before/after. No source edits, peer sync, package change or
parallel browser/performance workload during the run. Historical G2 baseline and
proof archives/guards remain untouched; they are not misapplied to this new tree.

1. Real compact Upgrade, content, added shape, multi-opacity, stable-ID reorder,
   and command-palette Undo/Redo. Check exact history increments and portable wire
   state; require a real recovery write to complete for the active document/session.
2. Actual Program pointer movement and Escape cancellation; safe-guide visibility
   with identical project serialization and history. Retain guide/handle screenshot.
   At an interpolated frame, trusted no-motion native clicks on both Move and
   Resize preserve project serialization and the complete past/future history.
   For each handle acquire actual pointer capture, request its release, then send
   a native move with that same pointer still held before mouseup. Require the
   trusted lostpointercapture event, the post-release trusted held move, preview
   cancellation and unchanged project/history after the later native mouseup.
   Attach each handle's event evidence even on failure; a release request alone
   does not satisfy the assertion. Keep all existing flow assertions.
3. Roll/crawl dialog Preview/Cancel, two-key Apply, explicit replacement listing,
   confirmation and Reapply with edited range. Retain complete review screenshot.
4. Unavailable literal font fixture, real generic fallback control, preview status,
   actual serialize/parse/reopen and retained original family. Retain screenshot.
5. Real origin-local IndexedDB save, reread/select/use and delete via UI. Check one
   inserted independent copy, remapped IDs and unchanged project on library delete.
6. 720×800 dialog reachability and stale review rejection. This qualifies the title
   dialog only; shared workspace clipping observed in G2 is not relabeled fixed.

After entering through the real new-project UI, fixture construction produces a
portable file. Every initial/replacement/reopen fixture passes through the real
leaveActiveProject → openProjectFile → activateResumedProject lifecycle. Each
transition asserts successful status, exact portable bytes, empty history and
a healthy active session, with attached evidence. There is no direct setProject
in the browser protocol. This includes the interpolated gesture fixture, the
unavailable-font fixture and the actual fallback-file reopen. Feature mutations
remain actual UI actions; imports are for fixture construction, canonical portable
installation, positioning, stale-context injection and read-only evidence.
Wrapped textarea/select fields use exact accessible role/name selectors; original
assertions are retained, and no warning/status is silenced. The capture-loss probe additionally
requests releasePointerCapture on the actually captured trusted pointer; it does
not synthesize pointer events. Trusted event observations and the next native
held move establish the actual loss. This is an authoring gate, not another
2772-comparison rendering parity run or an encoded-export/performance claim.

The observer records warnings, console errors, page errors, URL/title/body identity,
Vite overlays and viewport/bounds through the final screenshot of every test.
It also records project/save/recovery phase/error state with each screenshot and
requires healthy state on completed flows, including a real recovery write in
flow1. A UI recovery failure cannot be hidden by otherwise empty console arrays.
Any warning/error fails this G3 authoring run; no warning is filtered or suppressed.
The G2 Canvas2D readback advisories remain historical and qualified, and no
production canvas setting is changed to hide them. Failure preserves trace,
screenshots and full observations; no weakening or silent retry is allowed.

run-g3-browser.py owns the launcher/Vite/Chromium descendants by PID, start time
and command identity, preserves stdout and process ancestry, and records observer
exceptions. Its 600-second deadline is checked by a nonblocking stdout reader
even when a descendant retains the pipe or keeps writing. Output bytes go
directly to the artifact log without potentially blocking console forwarding.
EOF followed by a still-running launcher is also bounded by the same deadline.
Timeout is an explicit failure and records whether stdout is complete. Teardown
refreshes PID/start/command identities before TERM, waits two seconds, refreshes
again before KILL, and records required escalation, survivors and query/signal
errors. Queries, observer shutdown and child waits are individually bounded; no
unverified process-group/name kill is used. Source-only injected-clock/process
regressions cover a held-open pipe, continuous output, TERM resistance, PID reuse,
new descendants and cleanup failure. These tests do not execute native processes.
After the run,
record fresh complete native process/listener evidence, visually inspect each
requested screenshot, audit all observations and assertions, verify source again,
and explicitly release port5200/native/browser slot to the supervisor. Archive
results with SHA256/member hashes before any subsequent sync. G4 full-suite and
performance/final integration acceptance remain separate.
