# Issue 199 — cancel the outgoing gesture before changing view

The corrected native run at
`7e7cfade097446c6f68219919fac838a8134f664` proved that selecting Curve during
a captured key drag changed the view but retained the Animation preview. The
original target was disconnected; the trusted capture-loss event did not target
that element. The complete failed attempt and explicit cleanup are committed in
`2f2d452c166a73660442813af8d84aef66db08f2`; see
`corrected-gestures-mode-failure.md` and `gestures-attempt2/`. Root independently
confirmed the transition and authorized this focused lifecycle correction.

## Owning lifecycle change

`AnimationWorkspace.tsx` owns the sheet/curve mode. It now calls the existing
Animation controller's cancel operation before changing that mode, while the
outgoing input element is still connected. Both mode buttons use the same
transition function. Selecting the current mode retains the previous behavior.

The sheet's pointer hook remains mounted with `AnimationGrid` when the grid
switches to Curve. Its prior index/zoom/unmount cleanup did not run for this
transition, and a removed glyph cannot be relied on to receive a later capture
event. Curve had unmount cleanup, but that released capture after removing the
handle. Ending the gesture at the mode owner handles both directions before
either input disappears. The canonical controller cancels the queued frame,
clears the admitted preview, and ends its pointer session. It does not commit a
document edit or replace history/clipboard.

Only the workspace and its composed component test changed. No new controller
policy, dependency edge, transport state, forced remount, schema change, fixture
change, or integration sync is introduced. The browser harness and its assertions
remain unchanged and pinned to the prior reviewed product pending a separate
source review and repin.

## Regression evidence

Six new component cases cover sheet→curve and each Bézier handle's curve→sheet
transition, with either a queued preview or an admitted preview plus another
queued update. They begin with a nonempty redo stack and Animation clipboard,
drive the real workspace buttons and composed controller, and verify:

- The destination mode is active and the old input is removed.
- Capture is released exactly once while that input is still connected.
- Preview and pending animation frames are cleared without a fabricated
  capture-loss event, and exact project/past/future/clipboard references survive.
- Returning to the original view and delivering later move/up input with the
  same pointer ID cannot revive or commit the previous gesture.

On the prior product, all six cases failed: sheet gestures never released capture,
while handle gestures released only after their target was removed. With the
owner transition fixed, all six pass. These component tests use controlled pointer
events and capture stubs; they do not replace the separately gated native rerun.

| Validation | Result | Evidence |
| --- | --- | --- |
| New regression cases on prior product | 6 failed, 21 unrelated tests skipped | `mode-cancellation/red.log` |
| Workspace, Animation controller and architecture tests after fix | 61 passed in 3 files | `mode-cancellation/focused.log` |
| Runner checks invoked by the focused test command | 17 passed | Same focused log |
| TypeScript and Vite production build | Passed, existing chunk-size advisory | `mode-cancellation/build.log` |
| Repository lint | Passed without warnings | `mode-cancellation/lint.log` |
| Source scope and hash verification | 2 source/test files changed; other 240 hashes unchanged | `mode-cancellation-source-hashes.json` |

Logs are normalized only for ANSI, carriage returns and trailing/EOF whitespace;
the raw task logs remain preserved. No wider-suite result is claimed.

## Review boundary

This is the product source checkpoint for review. The prior two native attempts
retain their actual failed outcomes. No new native run, editing/large segment,
performance measurement, export, full suite, push or PR has occurred. Browser
source repinning and the next exclusive gestures slot require separate review
and authorization. The already released 5199 slot was not reacquired for this fix.
