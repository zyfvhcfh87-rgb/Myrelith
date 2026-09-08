# Issue 199 — capture-event harness correction for review

The first gestures segment stopped at the capture-loss assertion on
`379634405c15b1e553c1e36996aac6ac83e61d39`, product
`b33b7531027979b8886f5db979d57cd96b96175d`. This checkpoint preserves that
failed attempt and changes the harness event sequence and diagnostics. **Product
source is unchanged. The corrected native flow has not run and is not a passing
capture-loss result.** Review and a new exclusive slot are required.

## Original outcome and release

Original artifact directory:
`/private/tmp/issue199-continuation/2026-09-08T16-36-07.724Z-gestures/`.
The granted run lasted from 16:36:07.724Z to 16:36:18.843Z on 2026-09-08,
with a fresh private profile, muted headless Chromium 151.0.7922.34 / SwiftShader,
and command-scoped `caffeinate -is`.

Six checkpoints passed: launcher identity; canonical mixed fixture with native
clip selection; native key movement from 40 to 49 with preview/no history, one
commit and undo/redo/undo; native Bézier handle 1 and handle 2 edits with preview,
one commit and exact undo; and key Escape cancellation with unchanged document,
history and clipboard. The next case, `native key cancellation: capture`, stopped
at observations line 229 because preview was still true. Failure state retained
past 0 / future 1, focused local key 40 and preview owner `animation-gesture`.
Console/page problems were empty. No later case or segment ran.

Runner cleanup released the slot at 16:36:18.809Z: context closed, owned preview
exited 143, no fallback signals, no remaining owned processes or 5199 listener,
and final source/console checks passed. Independent checks found all observed
PIDs 81571/81573/81574/81575/81576 absent, port clear and all 22 checkpoint plus
242 source hashes unchanged. The runner PID 81510 and scoped caffeinate PID
81521 were also verified absent. Root independently confirmed cleanup and
reclaimed the slot. No persistent power/display settings changed.

The original result, artifact manifest, independent checks and sleep assessment
are copied exactly under `gestures-attempt1/`. Text logs/DOM copies remove only
ANSI, carriage returns, trailing whitespace and excess EOF whitespace. All seven
original screenshots, seven original DOM texts, trace, complete result, source/
build/browser/process provenance and raw text remain in the original directory;
`artifacts.json` retains their raw byte lengths and hashes. The profile remains
preserved without a whole-profile hash claim. The original result is not rewritten
to add event data that was never captured.

Read-only `pmset` inspection found 16 run-interval lines containing sleep-related
text, all classified as power Assertions. No actual Sleep/Wake/DarkWake/
MaintenanceSleep transition was found during this 11.119-second run. This is
separate from the earlier parent test run affected by host sleep.

## Diagnosis and narrow correction

The original harness called `releasePointerCapture`, waited two animation frames,
then asserted cancellation. It did not establish that `lostpointercapture` was
delivered. Its event ring was only serialized at the successful end of gestures,
so the original failure result cannot settle that question.

[Pointer Events 3 section 9.3](https://www.w3.org/TR/pointerevents3/#releasing-pointer-capture)
clears pending capture; [section 4.1.3.2](https://www.w3.org/TR/pointerevents3/#process-pending-pointer-capture)
processes pending capture when firing subsequent pointer events or implicitly
releasing capture. This supports an event-delivery explanation for the failed
harness assertion. It does not prove the behavior of the unobserved lost event
in this specific attempt.

Product source already wires key glyph `onLostPointerCapture` to `drag.cancel`
in `AnimationGrid.tsx`, which reaches the session cancel path through
`useAnimationPointer.ts`. Bézier handles call their gesture cancel handler in
`AnimationCurve.tsx`. The canonical `animationEditingController.ts` cancel path
ends the session, cancels its pending frame, clears preview and ends capture.
No handler is replaced or bypassed here.

The corrected harness retains the exact existing native drag and then:

1. Records the current pointer/gesture, connected captured element, actual trusted
   `gotpointercapture`, and a monotonic event cursor before requesting release.
2. Calls the actual capture-release API and records the pending-capture result.
3. Moves the native mouse one additional pixel with its button still held, so a
   real pointer event can process the pending capture change.
4. Requires trusted loss on that exact element and pointer/gesture, followed by a
   trusted held-button move, with no pointer-up event and capture no longer held.
5. Runs the original preview-false assertion and exact project/history/clipboard
   identity checks before mouseup, then preserves the existing post-mouseup checks.

Monotonic gesture and event IDs distinguish prior events even when Chromium reuses
the mouse pointer ID. The passive event ring stays bounded at 256 records and
includes same-target identity, trust, buttons and coordinates. Failure capture
now serializes that ring and current pointer/capture state; successful gestures
retain it as before. All other gesture actions, fixtures, product source, hard
bounds, stop policy and cleanup implementation remain unchanged.

## Source qualification and remaining gate

Both changed modules pass `node --check`; repository lint and diff checks pass.
All 242 product/test/configuration hashes match b33b753, with an empty product/
configuration diff. The original trace archive and artifact hashes were checked
without opening a browser. `capture-event-correction-checks.json` and
`capture-event-correction-lint.log` record these checks; the checkpoint manifest
pins the revised harness/protocol and retained original evidence.

No production build, focused suite or process suite was repeated for these
JavaScript harness/diagnostic changes. The original granted attempt's successful
production build and prior source tests remain exact-product evidence, not native
validation of this correction. No synthetic pointer dispatch, substituted mouseup,
longer timeout, relaxed assertion, product edit, native rerun, editing/large run,
full suite or export was introduced. The first failed attempt remains failed;
the corrected source requires review before any rerun.
