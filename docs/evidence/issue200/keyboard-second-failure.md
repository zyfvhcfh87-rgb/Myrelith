# Second keyboard run — closed-select Home

One production build of `47272362c6d65a1f0a75d4527642d0c8e3de6816` passed in
7.954643458 seconds. The large-bundle advisory is retained. One unchanged native
keyboard attempt then stopped: **0 complete cases passed, 1 failed, 3 unrun,
zero retries**. Started 2026-09-08T21:16:59.882Z; report duration 6.767091 seconds,
failed case 5.649 seconds. The first case was controls/status at 1280×720.

## Corrected focus result and next failure

The original safe-guide label containment predicate now passes. Native Tab
scrolls the outer Inspector to 2149; its visible region remains y=101→319.
The focused checkbox occupies y=298.171875→311.171875; the full label occupies
y=299.171875→314.171875. The original 1 px tolerance is unchanged. Actual Space
checks the control, preserves full project/history, and displays both dashed,
aria-hidden guides at the original 90% and 95% geometry assertions.

The next operation focuses the Explicit font fallback select, DOM identity 79,
with value `serif`. Its full control and label are visible. The last passive
keydown is a trusted `Home` targeting that same identity, without modifiers.
The following state retains `{ family: 'Missing Keyboard Face', fallbackFamily:
'serif' }`, the exact project wire and full history (past 6, future 1). Therefore
`oneEdit` fails at `keyboard.gate.ts:33`, called at line 212.

This establishes that Home on this closed select did not commit a selection.
It does not establish a product selection bug. No popup had been opened for
that operation. The later missing/fallback status checks, popup restore sequence,
dialogs and 720×800 cases did not execute. Their acceptance remains pending.

## Audited partial evidence and cleanup

All 17 state snapshots were audited offline: seven accepted edits, unchanged
selection/blur/Escape/layout setup, exact Undo project and past history, and the
safe-guide toggle. There were 175 real Tab steps and 263 trusted keydowns, no
drops or observer issues. All 26 session observations are healthy. Browser
warning/error/page-error and cleanup-error arrays are empty. Canonical project
leave, all three observer subscriptions/listeners and explicit page close completed.

All 16 distinct PNGs were viewed individually, including native auto outlines
and canvas move/resize focus indicators. Safe-guide checked state and visible
label are confirmed; fallback and failure images retain serif. Raw screenshots
also preserve surrounding workspace truncation, meter overlap and Program notice
overlay for supervisor disposition. No whole-workspace or pixel-exact native
focus-ring certification is claimed.

Runner completion had no timeout, forced native termination, incomplete stdout,
observer error or cleanup error. At 21:17:39.834386Z, fresh complete process tables
and lsof confirmed all 14 native/runner/outer/awake PIDs absent, both captured
build owners absent, private browsers absent and port 5200 clear. The supervisor
independently confirmed release at 21:18:22 UTC; its receipt is included. The
exclusive slot was released before this offline audit.

Build ownership is explicitly qualified: only npm launcher 41375 and Python
wrapper 41325 were captured. Every transient build descendant was not individually
observed. Raw `outerShellPid=24121` is the shared Codex tool process after shell
tail-exec, not an owned build process; it was neither owned nor signalled.
The same 1,791-file source guard verified before/after the build and native run,
and before evidence packaging, digest
`836c1c60085ad89ec2164c84773faf7ac49ccf9ccb21e0f99ebf4516eef0529e`.

## Preserved evidence

[Lossless failure bundle](keyboard-4727236-second-failure.tar.gz): 16,216,690 bytes,
71 members / 70 independently verified hashes. Archive SHA256:
`ff448397b664ebf28fdb30d1d4d9f0ea5adf6790505618464635a7e2b0c9084b`.
[Companion metadata](keyboard-4727236-second-failure.sha256.json) records identity.
All 44 original artifacts / 20,131,052 bytes match their manifest. All 34 reported
attachments exist; the trace's 325 ZIP members pass CRC validation. There are
31 PNG copies / 16 distinct images. The bundle includes build outputs and ownership
qualifications, outer records, both release receipts, offline audits and audit
script, original source manifest and 12 exact source snapshots. Originals remain
at `/private/tmp/issue200-keyboard-4727236-01` and sibling paths.

This checkpoint preserves evidence only. The supervisor authorized subsequent
source diagnosis and the smallest native keyboard sequence correction with exact
edit/history/fallback assertions retained. No retry or correction is included here.
