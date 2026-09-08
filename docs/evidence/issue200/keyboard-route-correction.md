# Remaining keyboard route

The unchanged 16e3688 run completed the wide controls case with native font
selection explicitly UNVERIFIED. Motion Direction typeahead succeeded; motion and
save-template forward/reverse wrapping, preview, Escape/Cancel, opener restoration
and unchanged project/history checks all progressed successfully. The following
backward seek to Title templates exceeded its existing 128-Tab bound. Its ledger
contains 128 distinct controls: Inspector order 78 down to Commands order 0,
BODY, then the end of the document backward through timeline/mixer controls to
order 149. This is a long route, without a repeating focus trap. The transport
toolbar follows the Inspector in document order, so this one seek now uses
ordinary forward Tab. All existing visibility and focus assertions remain.

Raw failure: `/private/tmp/issue200-keyboard-16e3688-01`. Result: one completed
case, one failed, two unrun, zero retries, 19.041226 seconds. No browser or runner
cleanup/observer errors. All 16 captured processes and port 5200 were released at
2026-09-08T22:02:15.133521Z and independently confirmed by the parent.

The parent authorized preserving completed wide controls and targeting the three
remaining cases. Set `ISSUE200_KEYBOARD_REMAINING=1` with the existing runner to
exclude only `1280x720 keyboard title controls and status`; unset it for the
original four-case suite. The wide dialog and both narrow cases retain their
original assertions, budgets, zero retries and first-failure stop. Product source
is frozen at 16e3688; no new production fix or additional matrix is involved.

Diagnostic TypeScript, focused lint, diff checks and discovery of exactly the
three intended remaining cases passed. No browser ran during source correction.
